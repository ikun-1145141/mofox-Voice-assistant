<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { AssistantState, ClientEvent, ModelInfo, PublicSettings, ServerEvent, SpeechSegment, StatusResponse } from '@mofox/protocol';
import { api, explainError, createId } from './lib/api';
import { MicrophoneCapture, SpeechPlayback } from './lib/audio';
import { CharacterStage } from './lib/live2d';
import Icon from './components/Icon.vue';

interface Message { id: string; role: 'user' | 'assistant' | 'system'; text: string; time: string }
const status = ref<StatusResponse | null>(null);
const settings = ref<PublicSettings | null>(null);
const draft = ref<PublicSettings | null>(null);
const models = ref<ModelInfo[]>([]);
const messages = ref<Message[]>([]);
const socket = shallowRef<WebSocket | null>(null);
const connection = ref<'loading' | 'paired' | 'connecting' | 'connected' | 'disconnected'>('loading');
const state = ref<AssistantState>('idle');
const stateDetail = ref('');
const sessionId = ref('');
const isAdmin = ref(false);
const input = ref('');
const micMode = ref<'manual' | 'kws' | null>(null);
const micBusy = ref(false);
const isPlaying = ref(false);
const mouthLevel = ref(0);
const soundUnlocked = ref(false);
const activeSegment = ref<SpeechSegment | null>(null);
const wakeNotice = ref('');
const drawer = ref(false);
const drawerTab = ref<'general' | 'voice' | 'character' | 'speech'>('general');
const saving = ref(false);
const importing = ref(false);
const uploadingCore = ref(false);
const pairing = ref(false);
const pairCode = ref('');
const error = ref('');
const notice = ref('');
const stageError = ref('');
const stageLoading = ref(false);
const selectedModelId = ref('');
const stageHost = ref<HTMLDivElement | null>(null);
const chatScroll = ref<HTMLDivElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const coreInput = ref<HTMLInputElement | null>(null);
const emotionMapping = ref('');
const motionMapping = ref('');
const theme = ref(localStorage.getItem('mofox-theme') === 'light' ? 'light' : 'dark');
const stageZoom = ref(Math.max(0.6, Math.min(3, Number(localStorage.getItem('mofox-stage-zoom')) || 1)));
const stageOffset = ref(Math.max(-0.45, Math.min(0.45, Number(localStorage.getItem('mofox-stage-offset')) || 0)));
const stage = shallowRef<CharacterStage | null>(null);
const abortController = new AbortController();
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
let characterRequest = 0;

const labels: Record<AssistantState, string> = {
  idle: '等待与你对话', listening: '正在聆听', recognizing: '识别语音中', thinking: '正在思考',
  synthesizing: '生成声音中', speaking: '正在说话', error: '需要处理'
};
const connected = computed(() => connection.value === 'connected');
const busy = computed(() => ['recognizing', 'thinking', 'synthesizing', 'speaking'].includes(state.value) || isPlaying.value);
const canChat = computed(() => connected.value && status.value?.bridge.ready && !busy.value && !micMode.value);
const selectedModel = computed(() => models.value.find(model => model.id === selectedModelId.value));
const stateLabel = computed(() => wakeNotice.value || (micMode.value === 'kws' && state.value === 'idle' ? '等待唤醒' : labels[state.value]));
const serviceItems = computed(() => [
  { label: 'Neo-MoFox', health: status.value?.bridge },
  { label: 'GSV 声音', health: status.value?.tts },
  { label: '语音识别', health: status.value?.speech },
  { label: '唤醒引擎', health: status.value?.kws }
]);
const readyCount = computed(() => serviceItems.value.filter(item => item.health?.ready).length);

function send(event: ClientEvent | ArrayBuffer): boolean {
  if (!socket.value || socket.value.readyState !== WebSocket.OPEN || !connected.value) return false;
  if (event instanceof ArrayBuffer && socket.value.bufferedAmount > 512_000) {
    showError('网络无法及时发送麦克风音频，录音已停止。请检查连接后重试。');
    void stopMicrophone(true);
    return false;
  }
  socket.value.send(event instanceof ArrayBuffer ? event : JSON.stringify(event));
  return true;
}
function showError(message: string): void { error.value = message; }
function addMessage(role: Message['role'], text: string, id: string = createId()): void {
  if (messages.value.some(message => message.id === id)) return;
  messages.value.push({ id, role, text, time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) });
}
function perform(segment: SpeechSegment): void { activeSegment.value = segment; stage.value?.perform(segment); }
const microphone = new MicrophoneCapture(send);
const playback = new SpeechPlayback(send, perform, value => {
  mouthLevel.value = value;
  stage.value?.amplitude(value);
}, message => {
  if (message.includes('浏览器已暂停')) soundUnlocked.value = false;
  showError(message);
}, active => {
  isPlaying.value = active;
  microphone.paused = active && micMode.value === 'kws';
  if (!active) activeSegment.value = null;
});

async function refreshStatus(): Promise<void> {
  status.value = await api<StatusResponse>('/api/status', { signal: abortController.signal });
  isAdmin.value = status.value.admin;
}
async function bootstrap(): Promise<void> {
  try {
    await refreshStatus();
    if (status.value?.authenticated) connect();
    else connection.value = 'paired';
  } catch (cause) { connection.value = 'disconnected'; showError(`服务暂时不可用：${explainError(cause)}`); }
}
function connect(): void {
  socket.value?.close();
  connection.value = 'connecting';
  error.value = '';
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket.value = ws;
  ws.onmessage = event => {
    if (typeof event.data !== 'string') return;
    try { receive(JSON.parse(event.data) as ServerEvent); }
    catch (cause) { showError(`无法处理服务消息：${explainError(cause)}`); }
  };
  ws.onerror = () => { if (ws === socket.value) showError('实时连接失败，请确认服务正在运行且此设备已配对。'); };
  ws.onclose = event => {
    if (ws !== socket.value || disposed) return;
    connection.value = 'disconnected';
    micMode.value = null;
    void microphone.stop(false);
    playback.stop(false);
    state.value = 'idle';
    stateDetail.value = '';
    if (event.code === 4002) {
      notice.value = '设置已更新，正在重新连接会话。';
      void bootstrap();
      return;
    }
    notice.value = '连接已断开。未完成的提问不会自动重发，重新连接后可再次发送。';
  };
}
function receive(event: ServerEvent): void {
  switch (event.type) {
    case 'session.ready':
      connection.value = 'connected';
      sessionId.value = event.data.sessionId;
      isAdmin.value = event.data.admin;
      settings.value = event.data.settings;
      if (drawer.value) fillDraft(event.data.settings);
      models.value = event.data.models;
      selectedModelId.value ||= event.data.settings.live2d.defaultModelId || event.data.models[0]?.id || '';
      state.value = 'idle';
      stateDetail.value = '';
      if (notice.value.startsWith('已请求新建会话')) notice.value = '新的会话已经准备好。';
      if (notice.value.startsWith('设置已更新，正在')) notice.value = '设置已更新，会话已重新连接。';
      void refreshStatus().catch(cause => showError(explainError(cause)));
      break;
    case 'status.changed': status.value = event.data; isAdmin.value = event.data.admin; break;
    case 'state.changed':
      state.value = event.state;
      stateDetail.value = event.detail || '';
      if (event.state === 'listening' && micMode.value === 'kws') {
        wakeNotice.value = '';
        if (wakeTimer) clearTimeout(wakeTimer);
        wakeTimer = null;
      }
      if (['recognizing', 'idle', 'error'].includes(event.state) && micMode.value === 'manual') void releaseCapture();
      break;
    case 'wake.detected':
      wakeNotice.value = `听到了「${event.phrase}」`;
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = setTimeout(() => { wakeNotice.value = ''; }, 3500);
      break;
    case 'asr.result': addMessage('user', event.text); break;
    case 'bot.message': addMessage('assistant', event.text, event.messageId); break;
    case 'performance.segment': if (!settings.value?.tts.enabled) perform(event.segment); break;
    case 'audio.ready': playback.add(event.segment, event.url); break;
    case 'turn.completed': break;
    case 'turn.failed': playback.stop(false); showError(event.message); break;
    case 'error':
      showError(event.message);
      if (['speech', 'invalid_message'].includes(event.code) && micMode.value) void releaseCapture();
      break;
  }
}

async function pair(): Promise<void> {
  if (!pairCode.value.trim()) return;
  pairing.value = true;
  try {
    await api<{ admin: boolean }>('/api/pair', { method: 'POST', body: JSON.stringify({ code: pairCode.value.trim() }) });
    pairCode.value = '';
    await bootstrap();
  } catch (cause) { showError(explainError(cause)); }
  finally { pairing.value = false; }
}
async function enableAudio(): Promise<void> {
  try { await playback.unlock(); soundUnlocked.value = true; }
  catch (cause) { showError(`无法启用声音：${explainError(cause)}`); }
}
async function submit(): Promise<void> {
  const text = input.value.trim();
  if (!text || !canChat.value) return;
  void enableAudio();
  if (send({ type: 'text.submit', text, submissionId: createId() })) {
    addMessage('user', text);
    input.value = '';
  }
}
function inputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit(); }
}
async function startMicrophone(mode: 'manual' | 'kws'): Promise<void> {
  if (!connected.value || micBusy.value) return;
  if (micMode.value) { await stopMicrophone(); return; }
  micBusy.value = true;
  error.value = '';
  try {
    await enableAudio();
    await microphone.start(mode);
    if (microphone.active) micMode.value = mode;
  } catch (cause) { showError(`麦克风未启动：${explainError(cause)}`); }
  finally { micBusy.value = false; }
}
async function stopMicrophone(discard = false): Promise<void> {
  micBusy.value = true;
  try { await microphone.stop(true, discard); micMode.value = null; }
  finally { micBusy.value = false; }
}
async function releaseCapture(): Promise<void> {
  micMode.value = null;
  micBusy.value = true;
  try { await microphone.stop(false); }
  finally { micBusy.value = false; }
}
async function stopAll(): Promise<void> {
  playback.stop();
  if (micMode.value) await stopMicrophone(true);
  send({ type: 'turn.cancel' });
}
async function newSession(): Promise<void> {
  if (!connected.value) return;
  await stopAll();
  if (send({ type: 'session.new' })) {
    messages.value = [];
    notice.value = '已请求新建会话，等待服务确认。';
  }
}

async function openSettings(): Promise<void> {
  drawer.value = true;
  if (settings.value) fillDraft(settings.value);
  try {
    const current = await api<PublicSettings>('/api/settings');
    settings.value = current;
    fillDraft(current);
  } catch (cause) { showError(explainError(cause)); }
}
function fillDraft(value: PublicSettings): void {
  draft.value = JSON.parse(JSON.stringify(value)) as PublicSettings;
  emotionMapping.value = JSON.stringify(value.live2d.mapping.emotions, null, 2);
  motionMapping.value = JSON.stringify(value.live2d.mapping.motions, null, 2);
}
function parseMapping(text: string): Record<string, string> {
  const mapping = JSON.parse(text) as unknown;
  if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object' || Object.values(mapping).some(value => typeof value !== 'string')) {
    throw new Error('动作与表情映射需要 JSON 对象，键和值都使用字符串。');
  }
  return mapping as Record<string, string>;
}
async function saveSettings(): Promise<void> {
  if (!draft.value || !isAdmin.value) return;
  saving.value = true;
  try {
    draft.value.live2d.mapping.emotions = parseMapping(emotionMapping.value);
    draft.value.live2d.mapping.motions = parseMapping(motionMapping.value);
    const result = await api<PublicSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(draft.value) });
    settings.value = result;
    fillDraft(result);
    notice.value = '设置已保存。语音模型切换按服务提示生效。';
    await refreshStatus();
  } catch (cause) { showError(explainError(cause)); }
  finally { saving.value = false; }
}
async function importModel(event: Event): Promise<void> {
  const element = event.target as HTMLInputElement;
  const file = element.files?.[0];
  if (!file) return;
  importing.value = true;
  try {
    const data = new FormData(); data.append('file', file);
    const imported = await api<ModelInfo>('/api/models/import', { method: 'POST', body: data });
    models.value = await api<ModelInfo[]>('/api/models');
    selectedModelId.value = imported.id;
    if (draft.value) draft.value.live2d.defaultModelId = imported.id;
    notice.value = `已导入「${imported.name}」，正在加载角色。`;
    await refreshStatus();
  } catch (cause) { showError(explainError(cause)); }
  finally { importing.value = false; element.value = ''; }
}
async function uploadCore(event: Event): Promise<void> {
  const element = event.target as HTMLInputElement;
  const file = element.files?.[0];
  if (!file) return;
  uploadingCore.value = true;
  try {
    const data = new FormData(); data.append('file', file);
    await api<unknown>('/api/live2d/core', { method: 'POST', body: data });
    await refreshStatus();
    settings.value = await api<PublicSettings>('/api/settings');
    notice.value = 'Cubism Core 已上传。';
    await loadCharacter();
  } catch (cause) { showError(explainError(cause)); }
  finally { uploadingCore.value = false; element.value = ''; }
}
async function testVoice(): Promise<void> {
  try { await enableAudio(); await api<unknown>('/api/voice/test', { method: 'POST', body: '{}' }); }
  catch (cause) { showError(explainError(cause)); }
}
async function loadCharacter(): Promise<void> {
  const request = ++characterRequest;
  stageError.value = '';
  if (!selectedModel.value || !stageHost.value || !settings.value) {
    stage.value?.destroy();
    stage.value = null;
    stageLoading.value = false;
    return;
  }
  stageLoading.value = true;
  if (!stage.value) stage.value = new CharacterStage(stageHost.value, () => settings.value!.live2d.mapping);
  try {
    await stage.value.load(selectedModel.value.entryUrl);
    if (request === characterRequest) stage.value.transform(stageZoom.value, stageOffset.value);
  }
  catch (cause) { if (request === characterRequest) stageError.value = explainError(cause); }
  finally { if (request === characterRequest) stageLoading.value = false; }
}
function previewPerformance(emotion: string | null, motion: string | null): void {
  stage.value?.perform({ turnId: 'local-preview', segmentId: createId(), index: 0, text: '', emotion, motion, waitBeforeMs: 0 });
}

watch([selectedModelId, () => settings.value?.live2d.coreReady], () => { void loadCharacter(); });
watch(theme, value => localStorage.setItem('mofox-theme', value));
watch([stageZoom, stageOffset], ([zoom, offset]) => {
  stage.value?.transform(zoom, offset);
  localStorage.setItem('mofox-stage-zoom', String(zoom));
  localStorage.setItem('mofox-stage-offset', String(offset));
});
watch(() => messages.value.length, async () => {
  await nextTick();
  chatScroll.value?.scrollTo({ top: chatScroll.value.scrollHeight, behavior: 'smooth' });
});
onMounted(() => { void bootstrap(); });
onBeforeUnmount(() => {
  disposed = true;
  abortController.abort();
  socket.value?.close();
  if (wakeTimer) clearTimeout(wakeTimer);
  void microphone.stop(false);
  void playback.dispose();
  stage.value?.destroy();
});
</script>

<template>
  <div class="app-shell" :data-theme="theme">
    <header class="topbar">
      <a class="brand" href="/" aria-label="MoFox 语音助手首页">
        <span class="brand-mark"><Icon name="spark" :size="23" /></span>
        <span class="brand-text">MoFox<span class="brand-divider">/</span><span class="brand-product">语音助手</span></span>
      </a>
      <nav class="topbar-actions" aria-label="应用操作">
        <button v-if="connection === 'disconnected'" class="reconnect-button" @click="bootstrap"><Icon name="refresh" :size="13" />重新连接</button>
        <span class="connection-label"><i class="status-dot" :class="{ online: connected }" />{{ connected ? '本地连接' : connection === 'connecting' || connection === 'loading' ? '正在连接' : '尚未连接' }}</span>
        <button class="icon-button" :title="theme === 'dark' ? '切换浅色' : '切换深色'" @click="theme = theme === 'dark' ? 'light' : 'dark'"><Icon :name="theme === 'dark' ? 'sun' : 'moon'" /></button>
        <button class="icon-button" title="设置" @click="openSettings"><Icon name="settings" /></button>
      </nav>
    </header>

    <div v-if="error" class="banner error-banner" role="alert"><Icon name="warning" :size="17" /><span>{{ error }}</span><button class="icon-button small" title="关闭提示" @click="error = ''"><Icon name="close" :size="16" /></button></div>
    <div v-if="notice" class="banner notice-banner" role="status"><Icon name="info" :size="17" /><span>{{ notice }}</span><button class="icon-button small" title="关闭提示" @click="notice = ''"><Icon name="close" :size="16" /></button></div>

    <main class="workspace">
      <section class="stage-panel" aria-label="Live2D 角色舞台">
        <div class="stage-grid" />
        <div class="stage-header">
          <span class="eyebrow"><i class="little-square" /> CHARACTER SPACE</span>
          <button class="pill-button" @click="drawerTab = 'character'; openSettings()"><Icon name="layers" :size="14" />{{ selectedModel?.name || '选择角色' }}<Icon name="chevron" :size="14" /></button>
        </div>
        <div ref="stageHost" class="character-canvas" :class="{ 'is-hidden': !selectedModel || !!stageError || stageLoading }" />
        <div v-if="selectedModel && !stageLoading && !stageError" class="stage-zoom-controls"><button class="icon-button small" title="缩小角色" :disabled="stageZoom <= 0.6" @click="stageZoom = Math.max(0.6, stageZoom - 0.2)"><Icon name="minus" :size="15" /></button><span>{{ Math.round(stageZoom * 100) }}%</span><button class="icon-button small" title="放大角色" :disabled="stageZoom >= 3" @click="stageZoom = Math.min(3, stageZoom + 0.2)"><Icon name="plus" :size="15" /></button></div>
        <div v-if="!selectedModel || stageError || stageLoading" class="stage-placeholder">
          <div class="orb"><div class="orb-inner"><Icon :name="stageLoading ? 'loader' : 'spark'" :size="42" :class="{ spin: stageLoading }" /></div><span class="orbit-dot" /></div>
          <span class="stage-tag">你的专属角色，正在这里等你</span>
          <h1>{{ stageLoading ? '正在准备角色' : stageError ? '角色暂未就绪' : '让对话，有个模样' }}</h1>
          <p>{{ stageLoading ? '正在读取模型与纹理，请稍候。' : stageError || '导入自己的 Live2D 模型，让声音、表情和动作一起回应你。' }}</p>
          <button v-if="!stageLoading" class="button secondary" @click="drawerTab = 'character'; openSettings()"><Icon name="plus" :size="16" />{{ stageError ? '检查角色设置' : '添加 Live2D 角色' }}</button>
          <span class="format-note">支持 Cubism 4 · model3.json 模型压缩包</span>
        </div>
        <div class="stage-bottom">
          <div class="state-card" :class="{ 'is-active': micMode || busy }">
            <span class="state-symbol"><Icon :name="isPlaying ? 'volume' : micMode ? 'mic' : 'spark'" :size="19" /></span>
            <div><span class="state-title">{{ stateLabel }}</span><span class="state-description">{{ activeSegment?.text || stateDetail || (micMode === 'kws' ? `说「${settings?.wakePhrase || '唤醒词'}」，开始聊天` : connected ? '文字或声音，都可以开始一段对话' : '配对连接后，即可开始对话') }}</span></div>
            <span class="waveform" :class="{ moving: !!micMode, 'is-playing': isPlaying }" :style="{ '--volume': mouthLevel }"><i /><i /><i /><i /><i /></span>
          </div>
          <div class="stage-caption"><span>LOCAL FIRST</span><span><Icon name="shield" :size="12" />运行在你的设备上</span></div>
        </div>
      </section>

      <section class="conversation-panel" aria-label="对话">
        <div class="conversation-header"><div><span class="eyebrow">CONVERSATION</span><h2>{{ settings?.assistantName || '我的助手' }}<span class="assistant-badge">BOT</span></h2></div><button class="icon-button" title="创建新会话" :disabled="!connected" @click="newSession"><Icon name="newchat" :size="19" /></button></div>
        <div ref="chatScroll" class="chat-scroll" aria-live="polite">
          <form v-if="connection === 'paired'" class="pair-card" @submit.prevent="pair">
            <span class="empty-icon"><Icon name="shield" :size="24" /></span><h3>连接你的助手</h3><p>输入服务启动时显示的配对码，授权这台设备访问。</p>
            <label class="sr-only" for="pair-code">配对码</label><input id="pair-code" v-model="pairCode" type="password" autocomplete="off" placeholder="输入配对码" required />
            <button class="button primary" :disabled="pairing">{{ pairing ? '正在配对…' : '配对并连接' }}<Icon name="arrow" :size="16" /></button>
          </form>
          <div v-else-if="!messages.length" class="conversation-empty">
            <span class="empty-icon"><Icon name="chat" :size="27" /></span><h3>{{ connected ? '今天，想聊些什么？' : '等待建立连接' }}</h3>
            <p>{{ connected ? (status?.bridge.ready ? '发一条消息，或打开麦克风。你的助手会在这里回应。' : '网页已连接，等待 Neo-MoFox 插件上线。可以先配置模型和声音。') : '开启服务并完成配对，让你的 Bot 来到身边。' }}</p>
            <button v-if="connection === 'disconnected'" class="button secondary" @click="bootstrap"><Icon name="refresh" :size="15" />重新连接</button>
            <div v-if="connected" class="empty-hint"><i class="status-dot" :class="{ online: status?.bridge.ready }" />{{ status?.bridge.ready ? 'Neo-MoFox 已就绪' : 'Neo-MoFox 尚未连接' }}</div>
          </div>
          <template v-else>
            <div class="conversation-date">本次会话<span>{{ sessionId.slice(0, 8) }}</span></div>
            <article v-for="message in messages" :key="message.id" class="message" :class="`message-${message.role}`">
              <span v-if="message.role === 'assistant'" class="message-avatar"><Icon name="spark" :size="15" /></span>
              <div class="message-body"><div class="message-meta"><span>{{ message.role === 'user' ? '你' : message.role === 'assistant' ? settings?.assistantName || '助手' : '系统' }}</span><time>{{ message.time }}</time></div><p>{{ message.text }}</p></div>
            </article>
            <div v-if="['recognizing', 'thinking', 'synthesizing'].includes(state)" class="thinking-indicator"><i /><i /><i /><span>{{ stateLabel }}</span></div>
          </template>
        </div>
        <div class="composer-area">
          <div class="voice-controls">
            <button class="voice-button" :class="{ recording: micMode === 'manual' }" :disabled="!connected || micBusy || (busy && micMode !== 'manual') || (micMode !== 'manual' && (!!micMode || !status?.speech.ready || !status?.bridge.ready))" @click="startMicrophone('manual')"><Icon :name="micMode === 'manual' ? 'stop' : 'mic'" :size="17" />{{ micMode === 'manual' ? '结束录音' : '开始说话' }}</button>
            <button class="wake-button" :class="{ selected: micMode === 'kws' }" :disabled="!connected || micBusy || (micMode !== 'kws' && (!!micMode || !status?.kws.ready || !status?.speech.ready || !status?.bridge.ready || busy))" @click="startMicrophone('kws')"><span class="toggle-mini"><i /></span>语音唤醒</button>
            <button v-if="busy || micMode" class="icon-button small stop-button" title="停止当前对话与声音" @click="stopAll"><Icon name="stop" :size="15" /></button>
          </div>
          <form class="composer" @submit.prevent="submit"><label class="sr-only" for="chat-input">给助手发消息</label><textarea id="chat-input" v-model="input" rows="2" maxlength="4000" :disabled="!connected" :placeholder="!connected ? '连接后开始对话…' : !status?.bridge.ready ? '等待 Neo-MoFox 上线…' : '说点什么…'" @keydown="inputKeydown" /><div class="composer-bottom"><span><Icon name="keyboard" :size="13" />Enter 发送 · Shift + Enter 换行</span><button class="send-button" title="发送消息" :disabled="!input.trim() || !canChat"><Icon name="arrow" :size="18" /></button></div></form>
          <div class="composer-note"><span>{{ micMode === 'kws' ? `唤醒词：${settings?.wakePhrase}` : '你的对话，由自己的 Bot 回应' }}</span><button v-if="!soundUnlocked" @click="enableAudio"><Icon name="volume" :size="12" />启用声音</button><span v-else class="sound-ready"><Icon name="volume" :size="12" />声音已启用</span></div>
        </div>
      </section>
    </main>

    <footer class="statusbar"><div class="service-status"><span v-for="item in serviceItems" :key="item.label" :title="item.health?.detail || '等待服务状态'"><i class="status-dot" :class="{ online: item.health?.ready }" />{{ item.label }}</span></div><div class="statusbar-end"><span>{{ readyCount }}/4 服务就绪</span><span class="version">v{{ status?.version || '0.1.0' }}</span></div></footer>

    <Teleport to="body">
      <div v-if="drawer" class="drawer-layer" :data-theme="theme" @keydown.esc="drawer = false">
        <div class="drawer-backdrop" @click="drawer = false" />
        <aside class="settings-drawer" aria-label="助手设置" role="dialog" aria-modal="true">
          <div class="drawer-header"><div><span class="eyebrow">MAKE IT YOURS</span><h2>助手设置</h2></div><button class="icon-button" title="关闭设置" @click="drawer = false"><Icon name="close" /></button></div>
          <div class="settings-tabs"><button v-for="tab in ([['general', '通用'], ['voice', '声音'], ['character', '角色'], ['speech', '识别']] as const)" :key="tab[0]" :class="{ active: drawerTab === tab[0] }" @click="drawerTab = tab[0]">{{ tab[1] }}</button></div>
          <div class="settings-scroll">
            <div v-if="error" class="banner error-banner" role="alert"><Icon name="warning" :size="16" /><span>{{ error }}</span><button class="icon-button small" title="关闭提示" @click="error = ''"><Icon name="close" :size="14" /></button></div>
            <div v-if="!isAdmin" class="info-box"><Icon name="shield" :size="17" /><span>当前设备可查看设置。编辑和导入需要使用管理员配对码。</span></div>
            <form v-if="!isAdmin && connected" class="admin-pair-form" @submit.prevent="pair"><input v-model="pairCode" type="password" aria-label="管理员配对码" autocomplete="off" placeholder="管理员配对码" required /><button class="button secondary" :disabled="pairing">{{ pairing ? '配对中…' : '授权管理员' }}</button></form>
            <template v-if="draft">
              <div v-if="drawerTab === 'general'" class="settings-section">
                <h3>你与助手</h3><p class="section-description">给它一个名字，叫醒它就能聊天。</p>
                <label>助手名称<input v-model="draft.assistantName" :disabled="!isAdmin" maxlength="80" /></label>
                <label>唤醒短语<input v-model="draft.wakePhrase" :disabled="!isAdmin" maxlength="80" /><small>需要与 KWS keywords 文件中的短语一致。</small></label>
                <div class="setting-row"><div><strong>界面外观</strong><small>仅影响当前设备</small></div><div class="segmented"><button :class="{ selected: theme === 'dark' }" @click="theme = 'dark'">深色</button><button :class="{ selected: theme === 'light' }" @click="theme = 'light'">暖白</button></div></div>
                <h3 class="subsection-title">连接状态</h3><div class="health-list"><div v-for="item in serviceItems" :key="item.label"><strong><i class="status-dot" :class="{ online: item.health?.ready }" />{{ item.label }}</strong><small>{{ item.health?.detail || '等待服务状态' }}</small></div></div>
                <button v-if="!connected" class="button secondary" @click="bootstrap">重新连接</button>
              </div>
              <div v-if="drawerTab === 'voice'" class="settings-section">
                <h3>声音与表达</h3><p class="section-description">使用本机 GPT-SoVITS API，为助手设定声音。</p>
                <label class="checkbox-row"><input v-model="draft.tts.enabled" type="checkbox" :disabled="!isAdmin" />启用语音合成</label>
                <label>GSV API 地址<input v-model="draft.tts.baseUrl" :disabled="!isAdmin" placeholder="http://127.0.0.1:9880" /></label>
                <label>声音名称<input v-model="draft.tts.voice.name" :disabled="!isAdmin" /></label>
                <label>参考音频路径<input v-model="draft.tts.voice.refAudioPath" :disabled="!isAdmin" placeholder="服务所在电脑上的音频绝对路径" /><small>使用运行 GSV 的电脑能读取的本地文件。</small></label>
                <label>参考音频文本<textarea v-model="draft.tts.voice.promptText" :disabled="!isAdmin" rows="3" placeholder="参考音频中所说的文字" /></label>
                <div class="field-grid"><label>参考语言<select v-model="draft.tts.voice.promptLang" :disabled="!isAdmin"><option value="zh">中文</option><option value="en">英文</option><option value="ja">日文</option><option value="ko">韩文</option><option value="yue">粤语</option><option value="auto">自动</option></select></label><label>合成语言<select v-model="draft.tts.voice.textLang" :disabled="!isAdmin"><option value="zh">中文</option><option value="en">英文</option><option value="ja">日文</option><option value="ko">韩文</option><option value="yue">粤语</option><option value="auto">自动</option></select></label></div>
                <label>语速 <span class="field-value">{{ Number(draft.tts.voice.speed).toFixed(1) }}×</span><input v-model.number="draft.tts.voice.speed" type="range" min="0.6" max="1.6" step="0.1" :disabled="!isAdmin" /></label>
                <label>请求超时（毫秒）<input v-model.number="draft.tts.timeoutMs" type="number" min="1000" max="300000" :disabled="!isAdmin" /></label>
                <button class="button secondary" :disabled="!connected || !status?.tts.ready" @click="testVoice"><Icon name="volume" :size="16" />试听已保存的声音</button>
              </div>
              <div v-if="drawerTab === 'character'" class="settings-section">
                <h3>角色舞台</h3><p class="section-description">上传完整模型 ZIP，保留模型内的纹理、动作和表情路径。</p>
                <input ref="fileInput" type="file" accept=".zip,application/zip" hidden @change="importModel" />
                <button class="import-zone" :disabled="!isAdmin || importing" @click="fileInput?.click()"><Icon :name="importing ? 'loader' : 'upload'" :size="27" :class="{ spin: importing }" /><strong>{{ importing ? '正在导入模型…' : '导入 Live2D 模型' }}</strong><span>选择包含 model3.json 的 ZIP 文件</span></button>
                <label>当前设备角色<select v-model="selectedModelId"><option value="">未选择</option><option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option></select></label>
                <label>舞台缩放（当前设备）<span class="field-value">{{ Math.round(stageZoom * 100) }}%</span><input v-model.number="stageZoom" type="range" min="0.6" max="3" step="0.05" /></label>
                <label>角色垂直位置（当前设备）<input v-model.number="stageOffset" type="range" min="-0.45" max="0.45" step="0.01" /><small>模型画布留白较大时，可调整缩放与位置。</small></label>
                <button class="text-button" @click="stageZoom = 1; stageOffset = 0">恢复舞台默认位置</button>
                <div v-if="selectedModel && !stageError" class="performance-preview"><span>预览已保存的表情与动作</span><div><button v-for="key in Object.keys(settings?.live2d.mapping.emotions || {})" :key="key" :aria-label="`预览表情 ${key}`" @click="previewPerformance(key, null)">{{ key }}</button><button v-for="key in Object.keys(settings?.live2d.mapping.motions || {})" :key="key" :aria-label="`预览动作 ${key}`" @click="previewPerformance(null, key)">{{ key }}<Icon name="chevron" :size="11" /></button></div></div>
                <label>默认角色<select v-model="draft.live2d.defaultModelId" :disabled="!isAdmin"><option value="">未选择</option><option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option></select></label>
                <div class="core-status"><span><i class="status-dot" :class="{ online: status?.live2dCore.ready }" />Cubism Core {{ status?.live2dCore.ready ? '已配置' : '待配置' }}</span><input ref="coreInput" type="file" accept=".js,text/javascript" hidden @change="uploadCore" /><button class="text-button" :disabled="!isAdmin || uploadingCore" @click="coreInput?.click()">{{ uploadingCore ? '上传中…' : '上传 Core' }}</button></div>
                <p class="help-text">从官方 Cubism SDK 获取 live2dcubismcore.min.js，并按官方许可使用。模型由本机加载。</p>
                <h3 class="subsection-title">动作与口型</h3><label>口型参数<input v-model="draft.live2d.mapping.mouthParameter" :disabled="!isAdmin" placeholder="ParamMouthOpenY" /></label>
                <label>表情映射（JSON）<textarea v-model="emotionMapping" :disabled="!isAdmin" rows="5" class="code-input" spellcheck="false" /><small>例如 { "happy": "smile" }，值为模型表情名称。</small></label>
                <label>动作映射（JSON）<textarea v-model="motionMapping" :disabled="!isAdmin" rows="5" class="code-input" spellcheck="false" /><small>例如 { "wave": "TapBody:0" }，值为「动作组:序号」。</small></label>
              </div>
              <div v-if="drawerTab === 'speech'" class="settings-section">
                <h3>识别与唤醒</h3><p class="section-description">服务使用本地 Sherpa-ONNX 模型。浏览器发送 16 kHz 单声道 PCM 音频。</p>
                <label class="checkbox-row"><input v-model="draft.speech.enabled" type="checkbox" :disabled="!isAdmin" />启用本地语音识别</label>
                <label>SenseVoice 模型<input v-model="draft.speech.senseVoiceModel" :disabled="!isAdmin" placeholder="model.int8.onnx" /></label>
                <label>识别 tokens 文件<input v-model="draft.speech.tokens" :disabled="!isAdmin" placeholder="tokens.txt" /></label>
                <h3 class="subsection-title">KWS 唤醒模型</h3>
                <label>Encoder 路径<input v-model="draft.speech.kwsEncoder" :disabled="!isAdmin" /></label>
                <label>Decoder 路径<input v-model="draft.speech.kwsDecoder" :disabled="!isAdmin" /></label>
                <label>Joiner 路径<input v-model="draft.speech.kwsJoiner" :disabled="!isAdmin" /></label>
                <label>KWS tokens 文件<input v-model="draft.speech.kwsTokens" :disabled="!isAdmin" /></label>
                <label>唤醒关键词文件<input v-model="draft.speech.keywordsFile" :disabled="!isAdmin" placeholder="keywords.txt" /></label>
                <div class="field-grid"><label>静音结束阈值（ms）<input v-model.number="draft.speech.silenceMs" type="number" min="300" max="5000" :disabled="!isAdmin" /></label><label>最长录音（ms）<input v-model.number="draft.speech.maxUtteranceMs" type="number" min="1000" max="120000" :disabled="!isAdmin" /></label></div>
                <div class="info-box"><Icon name="info" :size="17" /><span>其他设备访问麦克风需要 HTTPS。首次访问请信任本机证书，再允许麦克风权限。</span></div>
              </div>
            </template>
            <div v-else class="settings-section"><p class="section-description">配对连接后可查看和配置助手。</p><form v-if="connection === 'paired'" @submit.prevent="pair"><label>配对码<input v-model="pairCode" type="password" autocomplete="off" required /></label><button class="button primary" :disabled="pairing">配对并连接</button></form></div>
          </div>
          <div class="drawer-footer"><span>{{ isAdmin ? '管理员设备' : '访问设备' }}</span><button class="button primary" :disabled="!isAdmin || !draft || saving" @click="saveSettings">{{ saving ? '保存中…' : '保存设置' }}<Icon name="check" :size="16" /></button></div>
        </aside>
      </div>
    </Teleport>
  </div>
</template>
