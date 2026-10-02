import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { clientEventSchema, type ServerEvent, type StatusResponse, type BridgeEvent, type SpeechSegment } from '@mofox/protocol';
import { DATA, ROOT, loadConfig, saveConfig, settingsSchema, publicSettings, type AppConfig } from './config.js';
import { SessionStore, equalSecret, type Session, type Turn } from './sessions.js';
import { NeoBridge } from './bridge.js';
import { GsvTts } from './tts.js';
import { displayText, speechSegments } from './segments.js';
import { ModelStore } from './models.js';
import { SpeechEngine } from './speech/index.js';
import { writeKeywords } from './speech/keywords.js';

export async function createApplication(initialConfig: AppConfig, dataRoot = DATA) {
  let config = initialConfig;
  const tls = config.server.certPath && config.server.keyPath
    ? { cert: await readFile(config.server.certPath), key: await readFile(config.server.keyPath) } : undefined;
  const app = Fastify({ logger: true, bodyLimit: 1048576, ...(tls ? { https: tls } : {}) }) as FastifyInstance;
  await app.register(cookie);
  await app.register(multipart, { limits: { files: 1, fileSize: 100 * 1024 * 1024 } });
  await app.register(websocket, { options: { maxPayload: 16000 } });
  const sessions = new SessionStore(dataRoot); await sessions.load();
  const models = new ModelStore(dataRoot);
  const tts = new GsvTts(() => config, dataRoot);
  let speech = new SpeechEngine(config.speech, config.wakePhrase);
  let shuttingDown = false;
  const peers = new Map<string, WebSocket>();
  const resumeWake = new Map<string, () => void>();
  const pairAttempts = new Map<string, { count: number; reset: number }>();
  const nextIndex = new Map<string, number>();
  const seenReplies = new Set<string>();
  const corePath = path.join(dataRoot, 'vendor/live2dcubismcore.min.js');
  const coreExists = async () => { try { await access(corePath); return true; } catch { return false; } };
  async function sendSessionReady(session: Session) {
    session.send({ type: 'session.ready', data: { sessionId: session.id, clientId: session.clientId, admin: session.admin, settings: publicSettings(config, session.admin, await coreExists()), models: await models.list() } });
  }

  async function status(session?: Session): Promise<StatusResponse> {
    const health = speech.health();
    const core = await coreExists();
    return { name: config.assistantName, version: '0.1.0', secure: !!tls, authenticated: !!session, admin: session?.admin ?? false,
      bridge: { ready: bridge.ready, detail: bridge.detail }, tts: tts.health(), speech: health.asr, kws: health.kws,
      live2dCore: { ready: core, detail: core ? 'Cubism Core 已就绪' : '请在设置中导入官方 Cubism Core' }, models: (await models.list()).length };
  }
  async function broadcastStatus() {
    if (shuttingDown) return;
    for (const session of sessions.all()) session.send({ type: 'status.changed', data: await status(session) });
  }
  function maybeFinished(session: Session, turn: Turn) {
    if (session.turn !== turn || !turn.coreFinished || turn.pendingSynthesis !== 0 || turn.pendingPlayback.size !== 0) return;
    session.turn = null;
    nextIndex.delete(turn.id);
    if (turn.timeout) clearTimeout(turn.timeout);
    session.send({ type: 'state.changed', state: 'idle' });
    resumeWake.get(session.tokenHash)?.();
  }
  function failPlayback(session: Session, turn: Turn, message: string) {
    turn.cancelled = true; turn.abort.abort(); turn.pendingPlayback.clear();
    session.send({ type: 'turn.failed', turnId: turn.id, message });
    session.send({ type: 'state.changed', state: 'error', detail: message });
    bridge.send({ type: 'chat.cancel', sessionId: session.id, turnId: turn.id });
    maybeFinished(session, turn);
  }
  async function synthesize(session: Session, turn: Turn, segment: SpeechSegment) {
    if (turn.cancelled) return;
    turn.pendingSynthesis++;
    session.send({ type: 'performance.segment', segment });
    session.send({ type: 'state.changed', state: 'synthesizing', turnId: turn.id });
    try {
      const url = await tts.synthesize(segment, session.id, turn.abort.signal);
      if (turn.cancelled || session.turn !== turn) return;
      turn.pendingPlayback.add(segment.segmentId);
      session.send({ type: 'audio.ready', segment, url });
    } catch (e) { if (!turn.cancelled) failPlayback(session, turn, `语音合成失败：${(e as Error).message}`); }
    finally { turn.pendingSynthesis--; maybeFinished(session, turn); }
  }
  function onBridgeEvent(event: BridgeEvent) {
    if (event.type === 'bridge.ready' || event.type === 'chat.accepted') return;
    if (event.type === 'bridge.error') { for (const session of sessions.all()) session.send({ type: 'error', code: 'bridge', message: event.message }); return; }
    const session = [...sessions.all()].find(row => row.id === event.sessionId);
    const turn = session?.turn;
    if (!session || !turn || turn.id !== event.turnId) return;
    if (event.type === 'bot.message') {
      const unique = `${session.id}:${event.messageId}`;
      if (turn.cancelled || seenReplies.has(unique)) return;
      seenReplies.add(unique); if (seenReplies.size > 2000) seenReplies.delete(seenReplies.values().next().value!);
      session.send({ type: 'bot.message', turnId: turn.id, messageId: event.messageId, text: displayText(event.text) });
      if (config.tts.enabled) {
        const segments = speechSegments(event.text, turn.id, nextIndex.get(turn.id) ?? 0);
        nextIndex.set(turn.id, (nextIndex.get(turn.id) ?? 0) + segments.length);
        for (const segment of segments) void synthesize(session, turn, segment);
      }
    } else {
      turn.coreFinished = true;
      if (turn.timeout) clearTimeout(turn.timeout);
      if (event.type === 'turn.failed') failPlayback(session, turn, event.message);
      else session.send({ type: 'turn.completed', turnId: turn.id });
      maybeFinished(session, turn);
    }
  }
  async function onBridgeStatus() {
    if (shuttingDown) return;
    if (!bridge.ready) {
      for (const session of sessions.all()) {
        const turn = session.turn;
        if (!turn || turn.coreFinished) continue;
        failPlayback(session, turn, 'Neo-MoFox 连接已断开，本轮已取消；重新连接后将使用新会话。');
        nextIndex.delete(turn.id);
        // A new private identity prevents a retired core stream contaminating
        // the next request when the transport cannot deliver its terminal event.
        await sessions.renew(session);
        await sendSessionReady(session);
      }
    }
    await broadcastStatus();
  }
  const bridge = new NeoBridge(config.bridge.port, config.bridge.token, onBridgeEvent, () => { void onBridgeStatus(); });
  void speech.ready.then(broadcastStatus);

  function submit(session: Session, text: string, submissionId: string) {
    if (session.seen.has(submissionId)) return;
    if (session.turn) { session.send({ type: 'error', code: 'busy', message: '上一轮仍在处理或播放，请等待，或新建会话。' }); return; }
    if (!bridge.ready) { session.send({ type: 'error', code: 'bridge_offline', message: 'Neo-MoFox 插件尚未连接，请先安装并启用插件。' }); return; }
    const turn: Turn = { id: randomUUID(), submissionId, cancelled: false, coreFinished: false, pendingSynthesis: 0, pendingPlayback: new Set(), abort: new AbortController(), timeout: null };
    session.turn = turn;
    session.seen.add(submissionId); if (session.seen.size > 200) session.seen.delete(session.seen.values().next().value!);
    if (!bridge.send({ type: 'chat.submit', version: 1, sessionId: session.id, userId: `voice:${session.id}`, turnId: turn.id, messageId: submissionId, text, nickname: '网页用户' })) {
      session.turn = null; session.send({ type: 'error', code: 'bridge_offline', message: '桥接已断开，请重新提交。' }); return;
    }
    session.send({ type: 'state.changed', state: 'thinking', turnId: turn.id });
    turn.timeout = setTimeout(() => { if (session.turn === turn && !turn.coreFinished) failPlayback(session, turn, '暂时没有收到完整回复。可停止或新建会话，旧问题不会自动重发。'); }, 180000);
    turn.timeout.unref();
  }
  const getSession = (request: { cookies: Record<string, string | undefined> }) => sessions.get(request.cookies.assistant_session);
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/') && request.url !== '/ws') return;
    const origin = request.headers.origin;
    if (origin) {
      let valid = false;
      try {
        const parsed = new URL(origin);
        valid = parsed.host === request.headers.host || (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && ['5180', String(config.server.port)].includes(parsed.port));
      } catch {}
      if (!valid) return reply.code(403).send({ error: '来源未获允许' });
    }
    if (request.url.startsWith('/api/pair') || request.url.startsWith('/api/status')) return;
    if (!getSession(request)) return reply.code(401).send({ error: '请先使用主机配对码连接' });
  });
  app.get('/api/status', request => status(getSession(request)));
  app.post<{ Body: { code?: string } }>('/api/pair', async (request, reply) => {
    const now = Date.now(); let attempts = pairAttempts.get(request.ip);
    if (!attempts || attempts.reset < now) { attempts = { count: 0, reset: now + 60000 }; pairAttempts.set(request.ip, attempts); }
    if (++attempts.count > 10) return reply.code(429).send({ error: '尝试次数过多，请稍后重试' });
    const code = typeof request.body?.code === 'string' ? request.body.code.trim() : '';
    const admin = equalSecret(code, config.security.adminCode);
    if (!admin && !equalSecret(code, config.security.pairCode)) return reply.code(401).send({ error: '配对码不正确' });
    const { token, session } = await sessions.create(admin);
    reply.setCookie('assistant_session', token, { httpOnly: true, sameSite: 'strict', secure: !!tls, path: '/', maxAge: 60 * 60 * 24 * 30 });
    return { admin, sessionId: session.id };
  });
  app.get('/api/settings', async request => publicSettings(config, getSession(request)!.admin, await coreExists()));
  app.put('/api/settings', async (request, reply) => {
    if (!getSession(request)!.admin) return reply.code(403).send({ error: '需要主机管理员配对码' });
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map(issue => `${issue.path.join('.')}：${issue.message}`).join('；') });
    const updated = { ...config, ...parsed.data };
    if (path.resolve(updated.speech.keywordsFile) === path.join(dataRoot, 'speech/keywords.txt') && updated.speech.kwsTokens) {
      try { await writeKeywords(updated.wakePhrase, updated.speech.kwsTokens, updated.speech.keywordsFile); }
      catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    }
    config = updated; await saveConfig(config);
    await speech.close(); speech = new SpeechEngine(config.speech, config.wakePhrase);
    void speech.ready.then(broadcastStatus);
    // Reconnect so each browser gets a stream from the new recognizer instance.
    for (const socket of peers.values()) socket.close(4002, '语音配置已更新，请重新连接');
    await tts.probe(); await broadcastStatus();
    return publicSettings(config, true, await coreExists());
  });
  app.get('/api/models', () => models.list());
  app.post('/api/models/import', async (request, reply) => {
    if (!getSession(request)!.admin) return reply.code(403).send({ error: '模型导入需要管理员权限' });
    const file = await request.file(); if (!file) return reply.code(400).send({ error: '请选择 ZIP 模型包' });
    try { const model = await models.importZip(await file.toBuffer(), file.filename); if (!config.live2d.defaultModelId) { config.live2d.defaultModelId = model.id; await saveConfig(config); } return model; }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  app.post('/api/live2d/core', async (request, reply) => {
    if (!getSession(request)!.admin) return reply.code(403).send({ error: '运行库导入需要管理员权限' });
    const file = await request.file(); if (!file) return reply.code(400).send({ error: '请选择官方 live2dcubismcore.min.js' });
    const data = await file.toBuffer();
    if (data.length > 4 * 1024 * 1024 || !data.toString('utf8').includes('Live2DCubismCore')) return reply.code(400).send({ error: '文件不是可识别的 Cubism Core' });
    await mkdir(path.dirname(corePath), { recursive: true }); await writeFile(corePath, data); await broadcastStatus(); return { ready: true };
  });
  app.get('/api/voices', () => [{ id: config.tts.voice.id, name: config.tts.voice.name }]);
  app.post('/api/voice/test', async (request, reply) => {
    const session = getSession(request)!;
    if (peers.get(session.tokenHash)?.readyState !== 1) return reply.code(409).send({ error: '请先连接网页实时会话，再进行试听' });
    if (session.turn) return reply.code(409).send({ error: '请先结束当前对话或播放' });
    const turn: Turn = { id: randomUUID(), submissionId: randomUUID(), cancelled: false, coreFinished: true, pendingSynthesis: 0, pendingPlayback: new Set(), abort: new AbortController(), timeout: null };
    session.turn = turn;
    const [segment] = speechSegments('你好，我已经准备好和你聊天了。', turn.id);
    await synthesize(session, turn, segment); session.send({ type: 'turn.completed', turnId: turn.id }); return { ok: !turn.cancelled };
  });
  app.get<{ Params: { audioId: string } }>('/api/audio/:audioId', async (request, reply) => {
    const file = await tts.resource(request.params.audioId, getSession(request)!.id);
    if (!file) return reply.code(404).send({ error: '音频不存在或已过期' });
    return reply.header('Cache-Control', 'private, no-store').type('audio/wav').send(createReadStream(file));
  });
  app.get<{ Params: { id: string; '*': string } }>('/models/:id/*', async (request, reply) => {
    if (!getSession(request)) return reply.code(401).send({ error: '请先配对' });
    const resource = await models.resource(request.params.id, request.params['*']);
    if (!resource) return reply.code(404).send({ error: '模型资源不存在' });
    return reply.header('Cache-Control', 'private, max-age=3600').type(resource.mime).send(createReadStream(resource.path));
  });
  app.get('/vendor/live2dcubismcore.min.js', async (request, reply) => {
    if (!getSession(request)) return reply.code(401).send({ error: '请先配对' });
    if (!await coreExists()) return reply.code(404).send({ error: 'Cubism Core 尚未配置' });
    return reply.type('application/javascript').send(createReadStream(corePath));
  });
  app.get('/ws', { websocket: true }, (socket, request) => {
    const session = getSession(request)!;
    const previous = peers.get(session.tokenHash);
    if (previous && session.turn) failPlayback(session, session.turn, '会话已转到另一页面，已停止旧页面播报');
    previous?.close(4001, '已在另一页面打开此会话');
    peers.set(session.tokenHash, socket);
    session.send = event => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); };
    let mode: 'manual' | 'kws' = 'manual'; let expectedSeq = 0; let streaming = false;
    let speechSession = speech.createSession({
      onWake: () => session.send({ type: 'wake.detected', phrase: config.wakePhrase }),
      onListening: () => session.send({ type: 'state.changed', state: 'listening' }),
      onRecognizing: () => session.send({ type: 'state.changed', state: 'recognizing' }),
      onResult: (text: string) => { session.send({ type: 'asr.result', text }); submit(session, text, randomUUID()); },
      onError: (message: string) => session.send({ type: 'error', code: 'speech', message }),
      onEnded: () => { if (!session.turn) session.send({ type: 'state.changed', state: 'idle' }); }
    });
    resumeWake.set(session.tokenHash, () => { if (mode === 'kws' && streaming && peers.get(session.tokenHash) === socket) speechSession.start('kws'); });
    const ready = () => sendSessionReady(session);
    void ready(); void status(session).then(data => session.send({ type: 'status.changed', data }));
    socket.on('message', async (raw, binary) => {
      try {
        if (binary) {
          if (!streaming) return;
          const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
          if (buffer.length < 6 || buffer.length > 4096 || buffer.length % 2) throw new Error('音频帧大小或格式错误');
          const seq = buffer.readUInt32LE(0); if (seq !== expectedSeq) throw new Error('音频帧序号不连续，请重新录音'); expectedSeq++;
          if (session.turn) return;
          const samples = new Float32Array((buffer.length - 4) / 2);
          for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(i * 2 + 4) / 32768;
          speechSession.push(samples); return;
        }
        const event = clientEventSchema.parse(JSON.parse(raw.toString()));
        switch (event.type) {
          case 'text.submit': submit(session, event.text, event.submissionId); break;
          case 'turn.cancel': if (session.turn) failPlayback(session, session.turn, '已停止本轮播报'); break;
          case 'listen.start': mode = event.mode; speechSession.start(mode); break;
          case 'listen.stop': streaming = false; speechSession.stop(); break;
          case 'audio.start': expectedSeq = 0; streaming = true; break;
          case 'audio.end': streaming = false; session.send({ type: 'state.changed', state: 'recognizing' }); speechSession.finish(); break;
          case 'playback.started': if (session.turn?.pendingPlayback.has(event.segmentId)) { speechSession.stop(); session.send({ type: 'state.changed', state: 'speaking', turnId: session.turn.id }); } break;
          case 'playback.finished': if (session.turn) { const turn = session.turn; turn.pendingPlayback.delete(event.segmentId); maybeFinished(session, turn); } break;
          case 'playback.stopped': if (session.turn) failPlayback(session, session.turn, '播放已停止'); break;
          case 'session.new': if (session.turn) { const turn = session.turn; failPlayback(session, turn, '会话已切换'); nextIndex.delete(turn.id); } await sessions.renew(session); await ready(); break;
        }
      } catch (e) { speechSession.stop(); streaming = false; session.send({ type: 'error', code: 'invalid_message', message: (e as Error).message }); }
    });
    socket.on('close', () => {
      speechSession.stop();
      if (peers.get(session.tokenHash) === socket) {
        peers.delete(session.tokenHash);
        resumeWake.delete(session.tokenHash);
        if (session.turn) failPlayback(session, session.turn, '网页连接已断开，已停止本轮播报');
        session.send = () => {};
      }
    });
    socket.on('error', () => {});
  });
  const webRoot = path.join(ROOT, 'apps/web/dist');
  try { await access(webRoot); await app.register(staticFiles, { root: webRoot, prefix: '/' }); }
  catch { app.get('/', (_request, reply) => reply.type('text/plain; charset=utf-8').send('网页尚未构建，请运行 npm run build，或 npm run dev 后访问 http://localhost:5180。')); }
  const healthTimer = setInterval(() => { void tts.probe().then(broadcastStatus); void tts.clean(); for (const [key, value] of pairAttempts) if (value.reset < Date.now()) pairAttempts.delete(key); }, 15000);
  healthTimer.unref(); void tts.probe();
  app.addHook('onClose', async () => { shuttingDown = true; clearInterval(healthTimer); for (const socket of peers.values()) socket.terminate(); for (const session of sessions.all()) if (session.turn) { session.turn.abort.abort(); if (session.turn.timeout) clearTimeout(session.turn.timeout); } await speech.close(); await bridge.close(); });
  return { app, bridge, sessions, models, tts, getConfig: () => config };
}

async function main() {
  const config = await loadConfig();
  const { app } = await createApplication(config);
  await app.listen({ host: config.server.host, port: config.server.port });
  console.log(`\n语音助手：http${config.server.certPath ? 's' : ''}://localhost:${config.server.port}\n设备配对码：${config.security.pairCode}\n管理员配对码：${config.security.adminCode}\n`);
  const stop = () => { void app.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => { console.error(error); process.exitCode = 1; });
