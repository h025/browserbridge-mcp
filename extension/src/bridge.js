// 与本机 MCP 服务之间的 WebSocket 连接。
// Chrome 116+ 中，WebSocket 收发消息会延长 Service Worker 的存活时间，
// 所以连接期间每 20 秒发一次 ping 即可保持后台常驻。

export const DEFAULT_PORT = 18765;
const PING_INTERVAL_MS = 20_000;

export class Bridge {
  // hooks.onConnected / hooks.onDisconnected：连接建立 / 断开时回调
  constructor(handler, hooks = {}) {
    this.handler = handler;
    this.hooks = hooks;
    this.ws = null;
    this.port = DEFAULT_PORT;
    this.state = 'disconnected';
    this.lastError = '';
    this.pingTimer = null;
    this.retryTimer = null;
    this.retryDelay = 1000;
    this.inflight = new Set(); // 正在执行的请求 ID
    this.cancelled = new Set(); // 其中被 MCP 客户端取消的
  }

  status() {
    return { state: this.state, port: this.port, lastError: this.lastError };
  }

  async ensureConnected() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const { port } = await chrome.storage.local.get('port');
    this.port = Number(port) || DEFAULT_PORT;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.connect();
  }

  reconnect() {
    this.retryDelay = 1000;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    this.ensureConnected();
  }

  connect() {
    clearTimeout(this.retryTimer);
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.port}/extension`);
    } catch (e) {
      this.lastError = String(e?.message || e);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.state = 'connecting';

    ws.onopen = () => {
      this.state = 'connected';
      this.lastError = '';
      this.retryDelay = 1000;
      this.send({
        type: 'hello',
        version: chrome.runtime.getManifest().version,
        userAgent: navigator.userAgent,
      });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL_MS);
      this.hooks.onConnected?.();
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {
      this.lastError = chrome.i18n.getMessage('connectFailed', [`ws://127.0.0.1:${this.port}`]);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      const wasConnected = this.state === 'connected';
      if (this.ws === ws) {
        this.ws = null;
        this.state = 'disconnected';
        this.scheduleRetry();
      }
      if (wasConnected) this.hooks.onDisconnected?.();
    };
  }

  // Service Worker 存活期间用退避重试；休眠后由 alarms 每 30 秒唤醒重连
  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.ensureConnected(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  async onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === 'cancel') {
      if (this.inflight.has(msg.id)) this.cancelled.add(msg.id);
      return;
    }
    if (msg.type !== 'request') return;
    this.inflight.add(msg.id);
    try {
      const result = await this.handler(msg.tool, msg.args || {}, { isCancelled: () => this.cancelled.has(msg.id) });
      this.send({ type: 'response', id: msg.id, result });
    } catch (e) {
      this.send({ type: 'response', id: msg.id, error: String(e?.message || e) });
    } finally {
      this.inflight.delete(msg.id);
      this.cancelled.delete(msg.id);
    }
  }
}
