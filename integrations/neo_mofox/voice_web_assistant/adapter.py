"""通过 mofox-wire 客户端传输接入 Node 桥，复用框架入站和出站线路。"""

from __future__ import annotations

import json
import contextlib
import asyncio
import time
from typing import Any
from urllib.parse import urlsplit

from mofox_wire import CoreSink, MessageEnvelope, WebSocketAdapterOptions

from src.app.plugin_system.api.log_api import get_logger
from src.app.plugin_system.api import config_api
from src.app.plugin_system.base import BaseAdapter, BasePlugin
from src.app.plugin_system.types import ChatStream

# 当前 Neo 公共 types 尚未导出发送结果；采用 BaseAdapter 使用的真实类型。
from src.core.components.types import PlatformSendResult
from src.kernel.concurrency import get_task_manager

from .config import VoiceWebConfig
from .runtime import current_turn, outgoing_text, validate_submit

logger = get_logger("voice_web_assistant")


class VoiceWebAdapter(BaseAdapter):
    """voice_web 私聊平台；所有自建后台任务归框架 TaskManager 管理。"""

    name = "voice_web"
    description = "本地 Vue 网页语音平台桥"
    adapter_version = "0.1.0"
    platform = "voice_web"

    def __init__(
        self, core_sink: CoreSink, plugin: BasePlugin | None = None, **kwargs: Any
    ) -> None:
        """配置现有 mofox-wire WebSocket 客户端并保存实例级运行时。"""
        if plugin is None or not isinstance(plugin.config, VoiceWebConfig):
            raise ValueError("voice_web 需要 VoiceWebConfig")
        cfg = plugin.config.bridge
        if len(cfg.token.strip()) < 32:
            raise ValueError("bridge.token 必须使用至少 32 字符的随机密钥")
        parsed = urlsplit(cfg.url)
        if parsed.scheme not in {"ws", "wss"} or not parsed.hostname:
            raise ValueError("bridge.url 必须是 ws:// 或 wss:// 地址")
        options = WebSocketAdapterOptions(
            url=cfg.url,
            headers={"Authorization": f"Bearer {cfg.token}"},
            reconnect_interval=cfg.reconnect_seconds,
            max_message_size=65536,
        )
        super().__init__(core_sink, plugin=plugin, transport=options, **kwargs)
        self.runtime = plugin.runtime
        self.runtime.emit = self._emit
        plugin.adapter = self
        self._ready = False

    async def _start_ws_transport(self, options: WebSocketAdapterOptions) -> None:
        """在 TaskManager 中运行 mofox-wire 自带重连循环。"""
        info = get_task_manager().create_task(
            self._ws_connect_loop(options), name="voice_web_connect", daemon=True
        )
        self._ws_task = info.task

    async def _ws_listen_loop(self, options: WebSocketAdapterOptions) -> None:
        """按线路顺序接收入站请求，连接断开时取消该线路的回合。"""
        self._ready = False
        socket = self._ws
        assert socket is not None
        try:
            async for raw in socket:
                if self._closed:
                    break
                try:
                    await self.on_platform_message(json.loads(raw))
                except Exception as error:
                    await self._emit(
                        {"type": "bridge.error", "message": str(error)[:2000]}
                    )
                    logger.warning("网页桥接请求被拒绝: %s", error)
        finally:
            self._ready = False
            for turn in list(self.runtime.turns.values()):
                if not turn.terminal:
                    turn.cancelled = True
                    if turn.stage_task is not None:
                        get_task_manager().cancel_task(turn.stage_task.task_id)
                    turn.terminal = True
                    turn.terminal_event = {
                        "type": "turn.failed",
                        "sessionId": turn.session_id,
                        "turnId": turn.turn_id,
                        "message": "网页桥连接已断开",
                    }
            with contextlib.suppress(Exception):
                await socket.close()
            self._ws = None

    async def _emit(self, payload: dict[str, Any]) -> None:
        """发送协议对象，避免 mofox-wire 默认 send 包装破坏桥接协议。"""
        socket = self._ws
        if socket is None or socket.closed:
            raise RuntimeError("网页桥连接已断开")
        await socket.send(json.dumps(payload, ensure_ascii=False))

    async def on_platform_message(self, raw: Any) -> None:
        """处理握手、取消、去重和标准入站消息；Adapter 不执行模型逻辑。"""
        if not isinstance(raw, dict):
            raise ValueError("桥接消息必须是 JSON 对象")
        if raw.get("type") == "bridge.hello":
            if raw.get("version") != 1:
                raise ValueError("不支持的桥接协议版本")
            self._ready = True
            info = await self.get_bot_info()
            await self._emit(
                {
                    "type": "bridge.ready",
                    "version": 1,
                    "botName": info["bot_name"],
                    "capabilities": ["text", "turn-completion"],
                }
            )
            return
        if not self._ready:
            raise ValueError("需先发送 bridge.hello")
        if raw.get("type") == "chat.cancel":
            turn = self.runtime.find_cancel(
                str(raw.get("sessionId", "")), str(raw.get("turnId", ""))
            )
            if turn is None:
                return
            if turn.stage_task is not None:
                get_task_manager().cancel_task(turn.stage_task.task_id)
            if not turn.claimed:
                await self.runtime.finish(turn)
            return
        validate_submit(raw)
        stream_id = ChatStream.generate_stream_id(self.platform, user_id=raw["userId"])
        turn, fresh = self.runtime.accept(raw, stream_id)
        await self._emit({"type": "chat.accepted", "turnId": turn.turn_id})
        if not fresh:
            if turn.terminal_event is not None:
                await self._emit(turn.terminal_event)
            return
        try:
            await self.core_sink.send(await self.from_platform_message(raw))
        except Exception:
            await self.runtime.finish(turn, "Neo 入站消息处理失败")
            raise

    async def from_platform_message(self, raw: Any) -> MessageEnvelope:
        """将提交转换为标准私聊信封，保留消息 ID 与桥接元信息。"""
        validate_submit(raw)
        return {
            "direction": "incoming",
            "message_info": {
                "platform": self.platform,
                "message_id": raw["messageId"],
                "time": time.time(),
                "message_type": "message",
                "user_info": {
                    "platform": self.platform,
                    "user_id": raw["userId"],
                    "user_nickname": raw["nickname"],
                },
                "extra": {
                    "voice_session_id": raw["sessionId"],
                    "voice_turn_id": raw["turnId"],
                },
            },
            "message_segment": [{"type": "text", "data": raw["text"]}],
            "raw_message": raw,
        }

    async def _send_platform_message(
        self, envelope: MessageEnvelope
    ) -> PlatformSendResult:
        """发送真实目标匹配的文本；无归属、取消、终态和迟到输出拒绝转发。"""
        turn = current_turn.get()
        output = outgoing_text(envelope, turn)
        if output is None or turn is None:
            return PlatformSendResult(
                success=False, error="网页消息缺少有效回合归属、真实目标或纯文本内容"
            )
        message_id, text = output
        try:
            await self._emit(
                {
                    "type": "bot.message",
                    "sessionId": turn.session_id,
                    "turnId": turn.turn_id,
                    "messageId": message_id,
                    "text": text[:32000],
                }
            )
        except Exception as error:
            return PlatformSendResult(success=False, error=str(error))
        turn.sent_count += 1
        return PlatformSendResult(success=True, message_id=message_id)

    async def get_bot_info(self) -> dict[str, Any]:
        """提供显示名；不会覆盖 Neo 的人格、默认 prompt 或模型配置。"""
        name = self.plugin.config.bridge.bot_name.strip()
        if not name:
            name = config_api.get_core_config().personality.nickname
        return {
            "bot_id": "neo_voice_web",
            "bot_name": name,
            "platform": self.platform,
        }

    async def health_check(self) -> bool:
        """mofox-wire 自带重连循环管理连接，不再启动第二套重连。"""
        return True

    async def on_adapter_unloaded(self) -> None:
        """解除发送入口并取消正在执行的语音流回合。"""
        self._ready = False
        self.runtime.emit = None
        stages = []
        for turn in self.runtime.turns.values():
            turn.cancelled = True
            turn.terminal = True
            if turn.stage_task is not None:
                get_task_manager().cancel_task(turn.stage_task.task_id)
                if turn.stage_task.task is not None:
                    stages.append(turn.stage_task.task)
        if stages:
            await asyncio.gather(*stages, return_exceptions=True)
        self.plugin.adapter = None
