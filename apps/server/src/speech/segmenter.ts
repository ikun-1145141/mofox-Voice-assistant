const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320;
const PRE_ROLL_SAMPLES = 4800;

export interface SegmenterOptions {
  silenceMs: number;
  maxUtteranceMs: number;
  /** RMS energy threshold. This is energy endpointing, not a neural VAD. */
  threshold?: number;
}
export interface SegmentedAudio { samples: Float32Array; reason: 'silence' | 'timeout' | 'manual'; voiced: boolean }

export function joinSamples(chunks: readonly Float32Array[]): Float32Array {
  const result = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/** Bounded 300 ms audio history, including partial frames. */
export class AudioPreRoll {
  private samples: Float32Array = new Float32Array();
  push(chunk: Float32Array): void {
    if (chunk.length >= PRE_ROLL_SAMPLES) this.samples = chunk.slice(-PRE_ROLL_SAMPLES);
    else {
      const keep = this.samples.subarray(Math.max(0, this.samples.length + chunk.length - PRE_ROLL_SAMPLES));
      this.samples = joinSamples([keep, chunk]);
    }
  }
  take(): Float32Array { return this.samples.slice(); }
  clear(): void { this.samples = new Float32Array(); }
}

/** Sample-count timing avoids client packet sizes or delivery jitter changing VAD. */
export class EnergySegmenter {
  private chunks: Float32Array[] = [];
  private pending: Float32Array = new Float32Array();
  private total = 0;
  private silence = 0;
  private voiced = false;
  private finished = false;
  private leading = new AudioPreRoll();
  readonly silenceSamples: number;
  readonly maximumSamples: number;
  readonly threshold: number;

  constructor(options: SegmenterOptions, preRoll: Float32Array = new Float32Array()) {
    this.silenceSamples = Math.max(3200, Math.min(80000, Math.round(options.silenceMs * SAMPLE_RATE / 1000)));
    this.maximumSamples = Math.max(16000, Math.min(960000, Math.round(options.maxUtteranceMs * SAMPLE_RATE / 1000)));
    this.threshold = options.threshold ?? 0.012;
    // Wake history may contain the keyword's final syllables. It can protect a
    // command's onset, but must never count as a newly spoken command itself.
    if (preRoll.length) this.leading.push(preRoll);
  }

  push(samples: Float32Array): SegmentedAudio | null {
    if (this.finished) return null;
    const chunk = joinSamples([this.pending, samples]);
    let cursor = 0;
    while (cursor + FRAME_SAMPLES <= chunk.length) {
      const frame = chunk.slice(cursor, cursor + FRAME_SAMPLES);
      this.acceptFrame(frame);
      cursor += FRAME_SAMPLES;
      if (this.total >= this.maximumSamples) return this.complete('timeout');
      if (this.voiced && this.silence >= this.silenceSamples) return this.complete('silence');
    }
    this.pending = chunk.slice(cursor);
    return null;
  }

  finish(): SegmentedAudio | null {
    if (this.finished) return null;
    if (this.pending.length) this.acceptFrame(this.pending);
    return this.complete('manual');
  }

  private acceptFrame(frame: Float32Array): void {
    this.total += frame.length;
    const rms = Math.sqrt(frame.reduce((sum, sample) => sum + sample * sample, 0) / frame.length);
    if (rms >= this.threshold) {
      if (!this.voiced) {
        const history = this.leading.take();
        if (history.length) this.chunks.push(history);
        this.leading.clear();
      }
      this.voiced = true;
      this.silence = 0;
    } else this.silence += frame.length;
    if (this.voiced) this.chunks.push(frame);
    else this.leading.push(frame);
  }

  private complete(reason: SegmentedAudio['reason']): SegmentedAudio {
    this.finished = true;
    const samples = joinSamples(this.chunks);
    this.chunks = [];
    this.pending = new Float32Array();
    this.leading.clear();
    return { samples, reason, voiced: this.voiced };
  }
}

export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 2) throw new Error('PCM16 音频帧的字节数必须为偶数');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768;
  return samples;
}
