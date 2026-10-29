// 端到端测试公共部分：本地测试网站、加载了扩展的 Chrome for Testing、MCP 客户端，
// 以及通过远程调试端口模拟“用户”的真实操作（点击、截取包含页面指示器的画面）。
//
// 环境变量：
//   CHROME_PATH  Chrome for Testing 可执行文件（默认用 Playwright 缓存里的）
//   EXT_DIR      要加载的扩展目录（默认项目里的 extension/）
//   SERVER_CMD   启动 MCP 服务的命令，JSON：{"command":"node","args":["…"]}（默认项目源码）
//   HEADFUL=1    用有界面的 Chrome（默认无头）
//   BB_LANG      浏览器界面语言（默认 zh-CN；扩展界面文字跟随它）
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const HERE = join(ROOT, 'tests/e2e');
export const EXT_ID = 'oajlnlbllfohnlkecpodgediipicjajd';
export const DEBUG_PORT = 9333;
// 测试专用端口：与日常使用的 18765 分开，测试浏览器和测试服务只会互相连接，
// 不会连到你正在使用的 Claude Code 会话和 Chrome 上
export const TEST_PORT = 18790;
const MODULES = join(ROOT, 'mcp-server/node_modules');
const { Client } = await import(join(MODULES, '@modelcontextprotocol/sdk/dist/esm/client/index.js'));
const { StdioClientTransport } = await import(join(MODULES, '@modelcontextprotocol/sdk/dist/esm/client/stdio.js'));
export const WebSocket = (await import(join(MODULES, 'ws/index.js'))).default;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME_PATH = process.env.CHROME_PATH
  || join(homedir(), 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

function startSite() {
  return createServer((req, res) => {
    if (req.url.startsWith('/api/ping')) {
      res.setHeader('content-type', 'text/plain');
      return res.end('pong');
    }
    if (req.url.startsWith('/redir')) {
      res.statusCode = 302;
      res.setHeader('location', '/test.html?redirected');
      return res.end();
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(readFileSync(join(HERE, 'site/test.html')));
  }).listen(18801, '127.0.0.1');
}

// 启动一套测试环境；返回调用工具、断言、模拟用户等辅助函数
// 端口已被占用（例如上一次测试没退出）时直接报错，避免测试连到别的服务上
async function assertPortFree(port) {
  const inUse = await new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/', timeout: 500 }, () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
  if (inUse) throw new Error(`测试端口 ${port} 已被占用，请先结束占用它的进程`);
}

// 复制一份扩展，把默认端口改成测试端口
function prepareExtension(work) {
  const src = process.env.EXT_DIR || join(ROOT, 'extension');
  const dst = join(work, 'extension');
  cpSync(src, dst, { recursive: true });
  const bridge = join(dst, 'src/bridge.js');
  const code = readFileSync(bridge, 'utf8');
  if (!code.includes('export const DEFAULT_PORT = 18765;')) throw new Error('扩展的 DEFAULT_PORT 定义已变化，请更新测试脚本');
  writeFileSync(bridge, code.replace('export const DEFAULT_PORT = 18765;', `export const DEFAULT_PORT = ${TEST_PORT};`));
  return dst;
}

export async function setup({ windowSize = '1280,860', dpr, lang = process.env.BB_LANG || 'zh-CN' } = {}) {
  await assertPortFree(TEST_PORT);
  await assertPortFree(DEBUG_PORT);
  const site = startSite();
  const work = mkdtempSync(join(tmpdir(), 'bb-e2e-'));
  const profile = join(work, 'profile');
  const extDir = prepareExtension(work);
  const flags = process.env.HEADFUL ? ['--window-position=40,40'] : ['--headless=new'];
  const langFlags = [`--lang=${lang}`];
  const chrome = spawn(CHROME_PATH, [
    `--user-data-dir=${profile}`, `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--remote-debugging-port=${DEBUG_PORT}`, `--window-size=${windowSize}`, ...(dpr ? [`--force-device-scale-factor=${dpr}`] : []),
    ...langFlags, ...flags, 'about:blank',
  ], { stdio: 'ignore', env: { ...process.env, LANG: `${lang.replace('-', '_')}.UTF-8` } });

  const server = process.env.SERVER_CMD ? JSON.parse(process.env.SERVER_CMD) : { command: 'node', args: [join(ROOT, 'mcp-server/src/cli.js')] };
  const clients = [];
  // 每个客户端启动一个 MCP 服务进程，相当于一个独立的 agent；name 是 MCP 客户端名称（决定标签组名）
  const connect = async (name = 'e2e') => {
    const c = new Client({ name, version: '0' });
    await c.connect(new StdioClientTransport({ ...server, cwd: HERE, env: { ...process.env, BROWSER_BRIDGE_PORT: String(TEST_PORT) }, stderr: 'ignore' }));
    clients.push(c);
    return c;
  };
  const client = await connect();

  let failures = 0;
  const expect = (ok, message) => {
    console.log(`  ${ok ? '✅' : '❌'} ${message}`);
    if (!ok) failures++;
  };
  // 调用工具：返回去掉 Tab Context 的文本、第一张图片、是否出错
  const callWith = async (c, name, args = {}, { expectError = false, quiet = false, signal } = {}) => {
    const r = await c.callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined);
    const text = r.content.filter((x) => x.type === 'text').map((x) => x.text).join('').split('\n\nTab Context')[0].trim();
    const images = r.content.filter((x) => x.type === 'image');
    const bad = !!r.isError !== expectError;
    if (bad) failures++;
    if (!quiet || bad) console.log(`=== ${name} ${JSON.stringify(args).slice(0, 100)} ${bad ? '❌' : '✅'}\n${text.slice(0, 500)}${images.length ? `\n(${images.length} 张图片)` : ''}`);
    return { t: text, img: images[0], imgs: images, isError: !!r.isError };
  };
  const call = (name, args, opts) => callWith(client, name, args, opts);
  const js = async (tabId, code) => (await call('javascript_tool', { action: 'javascript_exec', text: code, tabId }, { quiet: true })).t;
  const refOf = (text, re) => {
    const line = text.split('\n').find((l) => re.test(l));
    return line?.match(/(ref_\d+)/)?.[1];
  };

  const done = async () => {
    console.log(`\n失败数：${failures}`);
    // 等 Chrome 真正退出，否则下一套测试会连到还没退出的旧浏览器上
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    const timer = setTimeout(() => chrome.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
    site.close();
    for (const c of clients) await c.close().catch(() => {});
    await sleep(300);
    rmSync(work, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
  };
  const fail = (e) => {
    failures++;
    console.error('FATAL', e);
  };
  return { client, connect, call, callWith, js, refOf, expect, done, fail, failures: () => failures };
}

// 通过远程调试端口连接某个页面，模拟“用户”的操作
export async function userPage(match) {
  let target;
  for (let i = 0; i < 20 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    target = list.find((t) => (typeof match === 'string' ? t.url.includes(match) : match(t)));
    if (!target) await sleep(250);
  }
  if (!target) throw new Error(`找不到页面：${match}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  }).then((m) => m.result);
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
  // 截取视口左边缘中部一小块，返回其 RGB：显示页面指示器时为橙色发光，否则为白色
  const edgeColor = async () => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 300, width: 4, height: 4, scale: 1 } });
    return evaluate(`(async () => { const b = await (await fetch('data:image/png;base64,${data}')).blob(); const bm = await createImageBitmap(b); const c = new OffscreenCanvas(bm.width, bm.height); const x = c.getContext('2d'); x.drawImage(bm, 0, 0); return Array.from(x.getImageData(1, 1, 1, 1).data.slice(0, 3)); })()`);
  };
  // 沿左边缘取一列点，返回其中最高的饱和度：光晕显示时边缘是彩色（多层光晕颜色在转，单点可能刚好偏淡），隐藏后是白色
  const edgeSaturation = async () => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 4, height: 500, scale: 1 } });
    return evaluate(`(async () => { const bm = await createImageBitmap(await (await fetch('data:image/png;base64,${data}')).blob()); const c = new OffscreenCanvas(bm.width, bm.height); const x = c.getContext('2d'); x.drawImage(bm, 0, 0); let best = 0; for (let y = 10; y < bm.height; y += 15) { const d = x.getImageData(1, y, 1, 1).data; best = Math.max(best, Math.max(d[0], d[1], d[2]) - Math.min(d[0], d[1], d[2])); } return best; })()`);
  };
  return { send, evaluate, edgeColor, edgeSaturation, close: () => ws.close() };
}

// 用新标签页打开 URL（例如扩展的设置页），返回该页面的调试连接
export async function openPage(url) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
  const browser = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => browser.once('open', r));
  browser.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url } }));
  await new Promise((r) => browser.once('message', r));
  browser.close();
  await sleep(600);
  return userPage((t) => t.url === url);
}

// 浏览器级调试连接（列出/关闭 Service Worker 等）
export async function browserSession() {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { send, close: () => ws.close() };
}
