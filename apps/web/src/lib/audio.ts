import type { ClientEvent, SpeechSegment } from '@mofox/protocol';
import workletUrl from './pcm-worklet.js?url';

type Sender = (event: ClientEvent | ArrayBuffer) => boolean;

export class MicrophoneCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private sequence = 0;
  private pendingStop: (() => void) | null = null;
  private generation = 0;
  private captureMode: 'manual' | 'kws' = 'manual';
  active = false;
  paused = false;

  constructor(private send: Sender) {}

  async start(mode: 'manual' | 'kws'): Promise<void> {
    if (this.active) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('麦克风需要 HTTPS 或本机 localhost。其他设备请使用服务提供的 HTTPS 地址。');
    }
    const generation = ++this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true
    } });
    if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    try {
      this.context = new AudioContext();
      await this.context.resume();
      await this.context.audioWorklet.addModule(workletUrl);
      if (generation !== this.generation) return;
      this.node = new AudioWorkletNode(this.context, 'pcm-capture');
      this.sequence = 0;
      this.captureMode = mode;
      this.node.port.onmessage = event => {
        if (event.data === 'stopped') { this.pendingStop?.(); return; }
        if (!(event.data instanceof ArrayBuffer) || this.paused) return;
        const pcm = new Int16Array(event.data);
        const packet = new ArrayBuffer(4 + pcm.length * 2);
        const view = new DataView(packet);
        view.setUint32(0, this.sequence++, true);
        for (let i = 0; i < pcm.length; i++) view.setInt16(4 + i * 2, pcm[i], true);
        this.send(packet);
      };
      if (!this.send({ type: 'listen.start', mode }) || !this.send({ type: 'audio.start', sampleRate: 16000, format: 'pcm_s16le' })) {
        throw new Error('连接已断开，请重新连接后再开始录音。');
      }
      this.active = true;
      const source = this.context.createMediaStreamSource(stream);
      // Remove frequencies above the 16 kHz stream's Nyquist range before
      // decimation. Two Web Audio biquads provide a stable fourth-order filter.
      const lowpassA = this.context.createBiquadFilter();
      const lowpassB = this.context.createBiquadFilter();
      for (const filter of [lowpassA, lowpassB]) {
        filter.type = 'lowpass';
        filter.frequency.value = Math.min(7000, this.context.sampleRate * 0.43);
        filter.Q.value = Math.SQRT1_2;
      }
      source.connect(lowpassA).connect(lowpassB).connect(this.node);
      // An output connection keeps the worklet processing. The processor outputs silence.
      this.node.connect(this.context.destination);
    } catch (error) {
      await this.release();
      throw error;
    }
  }

  async stop(notify = true, discard = false): Promise<void> {
    ++this.generation;
    if (this.node && this.active) {
      await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout>;
        this.pendingStop = () => { clearTimeout(timer); resolve(); };
        timer = setTimeout(resolve, 250);
        this.node?.port.postMessage('stop');
      });
    }
    this.pendingStop = null;
    if (notify && this.active) {
      // audio.end submits a manual utterance for recognition. listen.stop
      // cancels the speech session, so sending both would discard that result.
      this.send({ type: discard || this.captureMode === 'kws' ? 'listen.stop' : 'audio.end' });
    }
    await this.release();
  }

  private async release(): Promise<void> {
    this.active = false;
    this.paused = false;
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') await context.close();
  }
}

interface QueueItem { segment: SpeechSegment; url: string }

export class SpeechPlayback {
  private context: AudioContext | null = null;
  private analyzer: AnalyserNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private queue: QueueItem[] = [];
  private seen = new Set<string>();
  private expected = new Map<string, number>();
  private running = false;
  private generation = 0;
  private abort: AbortController | null = null;
  private raf = 0;
  private onResumeQueue: (() => void) | null = null;

  constructor(
    private send: Sender,
    private performance: (segment: SpeechSegment) => void,
    private amplitude: (value: number) => void,
    private report: (message: string) => void,
    private activity: (active: boolean) => void
  ) {}

  async unlock(): Promise<void> {
    if (!this.context || this.context.state === 'closed') this.context = new AudioContext();
    await this.context.resume();
    this.onResumeQueue?.();
  }

  add(segment: SpeechSegment, url: string): void {
    if (this.seen.has(segment.segmentId)) return;
    this.seen.add(segment.segmentId);
    if (!this.expected.has(segment.turnId)) this.expected.set(segment.turnId, 0);
    this.queue.push({ segment, url });
    void this.pump();
  }

  stop(notify = true): void {
    const wasActive = this.running || this.queue.length > 0 || this.source !== null;
    this.generation++;
    this.queue = [];
    this.abort?.abort();
    this.source?.stop();
    this.source = null;
    cancelAnimationFrame(this.raf);
    this.amplitude(0);
    this.activity(false);
    if (notify && wasActive) this.send({ type: 'playback.stopped' });
    this.onResumeQueue?.();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    try {
      while (this.queue.length && generation === this.generation) {
        const first = this.queue[0];
        const index = this.queue.findIndex(item => item.segment.turnId === first.segment.turnId && item.segment.index === this.expected.get(first.segment.turnId));
        if (index < 0) break;
        const item = this.queue.splice(index, 1)[0];
        this.abort = new AbortController();
        const response = await fetch(item.url, { signal: this.abort.signal, credentials: 'same-origin' });
        if (!response.ok) throw new Error(`语音资源无法读取 (${response.status})`);
        if (!this.context) this.context = new AudioContext();
        const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
        if (generation !== this.generation) break;
        if (this.context.state === 'suspended') {
          this.report('浏览器已暂停声音，请点击「启用声音」后继续播放。');
          await new Promise<void>(resolve => { this.onResumeQueue = resolve; });
          this.onResumeQueue = null;
        }
        if (generation !== this.generation) break;
        if (item.segment.waitBeforeMs) await new Promise(resolve => setTimeout(resolve, item.segment.waitBeforeMs));
        if (generation !== this.generation) break;
        this.performance(item.segment);
        this.source = this.context.createBufferSource();
        this.analyzer = this.context.createAnalyser();
        this.analyzer.fftSize = 256;
        this.source.buffer = buffer;
        this.source.connect(this.analyzer);
        this.analyzer.connect(this.context.destination);
        this.activity(true);
        this.send({ type: 'playback.started', segmentId: item.segment.segmentId });
        const samples = new Float32Array(this.analyzer.fftSize);
        const sampleAmplitude = () => {
          if (!this.analyzer || generation !== this.generation) return;
          this.analyzer.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
          this.amplitude(Math.min(1, rms * 7));
          this.raf = requestAnimationFrame(sampleAmplitude);
        };
        this.raf = requestAnimationFrame(sampleAmplitude);
        await new Promise<void>(resolve => {
          if (!this.source) { resolve(); return; }
          this.source.onended = () => resolve();
          this.source.start();
        });
        cancelAnimationFrame(this.raf);
        this.amplitude(0);
        this.activity(false);
        if (generation !== this.generation) break;
        this.source?.disconnect();
        this.analyzer?.disconnect();
        this.source = null;
        this.send({ type: 'playback.finished', segmentId: item.segment.segmentId });
        this.expected.set(item.segment.turnId, item.segment.index + 1);
      }
    } catch (error) {
      if (generation === this.generation) {
        this.report(error instanceof Error ? error.message : '语音播放失败');
        this.send({ type: 'playback.stopped' });
        this.queue = [];
      }
    } finally {
      this.running = false;
      this.activity(false);
      this.amplitude(0);
      // New audio could have arrived during cancellation of the previous pump.
      if (generation !== this.generation && this.queue.length) void this.pump();
    }
  }

  async dispose(): Promise<void> {
    this.stop(false);
    if (this.context?.state !== 'closed') await this.context?.close();
  }
}
