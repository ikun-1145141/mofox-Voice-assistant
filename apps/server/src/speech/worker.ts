import { parentPort, workerData } from 'node:worker_threads';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { SpeechConfig, SpeechHealth, WorkerRequest, WorkerResponse } from './types.js';

interface NativeStream { acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void }
interface NativeRecognizer {
  createStream(): NativeStream;
  decode(stream: NativeStream): void;
  getResult(stream: NativeStream): { text: string };
}
interface NativeSpotter {
  createStream(): NativeStream;
  decode(stream: NativeStream): void;
  isReady(stream: NativeStream): boolean;
  getResult(stream: NativeStream): { keyword?: string };
  reset(stream: NativeStream): void;
}
interface NativeModule {
  OfflineRecognizer: new (config: unknown) => NativeRecognizer;
  KeywordSpotter: new (config: unknown) => NativeSpotter;
}

if (!parentPort) throw new Error('语音推理必须在 Worker 中执行');
const port = parentPort;
const config = workerData.config as SpeechConfig;
let recognizer: NativeRecognizer | undefined;
let spotter: NativeSpotter | undefined;
const streams = new Map<string, { stream: NativeStream; generation: number }>();
const send = (message: WorkerResponse): void => { port.postMessage(message); };
const detail = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function missing(paths: { name: string; value: string }[]): Promise<string[]> {
  const result: string[] = [];
  for (const item of paths) {
    if (!item.value.trim()) { result.push(`${item.name} 未配置`); continue; }
    try { if (!(await stat(item.value)).isFile()) result.push(`${item.name} 不是文件`); }
    catch { result.push(`${item.name} 文件不存在`); }
  }
  return result;
}

async function initialize(): Promise<void> {
  const health: SpeechHealth = { asr: { ready: false, detail: 'SenseVoice 未加载' }, kws: { ready: false, detail: '关键词模型未加载' } };
  const asrMissing = await missing([{ name: 'SenseVoice ONNX', value: config.senseVoiceModel }, { name: 'ASR tokens', value: config.tokens }]);
  const kwsMissing = await missing([
    { name: 'KWS encoder', value: config.kwsEncoder }, { name: 'KWS decoder', value: config.kwsDecoder },
    { name: 'KWS joiner', value: config.kwsJoiner }, { name: 'KWS tokens', value: config.kwsTokens },
    { name: 'keywords.txt', value: config.keywordsFile },
  ]);
  if (asrMissing.length) health.asr.detail = asrMissing.join('；');
  if (kwsMissing.length) health.kws.detail = kwsMissing.join('；');
  let native: NativeModule | undefined;
  if (!asrMissing.length || !kwsMissing.length) {
    try {
      // Lazy optional dependency: importing HTTP server never loads native models.
      native = createRequire(import.meta.url)('sherpa-onnx-node') as NativeModule;
      if (typeof native.OfflineRecognizer !== 'function' || typeof native.KeywordSpotter !== 'function') throw new Error('native API 不匹配');
    } catch (error) {
      const message = `无法加载 sherpa-onnx-node：${detail(error)}`;
      if (!asrMissing.length) health.asr.detail = message;
      if (!kwsMissing.length) health.kws.detail = message;
    }
  }
  if (native && !asrMissing.length) {
    try {
      recognizer = new native.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          senseVoice: { model: config.senseVoiceModel, language: '', useInverseTextNormalization: 1 },
          tokens: config.tokens, numThreads: 2, provider: 'cpu', debug: false,
        },
      });
      health.asr = { ready: true, detail: '本地 SenseVoice 已加载；16 kHz 单声道，能量静音断句' };
    } catch (error) { health.asr.detail = `SenseVoice 加载失败：${detail(error)}`; }
  }
  if (native && !kwsMissing.length) {
    try {
      spotter = new native.KeywordSpotter({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: config.kwsEncoder, decoder: config.kwsDecoder, joiner: config.kwsJoiner },
          tokens: config.kwsTokens, numThreads: 1, provider: 'cpu', debug: false,
        },
        maxActivePaths: 4, numTrailingBlanks: 1, keywordsScore: 1.5, keywordsThreshold: 0.25,
        keywordsFile: config.keywordsFile,
      });
      health.kws = { ready: true, detail: '本地关键词模型已加载；唤醒词以 keywords.txt 为准' };
    } catch (error) { health.kws.detail = `关键词模型加载失败：${detail(error)}`; }
  }
  port.on('message', (message: WorkerRequest) => {
    try {
      if (message.type === 'kws.stop') { streams.delete(message.sessionId); return; }
      if (message.type === 'kws.start') {
        if (!spotter) throw new Error(health.kws.detail);
        streams.set(message.sessionId, { stream: spotter.createStream(), generation: message.generation }); return;
      }
      if (message.type === 'kws.audio') {
        const entry = streams.get(message.sessionId);
        if (!entry || entry.generation !== message.generation || !spotter) return;
        const stream = entry.stream;
        stream.acceptWaveform({ sampleRate: 16000, samples: message.samples });
        while (spotter.isReady(stream)) {
          spotter.decode(stream);
          const keyword = spotter.getResult(stream).keyword;
          if (keyword) {
            spotter.reset(stream);
            streams.delete(message.sessionId);
            send({ type: 'wake', sessionId: message.sessionId, generation: message.generation, phrase: keyword });
            break;
          }
        }
        send({ type: 'kws.processed', sessionId: message.sessionId, generation: message.generation });
        return;
      }
      if (!recognizer) throw new Error(health.asr.detail);
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples: message.samples });
      recognizer.decode(stream);
      const text = recognizer.getResult(stream).text.replace(/<\|[^|]+\|>/g, '').trim();
      send({ type: 'asr.result', sessionId: message.sessionId, utteranceId: message.utteranceId, text });
    } catch (error) {
      send({ type: 'error', sessionId: message.sessionId,
        ...('utteranceId' in message ? { utteranceId: message.utteranceId } : {}),
        ...('generation' in message ? { generation: message.generation } : {}), message: detail(error) });
    }
  });
  send({ type: 'health', health });
}

initialize().catch((error: unknown) => {
  const message = `语音引擎初始化失败：${detail(error)}`;
  send({ type: 'health', health: { asr: { ready: false, detail: message }, kws: { ready: false, detail: message } } });
});
