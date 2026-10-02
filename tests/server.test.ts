import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createApplication } from '../apps/server/src/main.js';
import { defaultConfig } from '../apps/server/src/config.js';
import { speechSegments, displayText } from '../apps/server/src/segments.js';

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
class Inbox {
  all: any[] = [];
  private waiting: { type: string; resolve: (value: any) => void }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString()); this.all.push(event);
      const i = this.waiting.findIndex(wait => wait.type === event.type);
      if (i >= 0) this.waiting.splice(i, 1)[0]!.resolve(event);
    });
  }
  next(type: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`没有收到 ${type}`)), 3000);
      this.waiting.push({ type, resolve: value => { clearTimeout(timer); resolve(value); } });
    });
  }
  send(event: unknown) { this.ws.send(JSON.stringify(event)); }
}

test('performance segments preserve ordered waits and suppress markup from speech', () => {
  const rows = speechSegments('[emotion:happy]你好！[wait:0.3][motion:wave]再见。[/emotion]第三句。', 'turn', 4);
  assert.deepEqual(rows.map(row => [row.index, row.text, row.emotion, row.motion, row.waitBeforeMs]), [
    [4, '你好！', 'happy', null, 0], [5, '再见。', 'happy', 'wave', 300], [6, '第三句。', null, 'wave', 0]
  ]);
  assert.equal(displayText('[emotion:happy]你好。[/emotion]'), '你好。');
  assert.ok(speechSegments('```ts\nprivate key\n```', 't').every(row => !row.text.includes('private key')));
});

test('pairing protects configuration and rejects cross-origin writes', async t => {
  const data = await mkdtemp(path.join(tmpdir(), 'voice-server-'));
  const config = defaultConfig(); config.speech.enabled = false; config.bridge.port = await freePort();
  const { app } = await createApplication(config, data);
  t.after(async () => { await app.close(); await rm(data, { recursive: true, force: true }); });
  assert.equal((await app.inject({ url: '/api/settings' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/pair', headers: { origin: 'https://foreign.example' }, payload: { code: config.security.pairCode } })).statusCode, 403);
  const paired = await app.inject({ method: 'POST', url: '/api/pair', payload: { code: config.security.pairCode } });
  assert.equal(paired.statusCode, 200);
  const cookie = paired.cookies[0]!.value;
  const headers = { cookie: `assistant_session=${cookie}` };
  const settings = (await app.inject({ url: '/api/settings', headers })).json();
  assert.equal(settings.tts.baseUrl, ''); assert.equal(settings.tts.voice.refAudioPath, '');
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: config })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/audio/not-a-file', headers })).statusCode, 404);
});

test('two devices cannot receive each other’s bot replies; cancellation keeps ownership until terminal', async t => {
  const data = await mkdtemp(path.join(tmpdir(), 'voice-bridge-'));
  const config = defaultConfig(); config.speech.enabled = false; config.tts.enabled = false; config.bridge.port = await freePort();
  const { app, sessions } = await createApplication(config, data);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const sockets: WebSocket[] = [];
  t.after(async () => { sockets.forEach(socket => socket.terminate()); await app.close(); await rm(data, { recursive: true, force: true }); });
  async function device() {
    const pair = await app.inject({ method: 'POST', url: '/api/pair', payload: { code: config.security.pairCode } });
    const ws = new WebSocket(address.replace('http', 'ws') + '/ws', { headers: { cookie: `assistant_session=${pair.cookies[0]!.value}` } }); sockets.push(ws);
    const inbox = new Inbox(ws); const ready = inbox.next('session.ready'); await once(ws, 'open'); await ready; return inbox;
  }
  const neoWs = new WebSocket(`ws://127.0.0.1:${config.bridge.port}/bridge`, { headers: { Authorization: `Bearer ${config.bridge.token}` } }); sockets.push(neoWs);
  const neo = new Inbox(neoWs); const hello = neo.next('bridge.hello'); await once(neoWs, 'open'); await hello;
  neo.send({ type: 'bridge.ready', version: 1, botName: '测试核心', capabilities: ['text', 'turn-completion'] });
  const a = await device(), b = await device();
  const sent = neo.next('chat.submit'), thinking = a.next('state.changed');
  a.send({ type: 'text.submit', text: '第一台设备', submissionId: 'submit-1' });
  const turn = await sent; await thinking;
  assert.equal(turn.userId, `voice:${turn.sessionId}`);
  const received = a.next('bot.message');
  neo.send({ type: 'bot.message', sessionId: turn.sessionId, turnId: turn.turnId, messageId: 'reply-1', text: '当前设备的回复' });
  assert.equal((await received).text, '当前设备的回复');
  const cancelled = neo.next('chat.cancel'), failed = a.next('turn.failed'); a.send({ type: 'turn.cancel' }); await cancelled; await failed;
  const busy = a.next('error'); a.send({ type: 'text.submit', text: '重复的下一轮', submissionId: 'submit-2' });
  assert.equal((await busy).code, 'busy');
  const idle = a.next('state.changed');
  neo.send({ type: 'bot.message', sessionId: turn.sessionId, turnId: turn.turnId, messageId: 'late', text: '迟到内容' });
  neo.send({ type: 'turn.completed', sessionId: turn.sessionId, turnId: turn.turnId }); await idle;
  const next = neo.next('chat.submit'); a.send({ type: 'text.submit', text: '新的一轮', submissionId: 'submit-2' }); await next;
  assert.equal(a.all.filter(event => event.type === 'bot.message').length, 1);
  assert.equal(b.all.filter(event => event.type === 'bot.message').length, 0);
  a.send({ type: 'text.submit', text: '同一提交重发', submissionId: 'submit-2' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(neo.all.filter(event => event.type === 'chat.submit').length, 2);
  const renewed = a.next('session.ready'); neoWs.terminate();
  const reset = await renewed;
  assert.notEqual(reset.data.sessionId, turn.sessionId);
  const owner = [...sessions.all()].find(session => session.id === reset.data.sessionId);
  assert.ok(owner); assert.equal(owner.turn, null);
});

test('opening a second page retires audio that only the first page could acknowledge', async t => {
  const data = await mkdtemp(path.join(tmpdir(), 'voice-tab-'));
  const config = defaultConfig(); config.speech.enabled = false; config.bridge.port = await freePort();
  const { app, sessions } = await createApplication(config, data);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const { token, session } = await sessions.create(false);
  const sockets: WebSocket[] = [];
  t.after(async () => { sockets.forEach(socket => socket.terminate()); await app.close(); await rm(data, { recursive: true, force: true }); });
  async function page() {
    const ws = new WebSocket(address.replace('http', 'ws') + '/ws', { headers: { cookie: `assistant_session=${token}` } }); sockets.push(ws);
    const inbox = new Inbox(ws); const ready = inbox.next('session.ready'); await once(ws, 'open'); await ready; return inbox;
  }
  await page();
  const abort = new AbortController();
  session.turn = { id: 'finished-core', submissionId: 'input', cancelled: false, coreFinished: true, pendingSynthesis: 0, pendingPlayback: new Set(['old-audio']), abort, timeout: null };
  await page();
  assert.equal(abort.signal.aborted, true);
  assert.equal(session.turn, null);
});
