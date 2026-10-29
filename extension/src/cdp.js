// chrome.debugger（Chrome DevTools Protocol）封装：
// - 附加调试器后开启焦点模拟，后台标签页无需切到前台也能正常交互、截图
// - 按页面域名收集控制台日志和网络请求，跳转到其他域名时自动清空
// - 处理 beforeunload（“离开此网站？”）和 alert/confirm/prompt 对话框，避免页面被阻塞

export const ATTACH_TIMEOUT_MS = 10_000;
export const COMMAND_TIMEOUT_MS = 30_000;
const MAX_LOGS_PER_TAB = 1000;
const MAX_REQUESTS_PER_TAB = 1000;
const PROTECTED_PROTOCOLS = new Set(['chrome:', 'chrome-extension:', 'devtools:', 'chrome-search:', 'chrome-untrusted:']);

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, makeError) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(makeError()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function protectedProtocol(url) {
  try {
    const { protocol } = new URL(url);
    return PROTECTED_PROTOCOLS.has(protocol) ? protocol : null;
  } catch {
    return null;
  }
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname || 'unknown';
  } catch {
    return 'unknown';
  }
}

const attached = new Set();
const attachInFlight = new Map();
const consoleByTab = new Map(); // tabId -> { domain, messages }
const networkByTab = new Map(); // tabId -> { domain, requests }
const pageDomainByTab = new Map();
const beforeunloadPolicy = new Map(); // tabId -> 'accept' | 'dismiss'
const beforeunloadOutcome = new Map(); // tabId -> { action, url }
const beforeunloadWaiters = new Map();
const dialogNotes = new Map(); // tabId -> string[]
const openDialogs = new Map(); // tabId -> 留给用户处理的对话框参数
const runtimeEnabledAt = new Map(); // tabId -> 开启 Runtime 的时间，用于识别 Runtime.enable 重放的旧日志
// 控制台、网络记录在第一次读取时才开启：附加调试器时不主动开启这些调试功能，
// 降低被网站反自动化检测识别的可能；开启后调试器重新附加时自动恢复
const consoleTracking = new Set();
const networkTracking = new Set();

const mutedByUs = new Set();

// 由 activity.js 注入：该标签页上是否有工具正在执行
let isTabBusy = () => false;
export function setBusyChecker(fn) {
  isTabBusy = fn;
}

export function initCdp() {
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(({ tabId }) => {
    if (tabId == null) return;
    attached.delete(tabId);
    resolveBeforeunloadWaiter(tabId);
    liftMute(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    mutedByUs.delete(tabId);
    for (const m of [consoleByTab, networkByTab, pageDomainByTab, beforeunloadPolicy, beforeunloadOutcome, dialogNotes, openDialogs, runtimeEnabledAt, consoleTracking, networkTracking]) m.delete(tabId);
    resolveBeforeunloadWaiter(tabId);
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => liftMute(tabId));
}

// 焦点模拟会让后台标签页变成“可见”，暂停的音视频可能突然出声：先静音 5 秒，
// 届时仍在播放就保持静音，直到用户切到该标签页或调试器断开
async function muteForFocusEmulation(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active || tab.audible || tab.mutedInfo?.muted) return;
    await chrome.tabs.update(tabId, { muted: true });
    mutedByUs.add(tabId);
    setTimeout(async () => {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (t && !t.audible) liftMute(tabId);
    }, 5000);
  } catch {
    // 标签页已关闭
  }
}

async function liftMute(tabId) {
  if (!mutedByUs.delete(tabId)) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.mutedInfo?.muted && tab.mutedInfo.extensionId === chrome.runtime.id) await chrome.tabs.update(tabId, { muted: false });
  } catch {
    // 标签页已关闭
  }
}

export async function detachDebugger(tabId) {
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  liftMute(tabId);
}

export async function detachAllDebuggers() {
  const targets = await chrome.debugger.getTargets();
  const ours = new Set(attached);
  for (const t of targets) if (t.attached && t.tabId != null) ours.add(t.tabId);
  await Promise.all([...ours].map((tabId) => detachDebugger(tabId)));
}

// 其他扩展（如密码管理器）注入的 iframe 会让 chrome.debugger.attach 报
// “Cannot access a chrome-extension:// URL of different extension”，移除这些 iframe 后重试
async function stripForeignExtensionFrames(tabId) {
  const own = `chrome-extension://${chrome.runtime.id}`;
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    injectImmediately: true,
    func: (ownOrigin) => {
      const roots = [document];
      while (roots.length) {
        const root = roots.pop();
        for (const el of root.querySelectorAll('*')) {
          if (el instanceof HTMLIFrameElement) {
            const src = el.getAttribute('src') || '';
            if (/^chrome-extension:\/\//i.test(src) && !src.startsWith(ownOrigin)) el.remove();
          }
          const shadow = chrome.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot;
          if (shadow) roots.push(shadow);
        }
      }
    },
    args: [own],
  }).catch(() => {});
}

function rawSend(tabId, method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
  return withTimeout(
    chrome.debugger.sendCommand({ tabId }, method, params),
    timeoutMs,
    () => new ToolError('cdp_timeout', `CDP command "${method}" timed out after ${timeoutMs}ms on tab ${tabId}. The page may be frozen or unresponsive.`),
  );
}

export function ensureAttached(tabId) {
  if (attached.has(tabId)) return Promise.resolve();
  if (!attachInFlight.has(tabId)) {
    attachInFlight.set(tabId, attach(tabId).finally(() => attachInFlight.delete(tabId)));
  }
  return attachInFlight.get(tabId);
}

async function attach(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const proto = protectedProtocol(tab.url || tab.pendingUrl);
  if (proto) {
    throw new ToolError('chrome_protected_page', `Cannot control ${proto}// pages. Navigate to a regular web page (http:// or https://) first, then retry.`);
  }
  const rawAttach = () => withTimeout(
    chrome.debugger.attach({ tabId }, '1.3'),
    ATTACH_TIMEOUT_MS,
    () => new ToolError('debugger_attach_failed', `Attaching the debugger timed out after ${ATTACH_TIMEOUT_MS}ms on tab ${tabId}. The renderer may have crashed.`),
  );
  try {
    try {
      await rawAttach();
    } catch (e) {
      if (!/URL of different extension/i.test(String(e?.message))) throw e;
      let lastError = e;
      for (let i = 0; i < 4; i++) {
        await stripForeignExtensionFrames(tabId);
        await sleep(75);
        try {
          await rawAttach();
          lastError = null;
          break;
        } catch (retryError) {
          lastError = retryError;
        }
      }
      if (lastError) {
        throw new ToolError('blocked_by_other_extension', 'Another extension has embedded frames in this page that block automation. Disable that extension on this site and retry.');
      }
    }
  } catch (e) {
    if (!/already attached/i.test(String(e?.message))) throw e;
    // Service Worker 重启后内存状态会丢失，但调试会话可能仍属于本扩展
    try {
      await rawSend(tabId, 'Runtime.evaluate', { expression: '1' }, 3000);
    } catch {
      throw new ToolError('debugger_attach_failed', 'Another debugger (for example another extension) is already attached to this tab. Detach it and retry.');
    }
  }
  attached.add(tabId);
  pageDomainByTab.set(tabId, hostnameOf(tab.url));
  await Promise.allSettled([
    rawSend(tabId, 'Page.enable'),
    rawSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }),
    consoleTracking.has(tabId) && enableRuntime(tabId),
    networkTracking.has(tabId) && rawSend(tabId, 'Network.enable', { maxPostDataSize: 65536 }),
  ]);
  muteForFocusEmulation(tabId);
}

function enableRuntime(tabId) {
  runtimeEnabledAt.set(tabId, Date.now());
  return rawSend(tabId, 'Runtime.enable');
}

// 第一次读取控制台时开启：页面此前已输出的消息也会被补发
export async function enableConsoleTracking(tabId) {
  if (consoleTracking.has(tabId)) return;
  const wasAttached = attached.has(tabId);
  consoleTracking.add(tabId);
  // 尚未附加时，附加过程会按 consoleTracking 自动开启
  if (wasAttached) await enableRuntime(tabId).catch(() => {});
  else await ensureAttached(tabId);
  // 等补发的旧消息到达
  await sleep(100);
}

// 第一次读取网络请求时开启：只能记录开启之后的请求
export async function enableNetworkTracking(tabId) {
  if (networkTracking.has(tabId)) return;
  const wasAttached = attached.has(tabId);
  networkTracking.add(tabId);
  if (wasAttached) await rawSend(tabId, 'Network.enable', { maxPostDataSize: 65536 }).catch(() => {});
  else await ensureAttached(tabId);
}

export async function sendCommand(tabId, method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
  await ensureAttached(tabId);
  try {
    return await rawSend(tabId, method, params, timeoutMs);
  } catch (e) {
    if (!/not attached|detached while handling/i.test(String(e?.message))) throw e;
    attached.delete(tabId);
    await ensureAttached(tabId);
    return rawSend(tabId, method, params, timeoutMs);
  }
}

// 已附加时直接发送，不等待 ensureAttached，便于连续按键时保持顺序并流水线发送
export function sendCommandFast(tabId, method, params) {
  return attached.has(tabId) ? rawSend(tabId, method, params) : sendCommand(tabId, method, params);
}

function bucket(map, tabId, domain, key) {
  let b = map.get(tabId);
  if (!b || b.domain !== domain) {
    b = { domain, [key]: [] };
    map.set(tabId, b);
  }
  return b[key];
}

function pushCapped(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

// 重新附加调试器时，Runtime.enable 会重放页面里已有的控制台消息；已经记录过的跳过
function pushConsole(tabId, entry) {
  const list = bucket(consoleByTab, tabId, pageDomainByTab.get(tabId), 'messages');
  const replayed = entry.timestamp < (runtimeEnabledAt.get(tabId) ?? 0);
  if (replayed && list.some((m) => m.timestamp === entry.timestamp && m.type === entry.type && m.text === entry.text)) return;
  pushCapped(list, entry, MAX_LOGS_PER_TAB);
}

function onEvent({ tabId }, method, params) {
  if (tabId == null) return;
  switch (method) {
    case 'Page.frameNavigated': {
      if (params.frame.parentId) return;
      pageDomainByTab.set(tabId, hostnameOf(params.frame.url));
      resolveBeforeunloadWaiter(tabId);
      return;
    }
    case 'Runtime.consoleAPICalled': {
      let text = '';
      for (const arg of params.args || []) {
        if (text.length > 16384) break;
        const v = arg.value !== undefined ? (typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)) : arg.unserializableValue || arg.description || '';
        text += `${text ? ' ' : ''}${String(v).slice(0, 16384)}`;
      }
      const frame = params.stackTrace?.callFrames?.[0];
      pushConsole(tabId, {
        type: params.type || 'log',
        text,
        timestamp: params.timestamp || Date.now(),
        url: frame?.url,
        lineNumber: frame?.lineNumber,
        columnNumber: frame?.columnNumber,
      });
      return;
    }
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails;
      pushConsole(tabId, {
        type: 'exception',
        text: d?.exception?.description || d?.text || 'Unknown exception',
        timestamp: params.timestamp || Date.now(),
        url: d?.url,
        lineNumber: d?.lineNumber,
        columnNumber: d?.columnNumber,
        stackTrace: d?.stackTrace?.callFrames
          ?.map((f) => `    at ${f.functionName || '<anonymous>'} (${f.url}:${f.lineNumber}:${f.columnNumber})`)
          .join('\n'),
      });
      return;
    }
    case 'Network.requestWillBeSent': {
      // 重定向链共用同一个 requestId：先补上上一跳的状态码
      if (params.redirectResponse) {
        const prev = networkByTab.get(tabId)?.requests.findLast((r) => r.requestId === params.requestId);
        if (prev && prev.status == null) prev.status = params.redirectResponse.status;
      }
      // 以请求所属文档的域名分组：跳转到新域名时，主文档请求会开启新的分组
      const domain = hostnameOf(params.documentURL || params.request.url);
      const list = bucket(networkByTab, tabId, domain, 'requests');
      pushCapped(list, {
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        type: params.type || '',
        status: null,
      }, MAX_REQUESTS_PER_TAB);
      return;
    }
    case 'Network.responseReceived': {
      const req = networkByTab.get(tabId)?.requests.findLast((r) => r.requestId === params.requestId);
      if (req) req.status = params.response.status;
      return;
    }
    case 'Network.loadingFailed': {
      const req = networkByTab.get(tabId)?.requests.findLast((r) => r.requestId === params.requestId);
      if (req && req.status == null) req.status = params.canceled ? 'canceled' : `failed (${params.errorText})`;
      return;
    }
    case 'Page.javascriptDialogOpening':
      handleDialog(tabId, params);
      return;
    case 'Page.javascriptDialogClosed':
      openDialogs.delete(tabId);
  }
}

// 对话框处理：
// - navigate 期间的“离开此网站？”按 force 决定
// - 工具执行期间出现的对话框会阻塞页面和后续操作，自动处理：alert 确认，其他取消（更安全）
// - 其余时间（Claude 空闲、可能是用户自己操作）留给用户；Claude 下次操作该标签页时若仍未关闭再自动处理
function handleDialog(tabId, params) {
  const policy = beforeunloadPolicy.get(tabId);
  if (params.type === 'beforeunload' && policy) {
    const accept = policy === 'accept';
    beforeunloadPolicy.delete(tabId);
    beforeunloadOutcome.set(tabId, { action: accept ? 'accepted' : 'dismissed', url: params.url || '' });
    if (!accept) resolveBeforeunloadWaiter(tabId);
    chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept }).catch(() => {});
  } else if (isTabBusy(tabId)) {
    autoHandleDialog(tabId, params);
  } else {
    openDialogs.set(tabId, params);
  }
}

function autoHandleDialog(tabId, { type, message }) {
  const accept = type === 'alert';
  const notes = dialogNotes.get(tabId) || [];
  notes.push(type === 'beforeunload'
    ? 'A "Leave site?" dialog appeared and was dismissed, so the page did not navigate away. To leave anyway, use navigate with force: true.'
    : `A JavaScript ${type} dialog appeared ("${String(message).slice(0, 200)}") and was automatically ${accept ? 'accepted' : 'dismissed'}.`);
  dialogNotes.set(tabId, notes);
  chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept }).catch(() => {});
}

// 工具开始操作标签页时调用：处理之前留给用户、但仍未关闭的对话框
export function settlePendingDialog(tabId) {
  const params = openDialogs.get(tabId);
  if (!params) return;
  openDialogs.delete(tabId);
  autoHandleDialog(tabId, params);
}

export function takeDialogNotes(tabId) {
  const notes = dialogNotes.get(tabId) || [];
  dialogNotes.delete(tabId);
  return notes;
}

function resolveBeforeunloadWaiter(tabId) {
  const resolve = beforeunloadWaiters.get(tabId);
  if (resolve) {
    beforeunloadWaiters.delete(tabId);
    resolve();
  }
}

// 执行一次导航；若页面弹出“离开此网站？”，按 force 决定放弃修改还是取消导航
export async function navigateWithBeforeunload(tabId, force, run) {
  beforeunloadPolicy.set(tabId, force ? 'accept' : 'dismiss');
  beforeunloadOutcome.delete(tabId);
  await run();
  if (beforeunloadOutcome.get(tabId)?.action !== 'dismissed') {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        beforeunloadWaiters.delete(tabId);
        resolve();
      }, 300);
      beforeunloadWaiters.set(tabId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  const outcome = beforeunloadOutcome.get(tabId);
  beforeunloadOutcome.delete(tabId);
  beforeunloadPolicy.delete(tabId);
  return outcome || null;
}

export function getConsoleMessages(tabId, onlyErrors, pattern) {
  let list = consoleByTab.get(tabId)?.messages || [];
  if (onlyErrors) list = list.filter((m) => m.type === 'error' || m.type === 'exception');
  if (pattern) {
    try {
      const re = new RegExp(pattern, 'i');
      list = list.filter((m) => re.test(m.text));
    } catch {
      const p = pattern.toLowerCase();
      list = list.filter((m) => m.text.toLowerCase().includes(p));
    }
  }
  return list;
}

export function clearConsoleMessages(tabId) {
  consoleByTab.delete(tabId);
}

export function getNetworkRequests(tabId) {
  return networkByTab.get(tabId)?.requests || [];
}

export function clearNetworkRequests(tabId) {
  networkByTab.delete(tabId);
}
