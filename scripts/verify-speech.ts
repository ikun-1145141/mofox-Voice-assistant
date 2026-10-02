import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { SpeechEngine } from '../apps/server/src/speech/index.js';
import { LOCAL_CONFIG, ROOT } from '../apps/server/src/config.js';
import type { AppConfig } from '../apps/server/src/config.js';

const { values } = parseArgs({ options: {
  wav: { type: 'string' }, keywords: { type: 'string' },
  mode: { type: 'string', default: 'manual' }, expect: { type: 'string' },
} });
if (!values.wav || !['manual', 'kws'].includes(values.mode!)) {
  throw new Error('用法：npx tsx scripts/verify-speech.ts --wav audio.wav --mode manual|kws [--keywords keywords.txt] [--expect 文字]');
}
const mode = values.mode as 'manual' | 'kws';
const config = JSON.parse(await readFile(LOCAL_CONFIG, 'utf8')) as AppConfig;
const native = createRequire(import.meta.url)('sherpa-onnx-node') as {
  readWave(filename: string): { samples: Float32Array; sampleRate: number };
};
const wave = native.readWave(path.resolve(ROOT, values.wav));
if (!wave.samples.length || wave.sampleRate < 8000 || wave.sampleRate > 192000) throw new Error('WAV 没有有效音频或采样率不支持');
if (wave.samples.length / wave.sampleRate > 60) throw new Error('验证 WAV 最长允许 60 秒');

/** Area averaging when downsampling, linear interpolation when upsampling. */
function to16k(input: Float32Array, rate: number): Float32Array {
  if (rate === 16000) return input;
  const ratio = rate / 16000;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index++) {
    const begin = index * ratio;
    if (ratio < 1) {
      const low = Math.floor(begin);
      const weight = begin - low;
      output[index] = input[low]! * (1 - weight) + (input[low + 1] ?? input[low]!) * weight;
    } else {
      const end = (index + 1) * ratio;
      let sum = 0;
      for (let cursor = Math.floor(begin); cursor < Math.ceil(end); cursor++) {
        sum += input[cursor]! * (Math.min(end, cursor + 1) - Math.max(begin, cursor));
      }
      output[index] = sum / ratio;
    }
  }
  return output;
}
const samples = to16k(wave.samples, wave.sampleRate);
const engine = new SpeechEngine({ ...config.speech,
  ...(values.keywords ? { keywordsFile: path.resolve(ROOT, values.keywords) } : {}) }, config.wakePhrase);
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([engine.ready, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('语音模型初始化超时')), 60000);
  })]);
  clearTimeout(timer);
  console.log(JSON.stringify({ stage: 'health', ...engine.health() }));
  if (!engine.health().asr.ready || (mode === 'kws' && !engine.health().kws.ready)) throw new Error('所需语音模型未就绪');
  let finished = false;
  let settle!: (result: string) => void;
  let fail!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => { settle = resolve; fail = reject; });
  // Attach before streaming so early errors never become unhandled rejections.
  const safeResult = result.catch((error: unknown) => { throw error; });
  let failure: Error | undefined;
  safeResult.catch((error: Error) => { failure = error; finished = true; });
  const session = engine.createSession({
    onWake: (phrase) => { if (mode === 'kws') { finished = true; settle(phrase); } },
    onListening: () => console.log(JSON.stringify({ stage: 'listening' })),
    onRecognizing: () => console.log(JSON.stringify({ stage: 'recognizing' })),
    onResult: (text) => { if (mode === 'manual') { finished = true; settle(text); } },
    onError: (message) => { finished = true; fail(new Error(message)); },
    onEnded: () => { if (mode === 'manual' && !finished) { finished = true; fail(new Error('音频没有可识别的语音')); } },
  });
  session.start(mode);
  for (let offset = 0; offset < samples.length + 16000 && !finished; offset += 320) {
    const chunk = offset < samples.length ? samples.slice(offset, offset + 320) : new Float32Array(320);
    // Match the browser transport: mono PCM16 at 16 kHz, then server normalization.
    for (let index = 0; index < chunk.length; index++) chunk[index] = Math.round(Math.max(-1, Math.min(32767 / 32768, chunk[index]!)) * 32768) / 32768;
    session.push(chunk);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  if (mode === 'manual') session.finish();
  timer = setTimeout(() => fail(new Error(mode === 'kws' ? '音频结束后仍未检出唤醒词' : '语音识别超时')), 15000);
  if (failure) throw failure;
  const text = await safeResult;
  session.stop();
  if (values.expect && !text.includes(values.expect)) throw new Error(`结果“${text}”未包含期望文字“${values.expect}”`);
  console.log(JSON.stringify({ stage: mode === 'kws' ? 'wake' : 'asr', text, inputSampleRate: wave.sampleRate }));
} finally {
  if (timer) clearTimeout(timer);
  await engine.close();
}
