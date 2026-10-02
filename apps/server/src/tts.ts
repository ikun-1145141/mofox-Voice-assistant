import { access, mkdir, writeFile, stat, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from './config.js';
import type { ServiceHealth, SpeechSegment } from '@mofox/protocol';

export class GsvTts {
  private queue: Promise<void> = Promise.resolve();
  private waiting = 0;
  private cache = new Map<string, { path: string; sessionId: string; expires: number }>();
  private lastHealth: ServiceHealth = { ready: false, detail: '尚未检查 GSV' };
  constructor(private getConfig: () => AppConfig, private dataRoot: string) {}
  health(): ServiceHealth { return this.lastHealth; }
  async probe(): Promise<ServiceHealth> {
    const config = this.getConfig().tts;
    if (!config.enabled || !config.voice.refAudioPath) return this.lastHealth = { ready: false, detail: '请配置声音参考音频并启用 GSV' };
    try {
      await access(config.voice.refAudioPath);
      const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/openapi.json`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { paths?: Record<string, unknown> };
      if (!data.paths?.['/tts']) throw new Error('此接口未提供 GPT-SoVITS /tts');
      return this.lastHealth = { ready: true, detail: `${config.voice.name} · GSV 已就绪` };
    } catch (e) { return this.lastHealth = { ready: false, detail: `GSV 不可用：${(e as Error).message}` }; }
  }
  async synthesize(segment: SpeechSegment, sessionId: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.waiting >= 60) throw new Error('语音合成队列已满');
    this.waiting++;
    const work = this.queue.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      const config = this.getConfig().tts;
      if (!config.enabled || !config.voice.refAudioPath) throw new Error('尚未配置 GSV 参考音频');
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/tts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([signal, timeout]),
        body: JSON.stringify({ text: segment.text, text_lang: config.voice.textLang, ref_audio_path: config.voice.refAudioPath, prompt_text: config.voice.promptText, prompt_lang: config.voice.promptLang, speed_factor: config.voice.speed, media_type: 'wav', streaming_mode: false, batch_size: 1, text_split_method: 'cut5' })
      });
      if (!response.ok) { const error = (await response.text()).slice(0, 500); throw new Error(`GSV ${response.status}：${error}`); }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length < 44 || data.length > 30 * 1024 * 1024 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') throw new Error('GSV 返回的内容不是有效 WAV 音频');
      signal.throwIfAborted();
      const directory = path.join(this.dataRoot, 'audio-cache'); await mkdir(directory, { recursive: true });
      const file = path.join(directory, `${segment.segmentId}.wav`); await writeFile(file, data);
      this.cache.set(segment.segmentId, { path: file, sessionId, expires: Date.now() + 10 * 60 * 1000 });
      return `/api/audio/${segment.segmentId}`;
    }).finally(() => { this.waiting--; });
    this.queue = work.then(() => {}, () => {});
    // A device can stop its queued utterance immediately, even when another
    // device still owns the GSV request. The serial work skips it when reached.
    let aborted!: () => void;
    const cancellation = new Promise<never>((_, reject) => {
      aborted = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
    return Promise.race([work, cancellation]).finally(() => signal.removeEventListener('abort', aborted));
  }
  async resource(id: string, sessionId: string): Promise<string | null> {
    const entry = this.cache.get(id);
    if (!entry || entry.sessionId !== sessionId || entry.expires < Date.now()) return null;
    try { await stat(entry.path); return entry.path; } catch { return null; }
  }
  async clean(): Promise<void> {
    for (const [id, item] of this.cache) if (item.expires < Date.now()) { this.cache.delete(id); await unlink(item.path).catch(() => {}); }
    const directory = path.join(this.dataRoot, 'audio-cache');
    const entries = await readdir(directory).catch(() => [] as string[]);
    for (const name of entries) {
      if (!/^[a-f0-9-]{36}\.wav$/.test(name) || this.cache.has(name.slice(0, -4))) continue;
      const file = path.join(directory, name);
      const info = await stat(file).catch(() => null);
      if (info?.isFile() && info.mtimeMs < Date.now() - 10 * 60 * 1000) await unlink(file).catch(() => {});
    }
  }
}
