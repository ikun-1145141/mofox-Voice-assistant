"""以公开 chat_core Service 驱动 voice_web 私聊，并发出可验证的回合终态。"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncGenerator, Protocol

from src.app.plugin_system.api import service_api, stream_api
from src.app.plugin_system.api.log_api import get_logger
from src.app.plugin_system.base import (
    BaseChatter,
    Failure,
    Stop,
    Success,
    Wait,
    WaitResumeEvent,
)
from src.app.plugin_system.types import ChatType
from src.kernel.concurrency import get_task_manager

from .runtime import Turn, current_turn
from .hooks import scope_default_session

logger = get_logger("voice_web_assistant")
CHAT_CORE = "default_chatter:service:chat_core"


class SessionLike(Protocol):
    """公开 Service 返回对象需要提供的最小形状。"""

    def execute(self) -> AsyncGenerator[Any, WaitResumeEvent | None]:
        """产出框架标准结果。"""
        ...


class ChatCoreLike(Protocol):
    """不 import 其他插件源码的 Service 结构约定。"""

    def create_session(self, *, stream_id: str) -> SessionLike:
        """使用 Service 所属 Neo 插件的真实配置创建会话。"""
        ...


def is_round_end(result: Any) -> bool:
    """只有源码明确携带 actor_round 的 Wait/Stop 才是正常回合结束。"""
    return (
        isinstance(result, (Wait, Stop))
        and isinstance(result.step_data, dict)
        and result.step_data.get("step_scope") == "actor_round"
    )


class VoiceWebChatter(BaseChatter):
    """保留 Neo 默认会话逻辑，同时让每个网页请求有独立终态。"""

    name = "voice_web_chatter"
    description = "通过 Neo chat_core 驱动网页语音私聊"
    associated_platforms = ["voice_web"]
    chat_type = ChatType.PRIVATE
    allow_message_buffer = False
    stream_tick_interval = 0.2
    dependencies = [CHAT_CORE]

    async def _step(
        self,
        runner: AsyncGenerator[Any, Any],
        turn: Turn,
        resume: WaitResumeEvent | None,
    ) -> Any:
        """将固定回合上下文绑定到本次模型、工具及发送调用链。"""
        token = current_turn.set(turn)
        try:
            return await runner.asend(resume)
        finally:
            current_turn.reset(token)

    async def _cleanup_unread(self, turn: Turn) -> None:
        """仅移走本次请求的未读消息，避免取消前的输入污染后续回合。"""
        _, messages = await self.fetch_unreads()
        await self.flush_unreads(
            [message for message in messages if message.message_id == turn.message_id]
        )

    async def _cleanup_retired_unreads(self) -> None:
        """取消发生在首次 Chatter 调度之前时，也移走其已入核心的输入。"""
        _, messages = await self.fetch_unreads()
        retired = []
        for message in messages:
            owner = self.plugin.runtime.messages.get(message.message_id)
            if (
                owner is not None
                and owner.stream_id == self.stream_id
                and (owner.terminal or owner.cancelled)
            ):
                retired.append(message)
        await self.flush_unreads(retired)

    async def _run_turn(self, turn: Turn) -> None:
        """驱动一个 Neo 回合；await 的工具全部返回后才允许正常完成。"""
        runner = None
        try:
            service = service_api.get_service(CHAT_CORE)
            if service is None or not callable(
                getattr(service, "create_session", None)
            ):
                await self.plugin.runtime.finish(turn, "Neo chat_core Service 未加载")
                return
            # 不传自己的 plugin：保留 Neo 默认 chatter 的配置、人格与 prompt。
            session = service.create_session(stream_id=self.stream_id)
            scope_default_session(session, turn)
            runner = session.execute()
            async with asyncio.timeout(self.plugin.config.bridge.turn_timeout_seconds):
                while not turn.cancelled:
                    info = get_task_manager().create_task(
                        self._step(runner, turn, None),
                        name=f"voice_turn_{turn.turn_id[:16]}",
                        daemon=False,
                    )
                    turn.stage_task = info
                    result = await info.task
                    turn.stage_task = None
                    if isinstance(result, Failure):
                        await self.plugin.runtime.finish(turn, result.error)
                        return
                    if is_round_end(result):
                        await self.plugin.runtime.finish(turn)
                        return
                    # 无元数据的 Wait 只是空闲/门控，不能当成完成或用静默超时冒充完成。
                    if isinstance(result, Wait):
                        await self.plugin.runtime.finish(
                            turn, "Neo 会话等待但没有明确的 actor_round 结束标记"
                        )
                        return
                    if isinstance(result, Stop):
                        await self.plugin.runtime.finish(
                            turn, "Neo 会话停止但没有完成当前回合"
                        )
                        return
                    if isinstance(result, Success):
                        await self.plugin.runtime.finish(
                            turn, "Neo chat_core 返回未受支持的 Success；需核查核心版本"
                        )
                        return
                await self.plugin.runtime.finish(turn)
        except StopAsyncIteration:
            await self.plugin.runtime.finish(
                turn, "Neo 会话提前结束，未给出回合完成证据"
            )
        except asyncio.CancelledError:
            if not turn.cancelled:
                turn.cancelled = True
                raise
            await self.plugin.runtime.finish(turn)
        except TimeoutError:
            await self.plugin.runtime.finish(turn, "Neo 模型或工具回合超时")
        except Exception as error:
            logger.exception("网页语音回合执行失败")
            await self.plugin.runtime.finish(turn, f"Neo 回合执行失败：{error}")
        finally:
            turn.stage_task = None
            if runner is not None:
                await runner.aclose()
            await self._cleanup_unread(turn)

    async def execute(
        self,
    ) -> AsyncGenerator[Wait | Success | Failure | Stop, WaitResumeEvent | None]:
        """只处理本平台提交，完成后等待新请求，不擅自续接定时恢复。"""
        stream = await stream_api.activate_stream(self.stream_id)
        if (
            stream is None
            or stream.platform != "voice_web"
            or str(stream.chat_type) != "private"
        ):
            yield Failure("网页语音私聊流不可用")
            return
        runtime = self.plugin.runtime
        while True:
            await self._cleanup_retired_unreads()
            turn = runtime.claim(self.stream_id)
            if turn is None:
                yield Wait()
                continue
            await self._run_turn(turn)
            yield Wait(time=0)
