"""注册网页适配器和专属 Chatter，复用已有 Default Chatter Service。"""

from src.app.plugin_system.base import BasePlugin, register_plugin

from .adapter import VoiceWebAdapter
from .chatter import CHAT_CORE, VoiceWebChatter
from .config import VoiceWebConfig
from .runtime import VoiceRuntime


@register_plugin
class VoiceWebAssistantPlugin(BasePlugin):
    """网页服务执行音频工作，本插件只负责接入 Neo 的文本会话能力。"""

    plugin_name = "voice_web_assistant"
    configs = [VoiceWebConfig]
    dependent_components = [CHAT_CORE]

    def __init__(self, config: VoiceWebConfig | None = None) -> None:
        """为每次插件加载建立独立共享状态。"""
        super().__init__(config)
        self.runtime = VoiceRuntime()
        self.adapter: VoiceWebAdapter | None = None

    def get_components(self) -> list[type]:
        """配置关闭时不注册组件，清单和真实加载保持一致。"""
        if self.config is not None and not self.config.plugin.enabled:
            return []
        return [VoiceWebAdapter, VoiceWebChatter]

    async def on_plugin_unloaded(self) -> None:
        """关闭适配器并清理共享状态，不保留后台任务。"""
        if self.adapter is not None:
            await self.adapter.stop()
        self.runtime.turns.clear()
        self.runtime.messages.clear()
        self.runtime.sessions.clear()
        self.runtime.users.clear()
        self.runtime.emit = None
