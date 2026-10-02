import { WebSocket, WebSocketServer } from 'ws';
import { bridgeEventSchema, type BridgeEvent, type ChatSubmit, type ChatCancel } from '@mofox/protocol';
import { equalSecret } from './sessions.js';

export class NeoBridge {
  private server: WebSocketServer;
  private socket: WebSocket | null = null;
  ready = false;
  capabilities: string[] = [];
  detail = '等待 Neo-MoFox 插件连接';
  constructor(port: number, token: string, private onEvent: (event: BridgeEvent) => void, private onStatus: () => void) {
    this.server = new WebSocketServer({ host: '127.0.0.1', port, path: '/bridge', maxPayload: 128 * 1024,
      verifyClient: (info, done) => done(equalSecret(info.req.headers.authorization ?? '', `Bearer ${token}`), 401, 'Unauthorized') });
    this.server.on('connection', socket => {
      if (this.socket) { socket.close(1013, '已有插件连接'); return; }
      this.socket = socket;
      const deadline = setTimeout(() => { if (!this.ready) socket.close(1008, '握手超时'); }, 10000);
      socket.send(JSON.stringify({ type: 'bridge.hello', version: 1 }));
      socket.on('message', raw => {
        try {
          const event = bridgeEventSchema.parse(JSON.parse(raw.toString()));
          if (event.type === 'bridge.ready') {
            if (!event.capabilities.includes('text') || !event.capabilities.includes('turn-completion')) throw new Error('插件缺少文本/回合终态能力');
            clearTimeout(deadline); this.ready = true; this.capabilities = event.capabilities; this.detail = `${event.botName} 已连接`; this.onStatus();
          }
          this.onEvent(event);
        } catch { socket.close(1008, '桥接消息格式无效'); }
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        clearTimeout(deadline);
        if (this.socket !== socket) return;
        this.socket = null; this.ready = false; this.capabilities = []; this.detail = 'Neo-MoFox 桥接已断开'; this.onStatus();
      });
    });
    this.server.on('error', error => { this.detail = `桥接服务错误：${error.message}`; this.ready = false; this.onStatus(); });
  }
  send(event: ChatSubmit | ChatCancel): boolean {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(event)); return true;
  }
  async close(): Promise<void> { this.socket?.terminate(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
}
