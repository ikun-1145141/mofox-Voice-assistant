import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { AudioPreRoll, EnergySegmenter, joinSamples } from './segmenter.js';
import type { SegmentedAudio } from './segmenter.js';
import type { ListenMode, SpeechCallbacks, SpeechConfig, SpeechHealth, SpeechSession, WorkerRequest, WorkerResponse } from './types.js';
export { pcm16ToFloat32 } from './segmenter.js';
export type { SpeechCallbacks, SpeechConfig, SpeechHealth, SpeechSession } from './types.js';

/** Models are shared, while each socket owns its own wake stream and audio state. */
export class SpeechEngine {
  private worker?: Worker;
  private status: SpeechHealth;
  private sessions = new Map<string, SocketSpeechSession>();
  private closed = false;
  readonly ready: Promise<void>;

  constructor(readonly config: SpeechConfig, readonly wakePhrase: string) {
    const detail = config.enabled ? '本地语音引擎初始化中' : '本地语音识别已关闭';
    this.status = { asr: { ready: false, detail }, kws: { ready: false, detail } };
    if (!config.enabled) { this.ready = Promise.resolve(); return; }
    let resolveReady!: () => void;
    this.ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    try {
      const sourceMode = import.meta.url.endsWith('.ts');
      const url = new URL(sourceMode ? './worker.ts' : './speech/worker.js', import.meta.url);
      if (sourceMode) {
        // tsx's CLI loader is not inherited reliably by TS worker entrypoints.
        // tsImport explicitly registers the TypeScript loader inside the worker.
        this.worker = new Worker(
          `import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)})).catch(error => { throw error; });`,
          { eval: true, workerData: { config }, execArgv: [] },
        );
      } else this.worker = new Worker(url, { workerData: { config }, execArgv: [] });
      this.worker.on('message', (message: WorkerResponse) => {
        if (message.type === 'health') { this.status = message.health; resolveReady(); return; }
        this.sessions.get(message.sessionId)?.receive(message);
      });
      this.worker.on('error', (error) => { this.fail(`语音 Worker 失败：${error.message}`); resolveReady(); });
      this.worker.on('exit', (code) => {
        if (!this.closed) this.fail(`语音 Worker 已退出（${code}）`);
        resolveReady();
      });
    } catch (error) {
      this.fail(`无法启动本地语音 Worker：${error instanceof Error ? error.message : String(error)}`);
      resolveReady();
    }
  }

  health(): SpeechHealth { return structuredClone(this.status); }

  createSession(callbacks: SpeechCallbacks): SpeechSession {
    const id = randomUUID();
    const session = new SocketSpeechSession(this, id, callbacks);
    return session;
  }

  /** Called when server settings change or the server shuts down. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
    const worker = this.worker;
    this.worker = undefined;
    const detail = '本地语音引擎已关闭';
    this.status = { asr: { ready: false, detail }, kws: { ready: false, detail } };
    if (worker) await worker.terminate();
  }

  send(message: WorkerRequest): void {
    if (!this.worker || this.closed) return;
    if ('samples' in message) this.worker.postMessage(message, [message.samples.buffer as ArrayBuffer]);
    else this.worker.postMessage(message);
  }

  release(id: string): void { this.sessions.delete(id); }
  register(id: string, session: SocketSpeechSession): void { this.sessions.set(id, session); }

  private fail(detail: string): void {
    this.status = { asr: { ready: false, detail }, kws: { ready: false, detail } };
    for (const session of this.sessions.values()) session.failure(detail);
  }
}

class SocketSpeechSession implements SpeechSession {
  private mode?: ListenMode;
  private phase: 'idle' | 'standby' | 'wake-settling' | 'listening' | 'recognizing' = 'idle';
  private segmenter?: EnergySegmenter;
  private history = new AudioPreRoll();
  private utteranceId = 0;
  private generation = 0;
  private kwsInFlight = false;
  private kwsBuffered: Float32Array = new Float32Array();
  private settlingPending: Float32Array = new Float32Array();
  private settlingSilence = 0;
  private timeout?: ReturnType<typeof setTimeout>;

  constructor(private engine: SpeechEngine, private id: string, private callbacks: SpeechCallbacks) {}

  start(mode: ListenMode): void {
    this.cancel(false);
    const health = this.engine.health();
    if (!health.asr.ready || (mode === 'kws' && !health.kws.ready)) {
      this.callbacks.onError(!health.asr.ready ? health.asr.detail : health.kws.detail);
      this.callbacks.onEnded();
      return;
    }
    this.mode = mode;
    this.engine.register(this.id, this);
    if (mode === 'kws') this.armWake();
    else this.listen();
  }

  push(samples: Float32Array): void {
    if (!this.mode || this.phase === 'idle' || this.phase === 'recognizing') return;
    if (!samples.length) return;
    if (samples.length > 32000) { this.failure('音频帧过大，单帧最多 2 秒'); return; }
    const normalized = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index++) {
      const value = samples[index]!;
      if (!Number.isFinite(value)) { this.failure('音频包含无效采样值'); return; }
      normalized[index] = Math.max(-1, Math.min(1, value));
    }
    if (this.phase === 'standby') {
      this.history.push(normalized);
      if (this.kwsInFlight) {
        if (this.kwsBuffered.length + normalized.length > 32000) { this.failure('唤醒处理积压超过 2 秒，请降低同时监听设备数量'); return; }
        this.kwsBuffered = joinSamples([this.kwsBuffered, normalized]);
      } else this.sendWakeAudio(normalized);
    } else if (this.phase === 'wake-settling') this.settleWake(normalized);
    else {
      const finished = this.segmenter?.push(normalized);
      if (finished) this.decode(finished);
    }
  }

  finish(): void {
    if (this.phase === 'listening') {
      const result = this.segmenter?.finish();
      if (result) this.decode(result);
    } else if (this.phase === 'standby' || this.phase === 'wake-settling') this.stop();
  }

  stop(): void { this.cancel(true); }

  receive(message: Exclude<WorkerResponse, { type: 'health' }>): void {
    if ('generation' in message && message.generation !== undefined && message.generation !== this.generation) return;
    if (message.type === 'kws.processed') {
      this.kwsInFlight = false;
      if (this.phase === 'standby' && this.kwsBuffered.length) {
        const buffered = this.kwsBuffered;
        this.kwsBuffered = new Float32Array();
        this.sendWakeAudio(buffered);
      }
      return;
    }
    if (message.type === 'wake') {
      if (this.phase !== 'standby') return;
      this.callbacks.onWake(message.phrase || this.engine.wakePhrase);
      this.phase = 'wake-settling';
      this.history.clear();
      this.kwsInFlight = false;
      this.kwsBuffered = new Float32Array();
      this.settlingPending = new Float32Array();
      this.settlingSilence = 0;
      // Wait for the keyword's remaining audio to end before announcing that
      // the command can start. First release supports wake, pause, then speak.
      this.timeout = setTimeout(() => this.endUtterance(), 5000);
      this.timeout.unref();
      return;
    }
    if ('utteranceId' in message && message.utteranceId !== undefined && message.utteranceId !== this.utteranceId) return;
    if (message.type === 'error') { if (this.phase !== 'idle') this.failure(message.message); return; }
    if (this.phase !== 'recognizing') return;
    let text = message.text;
    if (this.mode === 'kws' && this.engine.wakePhrase && text.startsWith(this.engine.wakePhrase)) {
      text = text.slice(this.engine.wakePhrase.length).replace(/^[，。！？,!?\s]+/, '').trim();
    }
    if (text) this.callbacks.onResult(text);
    this.endUtterance();
  }

  failure(message: string): void {
    const active = this.phase !== 'idle';
    this.cancel(false);
    if (active) { this.callbacks.onError(message); this.callbacks.onEnded(); }
  }

  private listen(preRoll: Float32Array = new Float32Array()): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.phase = 'listening';
    this.segmenter = new EnergySegmenter(this.engine.config, preRoll);
    this.callbacks.onListening();
    // A stalled/disconnected audio producer must not leave a session listening forever.
    this.timeout = setTimeout(() => this.finish(), Math.max(1000, Math.min(60000, this.engine.config.maxUtteranceMs)) + 1000);
    this.timeout.unref();
  }

  private settleWake(samples: Float32Array): void {
    const chunk = joinSamples([this.settlingPending, samples]);
    let cursor = 0;
    while (cursor + 320 <= chunk.length) {
      const frame = chunk.subarray(cursor, cursor + 320);
      const rms = Math.sqrt(frame.reduce((sum, sample) => sum + sample * sample, 0) / 320);
      this.settlingSilence = rms < 0.012 ? this.settlingSilence + 320 : 0;
      cursor += 320;
      if (this.settlingSilence >= 3200) {
        this.settlingPending = new Float32Array();
        // Seed no keyword audio into ASR. A command beginning later in this
        // same network packet is retained after the confirmed quiet boundary.
        this.listen();
        const finished = this.segmenter?.push(chunk.subarray(cursor));
        if (finished) this.decode(finished);
        return;
      }
    }
    this.settlingPending = chunk.slice(cursor);
  }

  private armWake(): void {
    this.phase = 'standby';
    this.history.clear();
    this.generation++;
    this.kwsInFlight = false;
    this.kwsBuffered = new Float32Array();
    this.settlingPending = new Float32Array();
    this.settlingSilence = 0;
    this.engine.send({ type: 'kws.start', sessionId: this.id, generation: this.generation });
  }

  private sendWakeAudio(samples: Float32Array): void {
    this.kwsInFlight = true;
    this.engine.send({ type: 'kws.audio', sessionId: this.id, generation: this.generation, samples });
  }

  private decode(result: SegmentedAudio): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    this.segmenter = undefined;
    if (!result.voiced || !result.samples.length) { this.endUtterance(); return; }
    this.phase = 'recognizing';
    this.callbacks.onRecognizing?.();
    this.engine.send({ type: 'asr.decode', sessionId: this.id, utteranceId: ++this.utteranceId, samples: result.samples });
  }

  private endUtterance(): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    if (this.mode === 'kws') this.armWake();
    else { this.mode = undefined; this.phase = 'idle'; this.engine.release(this.id); }
    this.callbacks.onEnded();
  }

  private cancel(notify: boolean): void {
    const active = this.phase !== 'idle';
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    this.utteranceId++;
    this.generation++;
    this.engine.send({ type: 'kws.stop', sessionId: this.id });
    this.mode = undefined;
    this.phase = 'idle';
    this.segmenter = undefined;
    this.history.clear();
    this.kwsInFlight = false;
    this.kwsBuffered = new Float32Array();
    this.settlingPending = new Float32Array();
    this.settlingSilence = 0;
    this.engine.release(this.id);
    if (notify && active) this.callbacks.onEnded();
  }
}
