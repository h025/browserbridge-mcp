// 跟踪 Claude 在各标签页上的活动：
// - 执行工具时在页面上显示指示器（发光边框、光标、停止按钮），标签组标题加 ⌛
// - 标签页 20 秒没有新操作就隐藏指示器并断开调试器（Chrome 的“正在调试”提示条随之消失），标题改为 ✅
// - MCP 服务断开时释放所有标签页，某个会话结束时释放它的标签页；标签页被拖出标签组时立即释放
// - 用户点击页面上的“停止”后，该标签页所属会话（agent）的下一次调用会被拒绝，其他会话不受影响
import { detachAllDebuggers, detachDebugger, setBusyChecker, sleep } from './cdp.js';
import { clearAllPrefixes, groupOfSession, sessionOfGroup, setGroupPrefix } from './tabs.js';

const IDLE_RELEASE_MS = 20_000;
const STOP_VALID_MS = 120_000;

const running = new Map(); // tabId -> 正在执行的工具数
const idleTimers = new Map();
const activeTabs = new Set(); // 正在显示指示器的标签页
const tabGroups = new Map(); // 活动标签页 -> 所在标签组
const stopRequests = new Map(); // 会话 ID -> 用户点击“停止”的时间

export function initActivity() {
  setBusyChecker((tabId) => running.has(tabId));
  // 页面跳转后内容脚本会重新加载，需要重新显示指示器
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'complete' && activeTabs.has(tabId)) sendToIndicator(tabId, { type: 'BB_SHOW' });
    if (info.groupId !== undefined && activeTabs.has(tabId) && info.groupId !== tabGroups.get(tabId)) release(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    clearTimeout(idleTimers.get(tabId));
    idleTimers.delete(tabId);
    running.delete(tabId);
    activeTabs.delete(tabId);
    tabGroups.delete(tabId);
  });
}

// 发消息给页面里的指示器脚本；扩展安装前已打开的页面没有内容脚本，按需注入
export async function sendToIndicator(tabId, message, { timeoutMs = 500 } = {}) {
  const send = () => Promise.race([
    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
    sleep(timeoutMs).then(() => null),
  ]);
  try {
    return await send();
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/indicator.js'] });
      return await send();
    } catch {
      return null;
    }
  }
}

export async function toolStarted(tabId) {
  clearTimeout(idleTimers.get(tabId));
  idleTimers.delete(tabId);
  running.set(tabId, (running.get(tabId) || 0) + 1);
  if (!activeTabs.has(tabId)) {
    activeTabs.add(tabId);
    sendToIndicator(tabId, { type: 'BB_SHOW' });
  }
  const groupId = (await chrome.tabs.get(tabId).catch(() => null))?.groupId;
  if (groupId != null && groupId >= 0) {
    tabGroups.set(tabId, groupId);
    setGroupPrefix(groupId, '⌛').catch(() => {});
  }
}

export function toolFinished(tabId) {
  const n = (running.get(tabId) || 1) - 1;
  if (n > 0) {
    running.set(tabId, n);
    return;
  }
  running.delete(tabId);
  clearTimeout(idleTimers.get(tabId));
  idleTimers.set(tabId, setTimeout(() => release(tabId), IDLE_RELEASE_MS));
}

async function release(tabId) {
  clearTimeout(idleTimers.get(tabId));
  idleTimers.delete(tabId);
  if (running.get(tabId)) return;
  activeTabs.delete(tabId);
  await sendToIndicator(tabId, { type: 'BB_HIDE' });
  // 隐藏指示器期间可能有新的工具开始执行，此时不能断开调试器
  if (running.get(tabId) || activeTabs.has(tabId)) return;
  const groupId = tabGroups.get(tabId);
  tabGroups.delete(tabId);
  await detachDebugger(tabId);
  // 组里没有其他正在操作的标签页时标记为已完成
  if (groupId != null && ![...tabGroups.values()].includes(groupId)) setGroupPrefix(groupId, '✅').catch(() => {});
}

// 页面指示器的心跳：Service Worker 重启后状态丢失，指示器据此自行隐藏
export function isTabActive(tabId) {
  return activeTabs.has(tabId);
}

// Service Worker 启动时不可能有工具在执行：断开上次遗留的调试会话、清除标签组状态前缀
export async function cleanupOnStartup() {
  await detachAllDebuggers().catch(() => {});
  await clearAllPrefixes().catch(() => {});
}

// MCP 服务全部断开：释放所有标签页
export async function releaseAll() {
  for (const t of idleTimers.values()) clearTimeout(t);
  idleTimers.clear();
  running.clear();
  const tabs = [...activeTabs];
  activeTabs.clear();
  tabGroups.clear();
  await Promise.all(tabs.map((tabId) => sendToIndicator(tabId, { type: 'BB_HIDE' })));
  await detachAllDebuggers();
  await clearAllPrefixes().catch(() => {});
}

// 某个会话结束（agent 退出）：释放它标签组里的标签页，清除状态前缀
export async function releaseSession(session) {
  stopRequests.delete(session);
  const groupId = await groupOfSession(session);
  if (groupId == null) return;
  const tabs = [...tabGroups].filter(([, gid]) => gid === groupId).map(([tabId]) => tabId);
  await Promise.all(tabs.map((tabId) => release(tabId)));
  await setGroupPrefix(groupId, null);
}

// 用户在某个标签页上点了“停止”：只拦下该标签页所属的会话
export async function requestStop(tabId) {
  const groupId = (await chrome.tabs.get(tabId).catch(() => null))?.groupId;
  const session = await sessionOfGroup(groupId);
  if (!session) return false;
  stopRequests.set(session, Date.now());
  const tabs = [...activeTabs].filter((t) => tabGroups.get(t) === groupId);
  await Promise.all(tabs.map((t) => sendToIndicator(t, { type: 'BB_HIDE' })));
  for (const t of tabs) activeTabs.delete(t);
  return true;
}

// 该会话的用户点了“停止”时返回 true（只生效一次，2 分钟后自动失效）
export function consumeStopRequest(session) {
  const at = stopRequests.get(session);
  if (!at) return false;
  stopRequests.delete(session);
  return Date.now() - at < STOP_VALID_MS;
}

export function stopPending(session) {
  const at = stopRequests.get(session);
  return !!at && Date.now() - at < STOP_VALID_MS;
}

// 截图、点击期间临时隐藏指示器，避免出现在截图里或挡住点击
export async function hideIndicatorForTool(tabId, { cursor = true } = {}) {
  if (!activeTabs.has(tabId)) return;
  await sendToIndicator(tabId, { type: 'BB_HIDE_FOR_TOOL', cursor }, { timeoutMs: 300 });
  await sleep(50);
}

export function showIndicatorAfterTool(tabId) {
  if (activeTabs.has(tabId)) sendToIndicator(tabId, { type: 'BB_SHOW_AFTER_TOOL' });
}

// 把页面上的光标动画移动到 (x, y)（CSS 像素），最多等 250ms
export async function moveCursor(tabId, x, y) {
  if (!activeTabs.has(tabId)) return;
  await sendToIndicator(tabId, { type: 'BB_CURSOR', x: Math.round(x), y: Math.round(y) }, { timeoutMs: 250 });
}
