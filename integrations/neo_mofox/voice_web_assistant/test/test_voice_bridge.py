"""不启动真实 bot、不调用外部模型的转换、归属、取消与回合终态测试。"""

from __future__ import annotations

import asyncio
import json
import inspect
import unittest
from pathlib import Path
from contextlib import ExitStack
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch
from websockets.legacy.server import serve

from src.app.plugin_system.base import BasePlugin, Failure, Stop, Wait
from src.app.plugin_system.types import ChatStream, ToolRegistry
from src.core.components.loader import get_plugin_class, load_manifest
from src.core.managers.chatter_manager import ChatterManager
from src.core.managers.plugin_manager import PluginManager
from src.core.transport.message_receive.converter import MessageConverter
from src.kernel.concurrency import get_task_manager

from voice_web_assistant.adapter import VoiceWebAdapter
from voice_web_assistant.chatter import VoiceWebChatter, is_round_end
from voice_web_assistant.config import VoiceWebConfig
from voice_web_assistant.hooks import (
    ScopedUnreadAdapter,
    ScopedPromptAdapter,
    ScopedRespondAdapter,
)
from voice_web_assistant.plugin import VoiceWebAssistantPlugin
from voice_web_assistant.runtime import (
    Turn,
    VoiceRuntime,
    current_turn,
    outgoing_text,
    validate_submit,
)


def submission(suffix: str = "a", session: str | None = None) -> dict[str, Any]:
    """生成符合共享 TypeScript 协议的独立私聊请求。"""
    session = session or f"session-{suffix}"
    return {
        "type": "chat.submit",
        "version": 1,
        "sessionId": session,
        "userId": f"voice:{session}",
        "turnId": f"turn-{suffix}",
        "messageId": f"input-{suffix}",
        "text": "你好",
        "nickname": "网页用户",
    }


def envelope(
    turn: Turn, message_id: str = "reply-1", user_id: str | None = None
) -> dict[str, Any]:
    """使用 Neo MessageConverter 的真实 user_info 目标字段。"""
    return {
        "direction": "outgoing",
        "message_info": {
            "platform": "voice_web",
            "message_id": message_id,
            "user_info": {"user_id": user_id or turn.user_id},
        },
        "message_segment": [{"type": "text", "data": "你好呀"}],
    }


class FakeSink:
    """记录传入核心的消息，不启动接收管线。"""

    def __init__(self) -> None:
        """初始化消息记录。"""
        self.sent: list[Any] = []

    async def send(self, value: Any) -> None:
        """接收一个信封。"""
        self.sent.append(value)


class FakeSocket:
    """记录发给 Node 的协议 JSON。"""

    closed = False

    def __init__(self) -> None:
        """初始化出站事件列表。"""
        self.sent: list[dict[str, Any]] = []

    async def send(self, value: str) -> None:
        """解析一条 JSON，模拟可用 WebSocket。"""
        self.sent.append(json.loads(value))


class VoiceBridgeTests(unittest.IsolatedAsyncioTestCase):
    """基于真实 Neo 基类与 TaskManager 验证桥接行为。"""

    async def asyncSetUp(self) -> None:
        """建立隔离的插件、适配器和假 WebSocket。"""
        config = VoiceWebConfig()
        config.bridge.token = "f" * 64
        config.bridge.bot_name = "测试 Bot"
        self.plugin = VoiceWebAssistantPlugin(config)
        self.sink = FakeSink()
        self.adapter = VoiceWebAdapter(self.sink, self.plugin)
        self.socket = FakeSocket()
        self.adapter._ws = self.socket
        await self.adapter.on_platform_message({"type": "bridge.hello", "version": 1})

    async def test_incoming_uses_real_converter_and_private_stream_id(self) -> None:
        """真实转换器识别方向、文本、元信息和标准私聊流 ID。"""
        raw = submission()
        result = await self.adapter.from_platform_message(raw)
        message = await MessageConverter().envelope_to_message(result)
        self.assertEqual(result["direction"], "incoming")
        self.assertEqual(message.sender_id, raw["userId"])
        self.assertEqual(message.processed_plain_text, "你好")
        self.assertEqual(message.platform, "voice_web")
        self.assertEqual(message.chat_type, "private")
        self.assertEqual(message.extra["voice_turn_id"], raw["turnId"])
        self.assertEqual(
            message.stream_id,
            ChatStream.generate_stream_id("voice_web", user_id=raw["userId"]),
        )

    async def test_handshake_and_duplicate_submission_are_idempotent(self) -> None:
        """协议能力声明包含真实终态，重复输入仅入核心一次。"""
        self.assertEqual(
            self.socket.sent[0]["capabilities"], ["text", "turn-completion"]
        )
        await self.adapter.on_platform_message(submission())
        await self.adapter.on_platform_message(submission())
        self.assertEqual(len(self.sink.sent), 1)
        changed = submission()
        changed["text"] = "不同内容"
        with self.assertRaises(ValueError):
            await self.adapter.on_platform_message(changed)

    async def test_authentication_and_handshake_are_required(self) -> None:
        """空 token 与未握手输入被拒绝。"""
        config = VoiceWebConfig()
        with self.assertRaises(ValueError):
            VoiceWebAdapter(FakeSink(), VoiceWebAssistantPlugin(config))
        self.adapter._ready = False
        with self.assertRaises(ValueError):
            await self.adapter.on_platform_message(submission())
        with self.assertRaises(ValueError):
            await self.adapter.on_platform_message(
                {"type": "bridge.hello", "version": 2}
            )

    async def test_outgoing_requires_fixed_turn_and_real_target(self) -> None:
        """同平台的其他用户、群聊、无归属消息都不能串到网页会话。"""
        turn, _ = self.plugin.runtime.accept(submission(), "stream")
        self.assertIsNone(outgoing_text(envelope(turn), None))
        self.assertIsNone(outgoing_text(envelope(turn, user_id="someone-else"), turn))
        group = envelope(turn)
        group["message_info"]["group_info"] = {"group_id": "group"}
        self.assertIsNone(outgoing_text(group, turn))
        token = current_turn.set(turn)
        try:
            result = await self.adapter._send_platform_message(envelope(turn))
        finally:
            current_turn.reset(token)
        self.assertTrue(result.success)
        self.assertEqual(self.socket.sent[-1]["turnId"], turn.turn_id)
        self.assertEqual(self.socket.sent[-1]["sessionId"], turn.session_id)
        self.assertEqual(turn.sent_count, 1)

    async def test_cancel_ownership_and_late_reply_cannot_attach_to_new_turn(
        self,
    ) -> None:
        """旧 Turn 取消后仍持有旧身份，无法成为后续会话的回复。"""
        await self.adapter.on_platform_message(submission())
        old = self.plugin.runtime.turns["turn-a"]
        await self.adapter.on_platform_message(
            {"type": "chat.cancel", "sessionId": "wrong", "turnId": old.turn_id}
        )
        self.assertFalse(old.cancelled)
        await self.adapter.on_platform_message(
            {"type": "chat.cancel", "sessionId": old.session_id, "turnId": old.turn_id}
        )
        self.assertTrue(old.terminal)
        self.assertEqual(self.socket.sent[-1]["type"], "turn.failed")
        await self.adapter.on_platform_message(submission("b", old.session_id))
        token = current_turn.set(old)
        try:
            result = await self.adapter._send_platform_message(envelope(old, "late"))
        finally:
            current_turn.reset(token)
        self.assertFalse(result.success)
        self.assertFalse(
            any(event.get("messageId") == "late" for event in self.socket.sent)
        )

    async def test_session_identity_and_concurrency_are_enforced(self) -> None:
        """一个 Neo 私聊用户只能归一个网页会话，未结束回合不能叠加。"""
        runtime = VoiceRuntime()
        runtime.accept(submission(), "s1")
        with self.assertRaises(ValueError):
            runtime.accept(submission("b", "session-a"), "s1")
        other = submission("b")
        other["userId"] = "voice:session-a"
        with self.assertRaises(ValueError):
            runtime.accept(other, "s1")
        swapped = submission("b", "session-a")
        swapped["userId"] = "other-user"
        with self.assertRaises(ValueError):
            runtime.accept(swapped, "s1")

    async def test_terminal_exactly_once_and_zero_reply_is_failure(self) -> None:
        """没有成功送达文本的回合不能报告成功，终态只能发一次。"""
        turn, _ = self.plugin.runtime.accept(submission(), "s")
        await self.plugin.runtime.finish(turn)
        await self.plugin.runtime.finish(turn)
        terminal = [
            event for event in self.socket.sent if event["type"].startswith("turn.")
        ]
        self.assertEqual(len(terminal), 1)
        self.assertEqual(terminal[0]["type"], "turn.failed")

    async def test_cancel_before_chatter_scheduling_cleans_only_retired_input(
        self,
    ) -> None:
        """首次调度前取消的已入站消息不能永久留作未读或清掉新的输入。"""
        turn, _ = self.plugin.runtime.accept(submission(), "s")
        turn.cancelled = True
        turn.terminal = True
        newer, _ = self.plugin.runtime.accept(submission("b", turn.session_id), "s")
        old_message = SimpleNamespace(message_id=turn.message_id)
        new_message = SimpleNamespace(message_id=newer.message_id)
        chatter = VoiceWebChatter("s", self.plugin)
        chatter.fetch_unreads = AsyncMock(return_value=("", [old_message, new_message]))
        chatter.flush_unreads = AsyncMock(return_value=1)
        await chatter._cleanup_retired_unreads()
        chatter.flush_unreads.assert_awaited_once_with([old_message])

    async def test_scoped_adapters_only_read_owned_input_and_preserve_prompt(
        self,
    ) -> None:
        """公开会话适配器只读自己的输入，原人格与额外约束继续由原模板处理。"""
        turn, _ = self.plugin.runtime.accept(submission(), "s")
        mine = SimpleNamespace(message_id=turn.message_id)
        other = SimpleNamespace(message_id="other")
        original = SimpleNamespace(
            fetch_unreads=AsyncMock(return_value=("all", [mine, other])),
            format_message_line=lambda message, time_format: message.message_id,
        )
        unread = ScopedUnreadAdapter(original, turn)
        text, messages = await unread.fetch_unreads()
        self.assertEqual(messages, [mine])
        self.assertEqual(text, turn.message_id)
        prompt_original = SimpleNamespace(
            _build_user_prompt=AsyncMock(return_value="原有模板结果"),
            _build_system_prompt=AsyncMock(return_value="原人格"),
        )
        prompt = ScopedPromptAdapter(prompt_original)
        self.assertEqual(
            await prompt._build_user_prompt(None, "历史", "未读", "已有约束"),
            "原有模板结果",
        )
        self.assertTrue(
            prompt_original._build_user_prompt.call_args.args[-1].startswith("已有约束")
        )
        self.assertEqual(await prompt._build_system_prompt(None), "原人格")
        self.assertTrue(
            (await ScopedRespondAdapter(turn).sub_agent("", [], None))["should_respond"]
        )
        turn.cancelled = True
        self.assertEqual((await unread.fetch_unreads())[1], [])
        self.assertFalse(
            (await ScopedRespondAdapter(turn).sub_agent("", [], None))["should_respond"]
        )

    async def _run_fake_session(
        self, factory: Any, turn: Turn, timeout: float = 2.0
    ) -> None:
        """用真实包装 Chatter/TaskManager 驱动一个可控公开 Service。"""
        self.plugin.config.bridge.turn_timeout_seconds = timeout
        chatter = VoiceWebChatter(turn.stream_id, self.plugin)
        chatter._cleanup_unread = AsyncMock()
        session = SimpleNamespace(
            execute=factory,
            adapters=SimpleNamespace(
                unread_adapter=SimpleNamespace(),
                prompt_adapter=SimpleNamespace(),
                sub_agent_adapter=SimpleNamespace(),
            ),
        )
        service = SimpleNamespace(create_session=lambda **kwargs: session)
        with patch(
            "voice_web_assistant.chatter.service_api.get_service", return_value=service
        ) as lookup:
            await chatter._run_turn(turn)
        lookup.assert_called_once_with("default_chatter:service:chat_core")
        chatter._cleanup_unread.assert_awaited_once_with(turn)

    async def test_awaited_tools_finish_before_completed_and_background_reply_is_dropped(
        self,
    ) -> None:
        """完整工具回合结束后才 completed；继承旧上下文的迟到后台回复被丢弃。"""
        turn, _ = self.plugin.runtime.accept(submission(), "s")
        release_late = asyncio.Event()
        tool_done = False
        late_info: Any = None

        async def late_output() -> None:
            """模拟工具在 TaskManager 启动的后台迟到发送。"""
            await release_late.wait()
            await self.adapter._send_platform_message(envelope(turn, "late-tool"))

        async def runner() -> Any:
            """模拟 Neo 等待工具、发送文本并产出真实 actor_round。"""
            nonlocal tool_done, late_info
            await asyncio.sleep(0)
            self.assertFalse(
                any(e["type"] == "turn.completed" for e in self.socket.sent)
            )
            tool_done = True
            await self.adapter._send_platform_message(envelope(turn))
            late_info = get_task_manager().create_task(
                late_output(), name="voice_test_late_tool"
            )
            yield Wait(
                step_data={
                    "step_scope": "actor_round",
                    "used_tools": ["tool-query", "action-send_text"],
                }
            )

        await self._run_fake_session(runner, turn)
        self.assertTrue(tool_done)
        self.assertEqual(self.socket.sent[-1]["type"], "turn.completed")
        release_late.set()
        await late_info.task
        self.assertFalse(
            any(e.get("messageId") == "late-tool" for e in self.socket.sent)
        )

    async def test_idle_wait_and_early_iteration_end_are_not_success(self) -> None:
        """没有明确 actor_round 的 Wait/自然结束不能作为完成证据。"""
        turn, _ = self.plugin.runtime.accept(submission(), "s")

        async def idle() -> Any:
            """返回没有元数据的空闲等待。"""
            turn.sent_count = 1
            yield Wait()

        await self._run_fake_session(idle, turn)
        self.assertEqual(self.socket.sent[-1]["type"], "turn.failed")
        second, _ = self.plugin.runtime.accept(submission("b"), "s2")

        async def empty() -> Any:
            """模拟 Service 提前关闭生成器。"""
            if False:
                yield Wait()

        await self._run_fake_session(empty, second)
        self.assertEqual(self.socket.sent[-1]["type"], "turn.failed")
        self.assertFalse(is_round_end(Wait()))
        self.assertFalse(is_round_end(Failure("错误")))
        self.assertTrue(is_round_end(Stop(0, step_data={"step_scope": "actor_round"})))

    async def test_claimed_cancel_drains_stage_before_terminal(self) -> None:
        """取消运行中的请求，经 TaskManager 取消正在 await 的会话步骤。"""
        turn, _ = self.plugin.runtime.accept(submission(), "s")
        turn.claimed = True
        started = asyncio.Event()
        drained = False

        async def running() -> Any:
            """模拟长模型请求并记录 finally 清理。"""
            nonlocal drained
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                drained = True
            yield Wait()

        info = get_task_manager().create_task(
            self._run_fake_session(running, turn), name="voice_test_cancel"
        )
        await started.wait()
        await self.adapter.on_platform_message(
            {
                "type": "chat.cancel",
                "sessionId": turn.session_id,
                "turnId": turn.turn_id,
            }
        )
        await info.task
        self.assertTrue(drained)
        self.assertEqual(self.socket.sent[-1]["type"], "turn.failed")
        self.assertTrue(turn.terminal)

    async def test_model_failure_and_timeout_have_explicit_terminal(self) -> None:
        """异常与超时都向 Node 提供明确失败，不生成伪成功。"""
        turn, _ = self.plugin.runtime.accept(submission(), "s")

        async def failure() -> Any:
            """模拟公开 Service 产出模型失败。"""
            yield Failure("模型配置缺失")

        await self._run_fake_session(failure, turn)
        self.assertEqual(self.socket.sent[-1]["message"], "模型配置缺失")
        second, _ = self.plugin.runtime.accept(submission("b"), "s2")

        async def timeout() -> Any:
            """模拟超过完整回合运行限制的请求。"""
            await asyncio.Event().wait()
            yield Wait()

        await self._run_fake_session(timeout, second, timeout=0.02)
        self.assertIn("超时", self.socket.sent[-1]["message"])

    async def test_validation_and_plugin_component_scope(self) -> None:
        """无效协议被拒绝，组件只选择网页平台。"""
        for key, value in [
            ("version", 2),
            ("text", " "),
            ("userId", ""),
            ("nickname", 3),
        ]:
            raw = submission()
            raw[key] = value
            with self.assertRaises(ValueError):
                validate_submit(raw)
        self.assertEqual(VoiceWebChatter.associated_platforms, ["voice_web"])
        self.assertEqual(len(self.plugin.get_components()), 2)
        self.plugin.config.plugin.enabled = False
        self.assertEqual(self.plugin.get_components(), [])

    async def test_real_mofox_wire_loopback_auth_handshake_and_cancel(self) -> None:
        """使用真实客户端传输验证 Bearer header 与线路消息，不启动完整 bot。"""
        finished = asyncio.Event()
        received: list[Any] = []
        errors: list[Exception] = []

        async def server_handler(socket: Any, path: str) -> None:
            """充当 Node bridge 的本机测试服务器。"""
            try:
                received.append((path, socket.request_headers.get("Authorization")))
                await socket.send(json.dumps({"type": "bridge.hello", "version": 1}))
                received.append(json.loads(await socket.recv()))
                await socket.send(json.dumps(submission("network")))
                received.append(json.loads(await socket.recv()))
                await socket.send(
                    json.dumps(
                        {
                            "type": "chat.cancel",
                            "sessionId": "session-network",
                            "turnId": "turn-network",
                        }
                    )
                )
                received.append(json.loads(await socket.recv()))
            except Exception as error:
                errors.append(error)
            finally:
                finished.set()

        async with serve(server_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            config = VoiceWebConfig()
            config.bridge.token = "n" * 64
            config.bridge.bot_name = "测试 Bot"
            config.bridge.url = f"ws://127.0.0.1:{port}/bridge"
            plugin = VoiceWebAssistantPlugin(config)
            sink = FakeSink()
            adapter = VoiceWebAdapter(sink, plugin)
            try:
                await adapter.start()
                await asyncio.wait_for(finished.wait(), timeout=3.0)
            finally:
                await adapter.stop()
            self.assertFalse(errors)
            self.assertEqual(received[0], ("/bridge", f"Bearer {'n' * 64}"))
            self.assertEqual(received[1]["type"], "bridge.ready")
            self.assertEqual(
                received[2], {"type": "chat.accepted", "turnId": "turn-network"}
            )
            self.assertEqual(received[3]["type"], "turn.failed")
            self.assertEqual(len(sink.sent), 1)
            self.assertIsNone(plugin.runtime.emit)

    async def test_actual_default_service_query_followup_then_action_has_real_round_end(
        self,
    ) -> None:
        """驱动用户既有真实 default_chatter Service/session/tool_flow，模型和工具 I/O 隔离。"""
        neo_root = Path(inspect.getfile(BasePlugin)).parents[4]
        plugin_path = neo_root / "plugins" / "default_chatter"
        if not plugin_path.exists():
            self.skipTest("当前 Neo 环境缺少 default_chatter 源码")
        manifest = await load_manifest(str(plugin_path))
        manager = PluginManager()
        self.assertIsNotNone(
            await manager._load_from_folder(str(plugin_path), manifest)
        )
        plugin_class = get_plugin_class("default_chatter")
        neo_config = plugin_class.configs[0]()
        neo_config.plugin.enabled = True
        neo_config.plugin.native_multimodal = False
        owner = plugin_class(neo_config)
        default_chatter_class = next(
            component
            for component in owner.get_components()
            if component.name == "default_chatter"
        )
        selection = ChatterManager()
        with patch.object(
            selection,
            "get_all_chatters",
            return_value={
                "default_chatter:chatter:default_chatter": default_chatter_class,
                "voice_web_assistant:chatter:voice_web_chatter": VoiceWebChatter,
            },
        ):
            self.assertIs(
                selection._select_chatter_class("private", "voice_web"),
                VoiceWebChatter,
            )
            self.assertIs(
                selection._select_chatter_class("private", "qq"),
                default_chatter_class,
            )
            self.assertIs(
                selection._select_chatter_class("group", "qq"),
                default_chatter_class,
            )
        service_class = next(
            component
            for component in owner.get_components()
            if component.name == "chat_core"
        )
        service = service_class(owner)
        session = service.create_session(stream_id="actual-default-test-stream")
        original_runtime = session.adapters.request_adapter
        self.assertIs(original_runtime.plugin, owner)
        self.assertIs(original_runtime.plugin.config, neo_config)
        session_module = inspect.getmodule(type(session))
        turn, _ = self.plugin.runtime.accept(
            submission("actual"), "actual-default-test-stream"
        )
        unread = SimpleNamespace(message_id=turn.message_id)
        stream = SimpleNamespace(
            stream_id=turn.stream_id,
            platform="voice_web",
            chat_type="private",
            stream_name="测试流",
        )
        query_done = False
        consumed = False
        adapter = self.adapter

        class ControlledModel:
            """替代网络 LLM，保留真实查询和后续回复状态机。"""

            def __init__(self) -> None:
                """初始化可 await 的最小请求/响应。"""
                self.payloads: list[Any] = []
                self.call_list: list[Any] = []
                self.message = ""
                self.reasoning_content = ""
                self.stop_reason = "tool_calls"
                self.requests = 0

            def add_payload(self, payload: Any) -> None:
                """记录实际默认会话写入的 payload。"""
                self.payloads.append(payload)

            async def send(self, stream: bool = False) -> Any:
                """第一轮查询，第二轮发送文本。"""
                self.requests += 1
                name = "tool-query" if self.requests == 1 else "action-send_text"
                self.call_list = [
                    SimpleNamespace(
                        id=f"call-{self.requests}", name=name, args={"reason": "验证"}
                    )
                ]
                return self

            def __await__(self) -> Any:
                """模拟已经完成的 LLMResponse。"""

                async def done() -> Any:
                    """返回测试模型状态。"""
                    return self

                return done().__await__()

        model = ControlledModel()

        async def fetch(*args: Any, **kwargs: Any) -> tuple[str, list[Any]]:
            """消费过的输入不重复出现。"""
            return "", [] if consumed else [unread]

        async def flush(*args: Any, **kwargs: Any) -> int:
            """模拟默认上下文的未读搬运。"""
            nonlocal consumed
            consumed = True
            return 1

        async def run_tool(
            calls: list[Any], response: Any, usable_map: Any, trigger_msg: Any
        ) -> list[tuple[bool, bool]]:
            """查询必须先被完整 await；后续动作才发送浏览器回复。"""
            nonlocal query_done
            if calls[0].name == "tool-query":
                self.assertFalse(
                    any(event["type"] == "turn.completed" for event in self.socket.sent)
                )
                await asyncio.sleep(0)
                query_done = True
                return [(True, True)]
            self.assertTrue(query_done)
            self.assertTrue(
                (
                    await adapter._send_platform_message(envelope(turn, "actual-reply"))
                ).success
            )
            return [(False, True)]

        patches = {
            "create_request": lambda *args, **kwargs: model,
            "_build_system_prompt": AsyncMock(return_value="原有 Default Chatter 人格"),
            "_build_enhanced_history_text": lambda *args: "",
            "_build_user_prompt": AsyncMock(return_value="原有用户模板"),
            "_build_negative_behaviors_extra": lambda: "",
            "inject_usables": AsyncMock(return_value=ToolRegistry()),
            "fetch_unreads": AsyncMock(side_effect=fetch),
            "format_message_line": lambda *args: "用户：你好",
            "flush_unreads": AsyncMock(side_effect=flush),
            "run_tool_call": AsyncMock(side_effect=run_tool),
        }
        chatter = VoiceWebChatter(turn.stream_id, self.plugin)
        chatter._cleanup_unread = AsyncMock()
        with ExitStack() as stack:
            for name, replacement in patches.items():
                stack.enter_context(patch.object(original_runtime, name, replacement))
            stack.enter_context(
                patch.object(service, "create_session", return_value=session)
            )
            stack.enter_context(
                patch.object(
                    session_module, "_print_actor_decision_panel", lambda *args: None
                )
            )
            stack.enter_context(
                patch(
                    "voice_web_assistant.chatter.service_api.get_service",
                    return_value=service,
                )
            )
            stack.enter_context(
                patch(
                    "voice_web_assistant.chatter.stream_api.activate_stream",
                    AsyncMock(return_value=stream),
                )
            )
            await chatter._run_turn(turn)
        self.assertEqual(model.requests, 2)
        self.assertTrue(query_done)
        self.assertEqual(self.socket.sent[-1]["type"], "turn.completed")
        self.assertEqual(self.socket.sent[-2]["messageId"], "actual-reply")


if __name__ == "__main__":
    unittest.main()
