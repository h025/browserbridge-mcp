import { cleanupOnStartup, initActivity, isTabActive, releaseAll, releaseSession } from './src/activity.js';
import { Bridge, DEFAULT_PORT } from './src/bridge.js';
import { initCdp } from './src/cdp.js';
import { closeOffscreen, ensureOffscreen } from './src/gif.js';
import { initScreenshotState } from './src/screenshot.js';
import { addTabToGroup, DEFAULT_SESSION, endSession, liveSessions, markAllOffline, markConnected, registerSession } from './src/tabs.js';
import { runTool } from './src/tools.js';

// 所有监听器必须在顶层同步注册，Service Worker 被唤醒时才能收到事件
initCdp();
initActivity();
initScreenshotState();
// 清理上次遗留的调试会话；完成之前不执行工具，避免刚附加的调试器被清理掉
const startupCleanup = cleanupOnStartup();

// 每个请求带着发起它的会话（agent）；旧版 MCP 服务不带，归入默认会话
const bridge = new Bridge((name, args, opts) => startupCleanup.then(() => runTool(name, args, { ...opts, session: opts.session || DEFAULT_SESSION })), {
  // 连接期间用离屏文档保活，避免后台节流导致连接中断
  onConnected: () => {
    markConnected();
    ensureOffscreen().catch(() => {});
  },
  // MCP 服务全部断开：隐藏指示器、断开所有调试器；重连后服务会重新告知各会话
  onDisconnected: () => {
    markAllOffline();
    releaseAll().catch(() => {});
    closeOffscreen();
  },
  onSession: (session) => registerSession(session).catch(() => {}),
  // agent 退出：释放它的标签页，标签组保留
  onSessionEnd: (id) => {
    endSession(id).catch(() => {});
    releaseSession(id).catch(() => {});
  },
});

chrome.alarms.create('bb-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bb-reconnect') bridge.ensureConnected();
});
chrome.runtime.onStartup.addListener(() => bridge.ensureConnected());
chrome.runtime.onInstalled.addListener(() => bridge.ensureConnected());
// 0.7.5 及以前可以在设置页填写外部 AI 接口（地址、Key、模型），现在不再需要：安装或升级时清掉留在本机的配置
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove('aiConfig').catch(() => {}));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 发给离屏文档的消息由它自己处理
  if (msg?.type === 'BB_GENERATE_GIF') return false;
  (async () => {
    switch (msg?.type) {
      case 'BB_KEEPALIVE':
        return { ok: true };
      case 'BB_INDICATOR_HEARTBEAT':
        return { active: sender.tab ? isTabActive(sender.tab.id) : false };
      case 'status':
        return { ...bridge.status(), defaultPort: DEFAULT_PORT };
      case 'setPort':
        await chrome.storage.local.set({ port: Number(msg.port) || DEFAULT_PORT });
        bridge.reconnect();
        return { ok: true };
      case 'reconnect':
        bridge.reconnect();
        return { ok: true };
      case 'sessions':
        return { sessions: await liveSessions() };
      case 'shareTab': {
        const tab = await addTabToGroup(msg.tabId, msg.session || DEFAULT_SESSION);
        return { ok: true, tabId: tab.id };
      }
      default:
        return { error: 'unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

bridge.ensureConnected();
