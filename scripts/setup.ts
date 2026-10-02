import { parseArgs } from 'node:util';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA, loadConfig, saveConfig } from '../apps/server/src/config.js';
import { ModelStore } from '../apps/server/src/models.js';
import { writeKeywords } from '../apps/server/src/speech/keywords.js';

const { values } = parseArgs({ options: {
  live2d: { type: 'string' }, 'ref-audio': { type: 'string' }, prompt: { type: 'string' },
  gsv: { type: 'string' }, 'voice-name': { type: 'string' },
  'speech-models': { type: 'boolean', default: false }, 'cubism-core': { type: 'boolean', default: false }
} });
const config = await loadConfig();
if (values.gsv) config.tts.baseUrl = new URL(values.gsv).href.replace(/\/$/, '');
if (values['ref-audio']) {
  await access(values['ref-audio']);
  config.tts.voice.refAudioPath = path.resolve(values['ref-audio']);
  config.tts.voice.promptText = values.prompt ?? path.basename(values['ref-audio'], path.extname(values['ref-audio']));
  config.tts.voice.name = values['voice-name'] ?? '本机声音';
  config.tts.enabled = true;
}
if (values.live2d) {
  const model = await new ModelStore(DATA).importDirectory(path.resolve(values.live2d));
  config.live2d.defaultModelId = model.id;
  console.log(`模型已复制到本项目：${model.name}`);
}
async function exists(file: string) { try { await access(file); return true; } catch { return false; } }
async function download(url: string, destination: string) {
  await mkdir(path.dirname(destination), { recursive: true });
  console.log(`下载 ${path.basename(destination)} …`);
  // curl honors the host's proxy settings, including Windows network proxies.
  await new Promise<void>((resolve, reject) => {
    const curl = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--fail', '--location', '--retry', '2', '--connect-timeout', '30', '--max-time', '900', '--silent', '--show-error', '--output', destination, url], { stdio: 'inherit', windowsHide: true });
    curl.on('error', reject); curl.on('exit', code => code === 0 ? resolve() : reject(new Error(`下载失败：curl ${code}`)));
  });
}
async function modelArchive(release: string, name: string) {
  const root = path.join(DATA, 'speech');
  const directory = path.join(root, name);
  if (await exists(path.join(directory, 'tokens.txt'))) return directory;
  const archive = path.join(root, `${name}.tar.bz2`);
  await download(`https://github.com/k2-fsa/sherpa-onnx/releases/download/${release}/${name}.tar.bz2`, archive);
  await new Promise<void>((resolve, reject) => {
    const tar = spawn('tar', ['-xf', archive, '-C', root], { stdio: 'inherit', windowsHide: true });
    tar.on('error', reject); tar.on('exit', code => code === 0 ? resolve() : reject(new Error(`tar 解压失败：${code}`)));
  });
  await access(path.join(directory, 'tokens.txt'));
  return directory;
}
if (values['speech-models']) {
  const asr = await modelArchive('asr-models', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17');
  const kws = await modelArchive('kws-models', 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01');
  config.speech.senseVoiceModel = path.join(asr, 'model.int8.onnx');
  config.speech.tokens = path.join(asr, 'tokens.txt');
  for (const key of ['Encoder', 'Decoder', 'Joiner'] as const) {
    const file = `${key.toLowerCase()}-epoch-12-avg-2-chunk-16-left-64.onnx`;
    config.speech[`kws${key}`] = path.join(kws, file);
    await access(config.speech[`kws${key}`]);
  }
  config.speech.kwsTokens = path.join(kws, 'tokens.txt');
  config.speech.keywordsFile = path.join(DATA, 'speech/keywords.txt');
  await writeKeywords(config.wakePhrase, config.speech.kwsTokens, config.speech.keywordsFile);
  config.speech.enabled = true;
}
if (values['cubism-core']) {
  const core = path.join(DATA, 'vendor/live2dcubismcore.min.js');
  if (!await exists(core)) await download('https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js', core);
  if (!(await readFile(core, 'utf8')).includes('Live2DCubismCore')) throw new Error('官方运行库下载内容无效');
  config.live2d.coreReady = true;
}
await saveConfig(config);
console.log('配置已保存到 config/local.json；个人模型、音频和密钥不会加入 Git。');
console.log(`设备配对码：${config.security.pairCode}\n管理员配对码：${config.security.adminCode}`);
