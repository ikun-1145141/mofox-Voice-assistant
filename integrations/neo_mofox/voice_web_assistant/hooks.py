"""使用公开 Default Chatter Service 返回的会话适配器实施语音局部定制。"""

from __future__ import annotations

from typing import Any

from .runtime import Turn

GUIDANCE = (
    "当前用户通过本地网页语音与你交流。请保持原有身份和人格，用适合口头听取的中文自然回复。"
    "请使用可用的文本发送动作给当前私聊用户发送回答；必要时先使用查询工具，再发送结论。"
    "一轮回答结束后等待新的用户消息；不要发送语音文件，网页服务会把文本转成语音。"
)


class DelegatingAdapter:
    """原适配器仍处理默认提示词、历史、工具和实际消息存储。"""

    def __init__(self, delegate: Any) -> None:
        """保存 Service 本次创建的原适配器，不修改全局实例。"""
        self.delegate = delegate

    def __getattr__(self, name: str) -> Any:
        """透传没有由语音流覆盖的公开会话适配器方法。"""
        return getattr(self.delegate, name)


class ScopedUnreadAdapter(DelegatingAdapter):
    """固定流只读取本回合消息，原运行时负责格式化和 flush。"""

    def __init__(self, delegate: Any, turn: Turn) -> None:
        """固定当前请求对象，取消后不会切到最新提交。"""
        super().__init__(delegate)
        self.turn = turn

    async def fetch_unreads(self, time_format: str = "%H:%M") -> tuple[str, list[Any]]:
        """过滤自己的输入 ID；取消或终态时不返回任何新输入。"""
        _, messages = await self.delegate.fetch_unreads(time_format)
        scoped = (
            []
            if self.turn.cancelled or self.turn.terminal
            else [
                message
                for message in messages
                if message.message_id == self.turn.message_id
            ]
        )
        return "\n".join(
            self.delegate.format_message_line(message, time_format)
            for message in scoped
        ), scoped


class ScopedPromptAdapter(DelegatingAdapter):
    """保留用户当前 Default Chatter 人格与模板，仅追加口语引导。"""

    async def _build_user_prompt(
        self, chat_stream: Any, history_text: str, unread_lines: str, extra: str = ""
    ) -> str:
        """把语音要求放进既有 user extra，不替换 system persona。"""
        return await self.delegate._build_user_prompt(
            chat_stream, history_text, unread_lines, f"{extra}\n{GUIDANCE}".strip()
        )


class ScopedRespondAdapter:
    """已唤醒的语音私聊需要回答；概率门控不适用于此请求。"""

    def __init__(self, turn: Turn) -> None:
        """保存固定回合状态。"""
        self.turn = turn

    async def sub_agent(
        self,
        unreads_text: str,
        unread_msgs: list[Any],
        chat_stream: Any,
        history_text: str = "",
        decision_history: list[Any] | None = None,
    ) -> dict[str, Any]:
        """只替换本次会话的是否回应决策，不调用额外判断模型。"""
        return {
            "should_respond": not self.turn.cancelled and not self.turn.terminal,
            "reason": "已唤醒的网页语音私聊",
            "source": "voice_web",
        }


def scope_default_session(session: Any, turn: Turn) -> None:
    """用 Service 明确公开的 adapters 扩展点定制本次语音会话。"""
    adapters = getattr(session, "adapters", None)
    if adapters is None:
        raise ValueError(
            "default_chatter chat_core Service 缺少公开 session.adapters，请核查核心版本"
        )
    adapters.unread_adapter = ScopedUnreadAdapter(adapters.unread_adapter, turn)
    adapters.prompt_adapter = ScopedPromptAdapter(adapters.prompt_adapter)
    adapters.sub_agent_adapter = ScopedRespondAdapter(turn)
