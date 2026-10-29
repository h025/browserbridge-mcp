// 浏览器扩展与 MCP 服务之间的本机 WebSocket 桥。
//
// 每个 Claude Code 会话都会启动一个 MCP 服务进程。第一个进程监听端口成为 hub，
// 浏览器扩展连到 hub；后续进程发现端口被占用后以 peer 身份连到 hub，请求经 hub 转发。
// hub 退出后，peer 会自动竞争接任，扩展也会自动重连。
//
// 每个进程是一个会话（session：{ id, client, folder, cwd }），请求都带上会话 ID，扩展据此给每个
// agent 单独一个标签组。hub 把自己和各 peer 的会话告诉扩展（type: 'session'），peer 断开时通知
// 扩展该会话结束（type: 'session_end'）；扩展重连或 hub 换人后会重新告知。

import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { say } from './i18n.js';

const EXTENSION_WAIT_MS = 15_000;
// 只接受本项目扩展的连接（manifest 里的 key 固定了扩展 ID），防止其他扩展冒充、截获 Claude 输入的内容。
// 修改了扩展 key 或使用其他构建时，用 BROWSER_BRIDGE_EXTENSION_IDS（逗号分隔）指定
const DEFAULT_EXTENSION_ID = 'oajlnlbllfohnlkecpodgediipicjajd';
const ALLOWED_ORIGINS = new Set(
  (process.env.BROWSER_BRIDGE_EXTENSION_IDS || DEFAULT_EXTENSION_ID)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => `chrome-extension://${id}`),
);
const log = (...args) => console.error('[browser-bridge]', ...args);

export class Bridge extends EventEmitter {
  constructor({ port, session }) {
    super();
    this.port = port;
    this.session = session;
    this.peerSessions = new Map(); // hub 上：peer 连接 -> 它的会话
    this.role = null; // 'hub' | 'peer'
    this.wss = null;
    this.hubSocket = null;
    this.extensions = []; // 最新连接的扩展排在最后
    this.pending = new Map(); // id -> { resolve, reject, timer, socket }
    this.nextId = 1;
    this.closed = false;
  }

  start() {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port: this.port,
        maxPayload: 64 * 1024 * 1024,
        verifyClient: ({ origin, req }) => {
          const path = new URL(req.url, 'http://localhost').pathname;
          // 网页无法伪造 Origin，以此拒绝来自普通网站的连接
          if (path === '/extension') {
            if (ALLOWED_ORIGINS.has(origin)) return true;
            log(`拒绝未授权的扩展连接：${origin}`);
            return false;
          }
          if (path === '/peer') return origin === undefined;
          return false;
        },
      });
      wss.once('listening', () => {
        this.role = 'hub';
        this.wss = wss;
        wss.on('connection', (ws, req) => this.onConnection(ws, req));
        log(`hub 已监听 ws://127.0.0.1:${this.port}`);
        resolve();
      });
      wss.once('error', (err) => {
        wss.close();
        if (err.code === 'EADDRINUSE') {
          this.connectAsPeer().then(resolve);
        } else {
          log('监听失败：', err.message);
          setTimeout(() => this.start().then(resolve), 2000);
        }
      });
    });
  }

  connectAsPeer() {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/peer`);
      ws.once('open', () => {
        this.role = 'peer';
        this.hubSocket = ws;
        this.retryDelay = 0;
        log('已作为 peer 连接到现有 hub');
        this.announce();
        resolve();
      });
      ws.on('message', (data) => this.onResponse(parse(data)));
      ws.on('error', () => {});
      ws.once('close', () => {
        if (this.hubSocket === ws) {
          this.hubSocket = null;
          this.role = null;
          this.failPending(ws, '与 hub 的连接中断，请重试');
        }
        if (this.closed) return resolve();
        // hub 退出了（或端口被其他程序占用），随机延迟后重新竞争 hub，失败则逐步退避
        this.retryDelay = Math.min((this.retryDelay || 0) * 2 || 200, 5000);
        setTimeout(() => this.start().then(resolve), this.retryDelay * (0.5 + Math.random()));
      });
    });
  }

  onConnection(ws, req) {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/extension') {
      this.extensions.push(ws);
      log('浏览器扩展已连接');
      // 告诉扩展当前有哪些会话（hub 自己和所有 peer）
      for (const s of [this.session, ...this.peerSessions.values()]) if (s) send(ws, { type: 'session', session: s });
      this.emit('extension');
      ws.on('message', (data) => {
        const msg = parse(data);
        if (msg?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        else if (msg?.type === 'hello') log(`扩展版本 ${msg.version}`);
        else this.onResponse(msg);
      });
      ws.on('close', () => {
        this.extensions = this.extensions.filter((s) => s !== ws);
        this.failPending(ws, '浏览器扩展连接中断，请重试');
        log('浏览器扩展已断开');
      });
    } else {
      // peer：把它的请求当作本地请求执行，再把结果发回去；peer 取消请求时转发给扩展
      const controllers = new Map(); // peer 的请求 ID -> AbortController
      ws.on('message', async (data) => {
        const msg = parse(data);
        if (msg?.type === 'cancel') {
          controllers.get(msg.id)?.abort();
          return;
        }
        if (msg?.type === 'hello' && msg.session?.id) {
          this.peerSessions.set(ws, msg.session);
          this.broadcast({ type: 'session', session: msg.session });
          return;
        }
        if (msg?.type !== 'request') return;
        const controller = new AbortController();
        controllers.set(msg.id, controller);
        try {
          const session = msg.session ?? this.peerSessions.get(ws)?.id;
          const result = await this.call(msg.tool, msg.args, { timeoutMs: msg.timeoutMs, signal: controller.signal, session });
          send(ws, { type: 'response', id: msg.id, result });
        } catch (e) {
          send(ws, { type: 'response', id: msg.id, error: e.message });
        } finally {
          controllers.delete(msg.id);
        }
      });
      ws.on('close', () => {
        for (const c of controllers.values()) c.abort();
        const s = this.peerSessions.get(ws);
        this.peerSessions.delete(ws);
        if (s) this.broadcast({ type: 'session_end', id: s.id });
      });
    }
  }

  onResponse(msg) {
    if (msg?.type !== 'response') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }

  failPending(socket, reason) {
    for (const [id, p] of this.pending) {
      if (p.socket !== socket) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  async waitForExtension(ms) {
    if (this.extensions.length) return this.extensions.at(-1);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('extension', onExt);
        reject(
          new Error(say(
            `浏览器扩展未连接（端口 ${this.port}）。请确认：1) Chrome 正在运行且已启用 Browser Bridge 扩展；` +
              '2) 扩展弹窗里的端口与 MCP 服务一致。扩展每 30 秒自动重连，也可以点扩展图标里的“重连”。',
            `The Browser Bridge extension is not connected (port ${this.port}). Check that Chrome is running with the extension enabled ` +
              'and that the port in its popup matches this server. It reconnects every 30 seconds; the popup also has a Reconnect button.',
          )),
        );
      }, Math.max(ms, 0));
      const onExt = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('extension', onExt);
    });
    return this.extensions.at(-1);
  }

  // 找到请求的发送目标：hub 直接发给扩展，peer 发给 hub；正在启动或切换角色时稍等
  async target() {
    const deadline = Date.now() + EXTENSION_WAIT_MS;
    while (Date.now() < deadline) {
      if (this.role === 'hub') return this.waitForExtension(deadline - Date.now());
      if (this.role === 'peer' && this.hubSocket?.readyState === WebSocket.OPEN) return this.hubSocket;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(say('无法连接浏览器桥（hub 正在切换），请稍后重试', 'Could not reach the bridge while its hub was changing over; try again in a moment.'));
  }

  // 把本进程的会话信息告诉扩展（hub 直接发，peer 经 hub 转发）；客户端名称在 MCP 握手后才知道，届时再发一次
  announce() {
    if (!this.session) return;
    if (this.role === 'hub') this.broadcast({ type: 'session', session: this.session });
    else if (this.role === 'peer' && this.hubSocket) send(this.hubSocket, { type: 'hello', session: this.session });
  }

  broadcast(obj) {
    for (const ws of this.extensions) send(ws, obj);
  }

  // signal 被中止（MCP 客户端取消了调用）时通知执行方并立即返回；session 是发起请求的会话 ID（默认本进程）
  async call(tool, args = {}, { timeoutMs = 120_000, signal, session = this.session?.id } = {}) {
    const socket = await this.target();
    if (signal?.aborted) throw new Error('Cancelled by the client');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        send(socket, { type: 'cancel', id });
        reject(new Error('Cancelled by the client'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(say(`工具 ${tool} 执行超时（${Math.round(timeoutMs / 1000)} 秒）`, `${tool} gave no result within ${Math.round(timeoutMs / 1000)}s.`)));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        socket,
        timer,
        resolve: (v) => {
          cleanup();
          resolve(v);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      });
      send(socket, { type: 'request', id, tool, args, timeoutMs, session });
    });
  }

  close() {
    this.closed = true;
    this.hubSocket?.close();
    for (const ws of this.extensions) ws.close();
    this.wss?.close();
  }
}

function parse(data) {
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
