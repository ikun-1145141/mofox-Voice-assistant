import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { PublicSettings } from '@mofox/protocol';

export const ROOT = path.resolve(process.env.ASSISTANT_ROOT ?? path.join(process.cwd(), process.cwd().endsWith(`${path.sep}server`) ? '../..' : '.'));
export const DATA = path.join(ROOT, 'data');
export const LOCAL_CONFIG = path.join(ROOT, 'config/local.json');
const safeString = z.string().max(4096);
export const settingsSchema = z.object({
  assistantName: z.string().trim().min(1).max(64), wakePhrase: z.string().trim().min(1).max(64),
  tts: z.object({ baseUrl: z.string().url().max(1024), enabled: z.boolean(), timeoutMs: z.number().int().min(1000).max(300000),
    voice: z.object({ id: z.string().min(1).max(64), name: z.string().min(1).max(64), refAudioPath: safeString, promptText: z.string().max(4000), promptLang: z.string().min(1).max(16), textLang: z.string().min(1).max(16), speed: z.number().min(0.5).max(2) }) }),
  speech: z.object({ enabled: z.boolean(), senseVoiceModel: safeString, tokens: safeString, kwsEncoder: safeString, kwsDecoder: safeString, kwsJoiner: safeString, kwsTokens: safeString, keywordsFile: safeString, silenceMs: z.number().int().min(300).max(3000), maxUtteranceMs: z.number().int().min(2000).max(60000) }),
  live2d: z.object({ defaultModelId: z.string().max(128), coreReady: z.boolean(), mapping: z.object({ mouthParameter: z.string().min(1).max(128), emotions: z.record(z.string().max(128)), motions: z.record(z.string().max(128)) }) })
});
export interface AppConfig extends PublicSettings {
  server: { host: string; port: number; certPath: string; keyPath: string };
  bridge: { port: number; token: string };
  security: { pairCode: string; adminCode: string };
}
export function defaultConfig(): AppConfig {
  return {
    assistantName: 'Neo-MoFox', wakePhrase: '你好小墨',
    server: { host: '0.0.0.0', port: 8789, certPath: '', keyPath: '' },
    bridge: { port: 8788, token: randomBytes(32).toString('hex') },
    security: { pairCode: String(randomInt(100000, 1000000)), adminCode: randomBytes(8).toString('hex') },
    tts: { enabled: false, baseUrl: 'http://127.0.0.1:9880', timeoutMs: 120000, voice: { id: 'default', name: '默认声音', refAudioPath: '', promptText: '', promptLang: 'zh', textLang: 'zh', speed: 1 } },
    speech: { enabled: true, senseVoiceModel: '', tokens: '', kwsEncoder: '', kwsDecoder: '', kwsJoiner: '', kwsTokens: '', keywordsFile: '', silenceMs: 800, maxUtteranceMs: 30000 },
    live2d: { defaultModelId: '', coreReady: false, mapping: { mouthParameter: 'ParamMouthOpenY', emotions: {}, motions: {} } }
  };
}
export async function saveConfig(config: AppConfig): Promise<void> {
  await mkdir(path.dirname(LOCAL_CONFIG), { recursive: true });
  const temp = `${LOCAL_CONFIG}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, LOCAL_CONFIG);
}
export async function loadConfig(): Promise<AppConfig> {
  await mkdir(DATA, { recursive: true });
  try { await access(LOCAL_CONFIG); } catch { const config = defaultConfig(); await saveConfig(config); return config; }
  const raw = JSON.parse(await readFile(LOCAL_CONFIG, 'utf8')) as AppConfig;
  const settings = settingsSchema.parse(raw);
  if (!raw.bridge?.token || !raw.security?.pairCode || !raw.security?.adminCode) throw new Error('本机配置缺少桥接令牌或配对码，请运行 npm run setup。');
  if (!Number.isInteger(raw.server?.port) || raw.server.port < 1 || raw.server.port > 65535 || !Number.isInteger(raw.bridge.port) || raw.bridge.port < 1 || raw.bridge.port > 65535) throw new Error('配置端口无效');
  return { ...raw, ...settings };
}
export function publicSettings(config: AppConfig, admin: boolean, coreReady: boolean): PublicSettings {
  const settings = settingsSchema.parse(config);
  settings.live2d.coreReady = coreReady;
  if (!admin) {
    settings.tts.baseUrl = '';
    settings.tts.voice.refAudioPath = '';
    settings.tts.voice.promptText = '';
    for (const key of ['senseVoiceModel', 'tokens', 'kwsEncoder', 'kwsDecoder', 'kwsJoiner', 'kwsTokens', 'keywordsFile'] as const) settings.speech[key] = '';
  }
  return settings;
}
