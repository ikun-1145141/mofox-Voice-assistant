"""保存不可混用的用户、会话与回合归属；迟到消息只能保留旧归属。"""

from __future__ import annotations

from collections import OrderedDict
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

Emitter = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass(slots=True)
class Turn:
    """一次提交的身份和状态；后台任务继承的是此对象而非最新回合。"""

    session_id: str
    user_id: str
    turn_id: str
    message_id: str
    text: str
    nickname: str
    stream_id: str
    cancelled: bool = False
    terminal: bool = False
    claimed: bool = False
    sent_count: int = 0
    stage_task: Any = None
    terminal_event: dict[str, Any] | None = None


current_turn: ContextVar[Turn | None] = ContextVar(
    "voice_web_current_turn", default=None
)


def validate_submit(raw: Any) -> dict[str, Any]:
    """验证协议 v1，拒绝空身份、超长文本与类型错误。"""
    if (
        not isinstance(raw, dict)
        or raw.get("type") != "chat.submit"
        or raw.get("version") != 1
    ):
        raise ValueError("需要协议 v1 的 chat.submit")
    for key in ("sessionId", "userId", "turnId", "messageId"):
        value = raw.get(key)
        if not isinstance(value, str) or not value.strip() or len(value) > 128:
            raise ValueError(f"无效的 {key}")
    text = raw.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError("text 必须是 1–4000 字符")
    nickname = raw.get("nickname")
    if not isinstance(nickname, str) or len(nickname) > 128:
        raise ValueError("无效的 nickname")
    return raw


class VoiceRuntime:
    """插件实例级状态，不依赖 Service 实例单例假设。"""

    def __init__(self, max_retained: int = 4096) -> None:
        """初始化去重记录；活跃回合不会因容量限制被删除。"""
        self.turns: OrderedDict[str, Turn] = OrderedDict()
        self.messages: dict[str, Turn] = {}
        self.sessions: dict[str, str] = {}
        self.users: dict[str, str] = {}
        self.emit: Emitter | None = None
        self.max_retained = max_retained

    def accept(self, raw: dict[str, Any], stream_id: str) -> tuple[Turn, bool]:
        """登记提交，幂等重放相同 ID，拒绝身份更换和并发同会话回合。"""
        validate_submit(raw)
        previous = self.messages.get(raw["messageId"]) or self.turns.get(raw["turnId"])
        if previous is not None:
            if (
                previous.session_id,
                previous.user_id,
                previous.turn_id,
                previous.message_id,
                previous.text,
            ) != (
                raw["sessionId"],
                raw["userId"],
                raw["turnId"],
                raw["messageId"],
                raw["text"],
            ):
                raise ValueError("回合或消息 ID 已被其他提交使用")
            return previous, False
        session, user = raw["sessionId"], raw["userId"]
        if session in self.sessions and self.sessions[session] != user:
            raise ValueError("会话不能更换 userId")
        if user in self.users and self.users[user] != session:
            raise ValueError("每个网页会话需要独立 userId")
        if any(t.session_id == session and not t.terminal for t in self.turns.values()):
            raise ValueError("此会话的上一回合尚未结束")
        self.sessions[session] = user
        self.users[user] = session
        turn = Turn(
            session,
            user,
            raw["turnId"],
            raw["messageId"],
            raw["text"],
            raw["nickname"],
            stream_id,
        )
        self.turns[turn.turn_id] = turn
        self.messages[turn.message_id] = turn
        self._prune()
        return turn, True

    def _prune(self) -> None:
        """淘汰最早终态记录；仍被任务引用的 Turn 对象保留 terminal 标记。"""
        for key, turn in list(self.turns.items()):
            if len(self.turns) <= self.max_retained:
                break
            if turn.terminal:
                del self.turns[key]
                self.messages.pop(turn.message_id, None)
        retained_sessions = {t.session_id for t in self.turns.values()}
        for session in list(self.sessions):
            if session not in retained_sessions:
                user = self.sessions.pop(session)
                self.users.pop(user, None)

    def claim(self, stream_id: str) -> Turn | None:
        """为 Chatter 取得此流唯一待处理回合。"""
        for turn in self.turns.values():
            if turn.stream_id == stream_id and not turn.terminal and not turn.claimed:
                turn.claimed = True
                return turn
        return None

    async def send(self, payload: dict[str, Any]) -> None:
        """只通过当前适配器发送，断开时明确报错。"""
        if self.emit is None:
            raise RuntimeError("网页桥尚未连接")
        await self.emit(payload)

    async def finish(self, turn: Turn, error: str | None = None) -> None:
        """恰好一次终态；取消或没有成功送达回复不能被报告为成功。"""
        if turn.terminal:
            return
        if turn.cancelled:
            error = "回合已取消"
        elif error is None and turn.sent_count == 0:
            error = "Neo 本轮未发送文本回复"
        payload: dict[str, Any] = {
            "type": "turn.failed" if error else "turn.completed",
            "sessionId": turn.session_id,
            "turnId": turn.turn_id,
        }
        if error:
            payload["message"] = error[:2000]
        turn.terminal = True
        turn.terminal_event = payload
        await self.send(payload)

    def find_cancel(self, session_id: str, turn_id: str) -> Turn | None:
        """取消请求必须匹配原始会话，不猜测其他流的活跃回合。"""
        turn = self.turns.get(turn_id)
        if turn is None or turn.session_id != session_id or turn.terminal:
            return None
        turn.cancelled = True
        return turn


def outgoing_text(
    envelope: dict[str, Any], turn: Turn | None
) -> tuple[str, str] | None:
    """验证真实私聊发送目标和固定回合归属，随后提取纯文本。"""
    if turn is None or turn.terminal or turn.cancelled:
        return None
    info = envelope.get("message_info") or {}
    if info.get("platform") != "voice_web" or info.get("group_info"):
        return None
    user = info.get("user_info") or {}
    if user.get("user_id") != turn.user_id:
        return None
    segments = envelope.get("message_segment") or []
    if isinstance(segments, dict):
        segments = [segments]
    pieces: list[str] = []
    for segment in segments:
        if segment.get("type") == "text":
            data = segment.get("data")
            value = data.get("text", "") if isinstance(data, dict) else data
            if isinstance(value, str):
                pieces.append(value)
    text = "".join(pieces).strip()
    message_id = info.get("message_id")
    if not text or not isinstance(message_id, str) or not message_id:
        return None
    return message_id, text
