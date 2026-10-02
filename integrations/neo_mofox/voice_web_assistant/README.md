# Neo-MoFox 网页语音平台插件

将整个 `voice_web_assistant` 目录复制到 Neo-MoFox 的 `plugins/voice_web_assistant`。目录名、manifest 名和插件名保持一致。Node 服务处理麦克风、识别、GSV TTS 和 Live2D；Python 插件只接入 Neo 的文本聊天能力。

需要启用用户既有的 `default_chatter` 插件及其公开 Service `default_chatter:service:chat_core`，并配置正常工作的 `actor` 模型。本项目没有另建人格或直接调用独立模型：每个请求通过 `service_api.get_service` 创建用户当前的默认会话，不传自己的插件配置，因此继续使用旧 Default Chatter 的真实配置、提示词、原人格、聊天历史和对当前流可用的工具。没有跨插件 Python import，也不需要启用 `neo_default_chatter`。后者是另一套全平台 Chatter，直接启用可能改变其他平台的自动选择，本插件只注册语音专属 Chatter。

配置位置为 `config/plugins/voice_web_assistant/config.toml`：

```toml
[plugin]
enabled = true

[bridge]
url = "ws://127.0.0.1:8788/bridge"
token = "安装脚本生成的至少32字符随机密钥，与Node服务一致"
reconnect_seconds = 3.0
turn_timeout_seconds = 180.0
bot_name = "" # 留空使用 Neo 原昵称，避免角色自称发生变化
```

空密钥或短密钥会拒绝启动适配器。插件用 mofox-wire 的现有 WebSocket 客户端和重连循环发送 `Authorization: Bearer <token>`；所有插件自己创建的连接与回合任务均交给 Neo TaskManager。当前 `src.app.plugin_system.types` 未公开 `PlatformSendResult`，仅此发送结果类型从 `src.core.components.types` 导入，与 `BaseAdapter` 本身保持一致。

Node 建连后首先发送 `{"type":"bridge.hello","version":1}`，插件回答 `bridge.ready`，声明 `text` 与 `turn-completion`。Node 为每个会话生成独立 `userId`，例如 `voice:<sessionId>`。提交、取消和返回字段与 `packages/protocol/src/index.ts` 的协议 v1 一致。相同 `messageId`/`turnId` 的重放只入核心一次；不同内容复用 ID、会话更换身份、两个会话共用一个 Neo 私聊用户以及同会话同时提交两轮都会被拒绝。最近 4096 个回合保留去重记录，活跃回合不被淘汰。

`VoiceWebChatter` 只匹配 `voice_web` 私聊；其他平台继续使用其原有 Chatter。通过旧 Service 明确提供的 `session.adapters` 扩展点，仅替换本次会话的未读过滤、用户额外提示和是否回应决策：固定输入 ID、追加口语引导、已唤醒私聊直接回答；system prompt、历史格式、flush、模型请求和工具执行仍由原运行时完成。网页输出必须同时具有固定回合上下文与匹配的真实 `message_info.user_info.user_id`，不会把一个平台的所有输出转给“最新网页会话”。

回合完成依据是当前 Neo 源码确实产出的 `Wait/Stop.step_data.step_scope == "actor_round"`：`session.py` 在模型请求和 `process_tool_calls` 全部 await 完成、准备回到等待或停止状态时产生它，`tool_flow.py` 在等待/停止之前先 await 清空待执行工具。只有至少一条文本已成功发送，才发 `turn.completed`。模型失败、完整回合超时、空回复、没有明确标记的空闲 Wait、无证据的自然结束都会发 `turn.failed`。没有“几秒没消息就算回答完成”的计时推断。

取消保留旧 `Turn` 对象的身份、cancelled 和 terminal 状态，经 TaskManager 取消正在 await 的模型/工具步骤后发送失败终态。终态只发送一次。工具派生任务即使继承了旧上下文，迟到输出也会被拒绝；缺少上下文的独立消息同样被拒绝，不能猜测最新回合。Node 应在取消后等待明确终态，并对需要隔离的后续请求换新会话/新 userId。连接断开和插件卸载都会取消回合、解除发送入口并关闭传输。

支持边界：

- 复用默认会话中已注册、可在当前语音私聊流使用的工具及持久化历史，不保证任意第三方插件对新 `voice_web` 平台天然兼容。仅允许文本出站；图片、文件、语音段不会被冒充文本。
- 网页请求到第一次明确 `actor_round` 为止。Neo `pass_and_wait(seconds)` 的定时自发续聊、回合完成之后的异步 Agent 通知不会续接到浏览器。工具需要在当前回合内 await 查询并发送结论，超出回合的输出会被丢弃。
- 每次网页请求创建一个公开 Service 会话。Neo 流的历史按原有机制保存，但默认会话的临时 LLMRequest 状态不跨网页请求保留。
- 此实现与已检查的 `G:\Neo-MoFox` 旧 Default Chatter 公开 Service、会话适配器和 `actor_round` 语义对应；核心将来改动该协议时插件会明确失败，需适配后再启用。
- 插件代码与配置模板在项目内。安装脚本将复制插件，已有安装需要运行 `npm run plugin:install -- --update`；未修改 Neo 源码或启用新的全平台 Chatter，未启动完整 bot，未向 QQ 等外部平台发送测试消息。真实模型和工具回复还需要按项目联调步骤验证。
- 旧 Default Chatter 的 manifest 声明 `scikit-learn>=1.5.0`、`numpy>=2.0.0`、`joblib>=1.4.0`。检查时其 `.venv` 缺少 scikit-learn；在当前实现范围内已补装这项声明的依赖及其依赖以验证真实 Service，没有用假的 sklearn 跳过核心导入。

运行隔离验证（从 Neo 的虚拟环境执行，不启动 bot）：

```powershell
$env:PYTHONPATH = 'G:\Neo-MoFox;G:\mofox-Voice-assistant\integrations\neo_mofox'
& 'G:\Neo-MoFox\.venv\Scripts\python.exe' -m unittest discover -s 'G:\mofox-Voice-assistant\integrations\neo_mofox\voice_web_assistant\test' -v
```

当前 16 项测试使用真实 Neo 基类、消息转换器和 TaskManager，配合可控的假 Service/Socket，验证输入转换、身份隔离、去重、取消、失败、显式回合终态、已 await 工具返回顺序，以及继承旧上下文的后台迟到输出被丢弃。另有实际 mofox-wire 本机 WebSocket 往返测试，和通过 Neo loader 仅导入旧 `default_chatter` 模块（不调用插件加载生命周期、不读写真实配置）的真实 chat_core/session/tool_flow 集成测试，实际跑查询 → FOLLOW_UP → 文本动作 → actor_round 完成，并用真实 ChatterManager 验证 `voice_web` 私聊选语音 Chatter、QQ 私聊和群聊仍选旧 Default Chatter。模型与工具网络 I/O 均被测试替代，它不冒充真实 LLM/完整 bot 联调。
