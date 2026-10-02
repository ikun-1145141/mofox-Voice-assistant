# Neo-MoFox 本地语音助手

在电脑上运行的 Vue 3 网页语音助手：导入自己的 Live2D 模型，通过文本、按键录音或中文唤醒词与 Neo-MoFox 对话，使用主机 GPT-SoVITS API 合成声音，在当前网页设备播放并同步嘴型。

工程使用 **npm workspaces + TypeScript + Vue 3 + Vite + Fastify**。Neo-MoFox 接入部分是 Python 插件，复用其现有人格、聊天历史和可用工具。

## 启动

需要 Node.js **22.12+**，本机运行 Neo-MoFox 和 GPT-SoVITS `api_v2.py`（默认 `http://127.0.0.1:9880`）。

```powershell
cd G:\mofox-Voice-assistant
npm install
npm run setup
npm run build
npm start
```

打开 **http://localhost:8789**，输入终端打印的配对码。管理员配对码允许修改主机配置、导入模型和运行库；普通配对码用于其他设备聊天。首次生成的配置在 `config/local.json`，配对码和随机桥接令牌保留在本机。

本机已经配置蓝音模型、玛德蕾娜参考音频、9880 GSV、SenseVoice 和中文关键词模型；这些个人资源保存在被 Git 忽略的 `data/` 和 `config/local.json`。重新克隆仓库需要自己配置资源。

开发时运行 `npm run dev`，打开 **http://localhost:5180**。端口选择避开本机已有的 8787/5173 文档服务。

## 配置语音与形象

```powershell
npm run setup -- --live2d "G:\你的模型目录" --ref-audio "E:\声音\参考.wav" --prompt "参考音频对应的文字" --voice-name "我的声音" --gsv "http://127.0.0.1:9880" --cubism-core --speech-models
```

`--live2d` 复制模型到项目数据目录，不改原文件。网页设置也支持上传完整 ZIP；需要一个 `.model3.json`、其引用的 `.moc3` 和 PNG 纹理。同目录的 `.exp3.json` 和 `.motion3.json` 会补入导入副本。ZIP 上限 100 MiB，解压上限 300 MiB，纹理最长边 4096。

`--cubism-core` 从 Live2D 官方下载 Cubism Core 到本机；也可以从官方 SDK 获取 `live2dcubismcore.min.js` 后在网页上传。运行库与用户模型不提交到仓库。渲染器使用 `pixi-live2d-display` Cubism 4 入口，其他模型版本需实际验证。

`--speech-models` 下载 [sherpa-onnx 官方 SenseVoice INT8 和中文 KWS 模型](https://github.com/k2-fsa/sherpa-onnx/releases)，约 196 MB，需要系统的 `curl` 和 `tar`（Windows 自带）。识别在服务端 Worker 内进行，浏览器发送 16 kHz 单声道 PCM。初版用能量静音断句，噪声环境需要调整静音时长。

默认唤醒词是“你好小墨”。网页修改 2–20 个连续汉字的唤醒词会生成并校验拼音关键词文件；多音字按名字需要的读法、中英文唤醒词可以自行提供 sherpa `keywords.txt`，在设置中指定外部文件。先说唤醒词，稍作停顿，看到倾听提示后再说问题；首版尚未支持“唤醒词和问题连成一句”。网页必须保持运行并允许麦克风；手机后台或锁屏时浏览器可能暂停录音。

GSV 权重仍由原 GSV 服务管理。参考音频路径是 **GSV 主机上的路径**，不是手机路径。接口必须支持 `/tts` 并返回非流式 WAV。设置中的“试听”可以独立检查声音，无需 bot 已连接。

## 安装 Neo-MoFox 插件

```powershell
npm run plugin:install -- --neo "G:\Neo-MoFox"
# 更新本项目安装的插件：
npm run plugin:install -- --neo "G:\Neo-MoFox" --update
```

脚本复制 `integrations/neo_mofox/voice_web_assistant` 并写入与 Node 一致的桥接密钥。更新已有配置时保留带时间戳的备份。先启动网页服务，再重启 Neo-MoFox 加载插件；在页面确认 Neo-MoFox 状态已连接后发送问题。

桥接只监听 `127.0.0.1:8788`。每个网页会话使用独立私聊身份，回复按会话和回合路由。停止播报会取消当前回合，等待插件明确终态后允许下一轮；断线无法确认终态时使用“新建会话”。完整协议、插件依赖和工具边界见 [插件说明](integrations/neo_mofox/voice_web_assistant/README.md)。

## 手机和其他设备

其他设备通过电脑的局域网 IP 访问。浏览器麦克风需要可信 HTTPS：

```powershell
npm run https
npm start
```

脚本生成本机 CA 和包含当前 IP 的服务器证书，打印 HTTPS 地址（本机当前为 `https://192.168.31.90:8789`）。把 `data/certs/rootCA.pem` 安装为访问设备信任的根证书，然后重新打开页面；iOS 还需要在证书信任设置中启用完全信任。主机也需要信任该证书，才能在生产网页录音。仅带走 `rootCA.pem`，CA 私钥留在主机。

允许防火墙中的 Node 服务或 TCP 8789，设备需位于能互访的网络。IP 改变后重新运行 `npm run https`。回到本机 HTTP 开发时，将 `config/local.json` 中 `server.certPath` 和 `server.keyPath` 清空并重启。

## 检查与资料

```powershell
npm test
npm run build
```

测试覆盖模型包校验、PCM/断句、唤醒词转换、会话隔离、去重及取消终态；插件隔离验证命令在其 README。测试里的可控核心用于验证协议，真实 bot 回复仍需启动 Neo-MoFox 联调。

- [项目方案](docs/项目方案.md)：从旧 `G:\语音助手` 迁入的原始设计及实施状态。
- [anima_chatter vtb-experiments](https://github.com/tt-P607/anima_chatter/tree/vtb-experiments)：参考其分段语音和表演标记；本项目直接调用 GSV `/tts`。

支持 `[emotion:happy]`、`[motion:wave]`、`[wait:0.3]` 及结束标记。表情映射填写模型表情名，动作映射填写 `组名:索引`，例如 `Other:0`；动作和嘴型在实际音频播放时驱动。
