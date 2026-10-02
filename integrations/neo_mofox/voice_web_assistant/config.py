"""网页桥接地址、鉴权和回合运行限制。"""

from src.app.plugin_system.base import BaseConfig, Field, SectionBase, config_section


class VoiceWebConfig(BaseConfig):
    """保存在 config/plugins/voice_web_assistant/config.toml 的配置。"""

    name = "config"
    description = "本地网页语音助手桥接配置"

    @config_section("plugin")
    class PluginSection(SectionBase):
        """插件开关。"""

        enabled: bool = Field(default=True, description="启用网页语音平台")

    @config_section("bridge")
    class BridgeSection(SectionBase):
        """由 Node 服务提供的独立 WebSocket 桥。"""

        url: str = Field(
            default="ws://127.0.0.1:8788/bridge", description="Node 桥接地址"
        )
        token: str = Field(
            default="", description="与 Node 服务一致的随机桥接密钥，不能为空"
        )
        reconnect_seconds: float = Field(
            default=3.0, ge=0.5, description="连接重试间隔"
        )
        turn_timeout_seconds: float = Field(
            default=180.0, ge=5.0, description="一次完整模型与工具回合的最大秒数"
        )
        bot_name: str = Field(
            default="", description="留空使用 Neo 原昵称；填写时指定网页显示名"
        )

    plugin: PluginSection = Field(default_factory=PluginSection)
    bridge: BridgeSection = Field(default_factory=BridgeSection)
