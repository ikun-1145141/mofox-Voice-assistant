import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GsvTts } from '../apps/server/src/tts.js';
import { defaultConfig } from '../apps/server/src/config.js';
import { speechSegments } from '../apps/server/src/segments.js';

test('GSV requests remain serialized and cached audio belongs only to the initiating session', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'voice-tts-'));
  const config = defaultConfig(); config.tts.enabled = true; config.tts.voice.refAudioPath = path.join(directory, 'reference.wav');
  await writeFile(config.tts.voice.refAudioPath, 'reference');
  let active = 0, peak = 0; const requests: any[] = [];
  let releaseLong: (() => void) | undefined;
  let startedLong!: () => void;
  const longStarted = new Promise<void>(resolve => { startedLong = resolve; });
  const wav = Buffer.alloc(48); wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
  const upstream = createServer(async (request, response) => {
    if (request.url === '/openapi.json') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ paths: { '/tts': {} } })); return; }
    const body = []; for await (const chunk of request) body.push(chunk);
    const args = JSON.parse(Buffer.concat(body).toString()); requests.push(args);
    active++; peak = Math.max(peak, active);
    if (args.text === 'slow') await new Promise<void>(resolve => { releaseLong = resolve; startedLong(); });
    else await new Promise(resolve => setTimeout(resolve, 20));
    active--;
    response.setHeader('Content-Type', 'audio/wav'); response.end(args.text === 'bad' ? Buffer.from('not a WAV') : wav);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  config.tts.baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  t.after(async () => { releaseLong?.(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const tts = new GsvTts(() => config, directory);
  assert.equal((await tts.probe()).ready, true);
  const segments = speechSegments('第一句。第二句。', 'turn');
  await Promise.all(segments.map(segment => tts.synthesize(segment, 'device-a', new AbortController().signal)));
  assert.equal(peak, 1); assert.equal(requests[0].streaming_mode, false); assert.equal(requests[0].ref_audio_path, config.tts.voice.refAudioPath);
  assert.equal(await tts.resource(segments[0]!.segmentId, 'device-b'), null);
  const file = await tts.resource(segments[0]!.segmentId, 'device-a'); assert.ok(file); assert.deepEqual(await readFile(file), wav);
  await assert.rejects(tts.synthesize(speechSegments('bad', 'invalid')[0]!, 'device-a', new AbortController().signal), /有效 WAV/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(tts.synthesize(segments[0]!, 'device-a', abort.signal), { name: 'AbortError' });
  const long = tts.synthesize(speechSegments('slow', 'long')[0]!, 'device-a', new AbortController().signal);
  await longStarted;
  const queuedAbort = new AbortController();
  const queued = tts.synthesize(speechSegments('cancelled-queued', 'queue')[0]!, 'device-b', queuedAbort.signal);
  queuedAbort.abort();
  let deadline: ReturnType<typeof setTimeout>;
  try {
    await assert.rejects(Promise.race([queued, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('queued cancellation blocked')), 500); })]), { name: 'AbortError' });
  } finally { clearTimeout(deadline!); releaseLong!(); }
  await long;
  await tts.synthesize(speechSegments('after', 'after')[0]!, 'device-b', new AbortController().signal);
  assert.ok(!requests.some(row => row.text === 'cancelled-queued'));
});
