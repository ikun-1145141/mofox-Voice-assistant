import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AudioPreRoll, EnergySegmenter, pcm16ToFloat32 } from '../apps/server/src/speech/segmenter.js';
import { SpeechEngine } from '../apps/server/src/speech/index.js';
import type { SpeechConfig, WorkerRequest, WorkerResponse } from '../apps/server/src/speech/types.js';
import { writeKeywords } from '../apps/server/src/speech/keywords.js';

const config: SpeechConfig = {
  enabled: true, senseVoiceModel: '', tokens: '', kwsEncoder: '', kwsDecoder: '', kwsJoiner: '',
  kwsTokens: '', keywordsFile: '', silenceMs: 600, maxUtteranceMs: 20000,
};

test('PCM16 accepts an offset view and preserves signed little endian samples', () => {
  const bytes = Buffer.from([99, 0, 0x80, 0xff, 0x7f, 0, 0, 0, 0x40, 99]);
  assert.deepEqual([...pcm16ToFloat32(bytes.subarray(1, 9))], [-1, 32767 / 32768, 0, 0.5]);
  assert.throws(() => pcm16ToFloat32(new Uint8Array(1)), /偶数/);
});

test('energy endpointing waits for speech, then ends on exactly the configured silence', () => {
  const segmenter = new EnergySegmenter({ silenceMs: 600, maxUtteranceMs: 5000 });
  assert.equal(segmenter.push(new Float32Array(16000)), null);
  assert.equal(segmenter.push(new Float32Array(1600).fill(0.1)), null);
  assert.equal(segmenter.push(new Float32Array(9280)), null);
  const result = segmenter.push(new Float32Array(320));
  assert.ok(result);
  assert.equal(result.reason, 'silence');
  assert.equal(result.voiced, true);
  assert.equal(result.samples.length, 4800 + 1600 + 9600);
  assert.equal(segmenter.finish(), null);
});

test('20 ms segmentation behaves consistently across uneven client packets', () => {
  const segmenter = new EnergySegmenter({ silenceMs: 200, maxUtteranceMs: 5000 });
  assert.equal(segmenter.push(new Float32Array(133).fill(0.2)), null);
  assert.equal(segmenter.push(new Float32Array(187).fill(0.2)), null);
  assert.equal(segmenter.push(new Float32Array(3111)), null);
  const result = segmenter.push(new Float32Array(89));
  assert.equal(result?.samples.length, 3520);
  assert.equal(result?.reason, 'silence');
});

test('maximum utterance length and manual short-frame completion are bounded', () => {
  const bounded = new EnergySegmenter({ silenceMs: 200, maxUtteranceMs: 1000 });
  const result = bounded.push(new Float32Array(32000).fill(0.2));
  assert.equal(result?.samples.length, 16000);
  assert.equal(result?.reason, 'timeout');
  const short = new EnergySegmenter({ silenceMs: 600, maxUtteranceMs: 20000 });
  short.push(new Float32Array(80).fill(0.2));
  assert.equal(short.finish()?.voiced, true);
  const silent = new EnergySegmenter({ silenceMs: 600, maxUtteranceMs: 20000 });
  silent.push(new Float32Array(80));
  assert.equal(silent.finish()?.voiced, false);
});

test('pre-roll retains only the latest 300 ms without aliasing client buffers', () => {
  const history = new AudioPreRoll();
  const original = new Float32Array(3200).fill(0.1);
  history.push(original);
  original.fill(1);
  history.push(new Float32Array(3200).fill(0.2));
  const snapshot = history.take();
  assert.equal(snapshot.length, 4800);
  assert.ok(Math.abs(snapshot[0]! - 0.1) < 1e-6);
  assert.ok(Math.abs(snapshot[4799]! - 0.2) < 1e-6);
  history.clear();
  assert.equal(history.take().length, 0);
});

test('wake-word pre-roll alone never triggers recognition during the command wait', () => {
  const keywordTail = new Float32Array(4800).fill(0.2);
  const segmenter = new EnergySegmenter({ silenceMs: 800, maxUtteranceMs: 30000 }, keywordTail);
  assert.equal(segmenter.push(new Float32Array(16000)), null);
  const finished = segmenter.finish();
  assert.equal(finished?.voiced, false);
  assert.equal(finished?.samples.length, 0);
});

test('a command spoken after the wake prompt is recognized without retaining the old wake tail', () => {
  const keywordTail = new Float32Array(4800).fill(0.2);
  const segmenter = new EnergySegmenter({ silenceMs: 800, maxUtteranceMs: 30000 }, keywordTail);
  segmenter.push(new Float32Array(16000));
  segmenter.push(new Float32Array(1600).fill(0.1));
  const finished = segmenter.push(new Float32Array(12800));
  assert.ok(finished?.voiced);
  assert.equal(finished?.reason, 'silence');
  assert.equal(finished?.samples.length, 4800 + 1600 + 12800);
  assert.equal(Math.max(...finished!.samples.subarray(0, 4800)), 0);
  assert.ok(Math.max(...finished!.samples) < 0.11);
});

test('disabled speech does not produce fallback results or report ready', async () => {
  const engine = new SpeechEngine({ ...config, enabled: false }, '摩狐');
  await engine.ready;
  const events: string[] = [];
  const session = engine.createSession({
    onWake: () => events.push('wake'), onListening: () => events.push('listening'),
    onResult: () => events.push('result'), onError: (message) => events.push(message), onEnded: () => events.push('ended'),
  });
  session.start('manual');
  session.push(new Float32Array(16000).fill(0.2));
  session.finish();
  assert.deepEqual(events, ['本地语音识别已关闭', 'ended']);
  assert.equal(engine.health().asr.ready, false);
  await engine.close();
});

test('worker reports missing ASR and KWS model files accurately', async (t) => {
  const engine = new SpeechEngine(config, '摩狐');
  t.after(() => engine.close());
  await engine.ready;
  assert.equal(engine.health().asr.ready, false);
  assert.match(engine.health().asr.detail, /SenseVoice ONNX 未配置/);
  assert.equal(engine.health().kws.ready, false);
  assert.match(engine.health().kws.detail, /keywords.txt 未配置/);
  const snapshot = engine.health();
  snapshot.asr.ready = true;
  assert.equal(engine.health().asr.ready, false);
});

test('Chinese wake words match official ppinyin including zero initials, y/w and tone marks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mofox-keywords-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokens = join(root, 'tokens.txt');
  const output = join(root, 'generated', 'keywords.txt');
  const units = ['x', 'iǎo', 'ài', 't', 'óng', 'ué', 'n', 'ǐ', 'h', 'ǎo', 'm', 'ò', 'w', 'èn', 'y', 'ì'];
  await writeFile(tokens, units.map((unit, index) => `${unit} ${index}`).join('\n'));
  await writeKeywords('小爱同学', tokens, output);
  assert.equal(await readFile(output, 'utf8'), 'x iǎo ài t óng x ué @小爱同学\n');
  await writeKeywords('你好小墨', tokens, output);
  assert.equal(await readFile(output, 'utf8'), 'n ǐ h ǎo x iǎo m ò @你好小墨\n');
  await writeKeywords('小艺问问', tokens, output);
  assert.equal(await readFile(output, 'utf8'), 'x iǎo y ì w èn w èn @小艺问问\n');
});

test('unsupported wake phrases and token mismatches do not overwrite working keywords', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mofox-keywords-invalid-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokens = join(root, 'tokens.txt');
  const output = join(root, 'keywords.txt');
  await writeFile(tokens, 'x 1\niǎo 2\n');
  await writeFile(output, 'previous valid content\n');
  await assert.rejects(writeKeywords('Hello小墨', tokens, output), /仅支持/);
  await assert.rejects(writeKeywords('小墨\n@注入', tokens, output), /仅支持/);
  await assert.rejects(writeKeywords('小爱同学', tokens, output), /不在.*tokens/);
  assert.equal(await readFile(output, 'utf8'), 'previous valid content\n');
});

test('manual endpointing announces recognition and cancelled native results stay discarded', async (t) => {
  // Replace transport only in this unit test; production never supplies fallback ASR.
  const engine = new SpeechEngine({ ...config, enabled: false, silenceMs: 200 }, '你好小墨');
  t.after(() => engine.close());
  engine.health = () => ({ asr: { ready: true, detail: 'test transport' }, kws: { ready: true, detail: 'test transport' } });
  const requests: WorkerRequest[] = [];
  engine.send = (message) => { requests.push(message); };
  const events: string[] = [];
  const session = engine.createSession({
    onWake: () => events.push('wake'), onListening: () => events.push('listening'),
    onRecognizing: () => events.push('recognizing'), onResult: (text) => events.push(`result:${text}`),
    onError: (message) => events.push(`error:${message}`), onEnded: () => events.push('ended'),
  });
  session.start('manual');
  session.push(new Float32Array(320).fill(0.1));
  session.push(new Float32Array(3200));
  assert.deepEqual(events, ['listening', 'recognizing']);
  const first = requests.find((message) => message.type === 'asr.decode');
  assert.ok(first && first.type === 'asr.decode');
  session.stop();
  session.start('manual');
  const transportSession = session as typeof session & { receive(message: Exclude<WorkerResponse, { type: 'health' }>): void };
  transportSession.receive({ type: 'asr.result', sessionId: first.sessionId, utteranceId: first.utteranceId, text: 'stale result' });
  assert.deepEqual(events, ['listening', 'recognizing', 'ended', 'listening']);
  session.push(new Float32Array(320).fill(0.1));
  session.finish();
  const latest = requests.filter((message) => message.type === 'asr.decode').at(-1)!;
  assert.ok(latest.type === 'asr.decode');
  transportSession.receive({ type: 'asr.result', sessionId: latest.sessionId, utteranceId: latest.utteranceId, text: '今天的天气' });
  assert.equal(events.at(-2), 'result:今天的天气');
  assert.equal(events.at(-1), 'ended');
});

test('KWS listening waits for the remaining keyword tail and never submits a wake-only utterance', async (t) => {
  const engine = new SpeechEngine({ ...config, enabled: false, silenceMs: 800 }, '你好小墨');
  t.after(() => engine.close());
  engine.health = () => ({ asr: { ready: true, detail: 'test transport' }, kws: { ready: true, detail: 'test transport' } });
  const requests: WorkerRequest[] = [];
  engine.send = (message) => { requests.push(message); };
  const events: string[] = [];
  const session = engine.createSession({
    onWake: () => events.push('wake'), onListening: () => events.push('listening'),
    onRecognizing: () => events.push('recognizing'), onResult: () => events.push('result'),
    onError: (message) => events.push(`error:${message}`), onEnded: () => events.push('ended'),
  });
  session.start('kws');
  const start = requests.find((message) => message.type === 'kws.start');
  assert.ok(start?.type === 'kws.start');
  const transportSession = session as typeof session & { receive(message: Exclude<WorkerResponse, { type: 'health' }>): void };
  transportSession.receive({ type: 'wake', sessionId: start.sessionId, generation: start.generation, phrase: '你好小墨' });
  session.push(new Float32Array(4800).fill(0.2));
  assert.deepEqual(events, ['wake']);
  session.push(new Float32Array(1600));
  assert.deepEqual(events, ['wake']);
  session.push(new Float32Array(1280));
  assert.deepEqual(events, ['wake']);
  session.push(new Float32Array(320));
  assert.deepEqual(events, ['wake', 'listening']);
  session.push(new Float32Array(16000));
  assert.deepEqual(events, ['wake', 'listening']);
  assert.equal(requests.some((message) => message.type === 'asr.decode'), false);
  session.push(new Float32Array(1600).fill(0.1));
  session.push(new Float32Array(12800));
  assert.deepEqual(events, ['wake', 'listening', 'recognizing']);
  const decoded = requests.find((message) => message.type === 'asr.decode');
  assert.ok(decoded?.type === 'asr.decode');
  assert.ok(Math.max(...decoded.samples) < 0.11, 'wake tail must not enter the ASR command buffer');
});
