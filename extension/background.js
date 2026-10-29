import { cleanupOnStartup, initActivity, isTabActive, releaseAll, requestStop } from './src/activity.js';
import { Bridge, DEFAULT_PORT } from './src/bridge.js';
import { initCdp } from './src/cdp.js';
import { closeOffscreen, ensureOffscreen } from './src/gif.js';
import { initScreenshotState } from './src/screenshot.js';
import { addTabToGroup } from './src/tabs.js';
import { runTool } from './src/tools.js';

// 所有监听器必须在顶层同步注册，Service Worker 被唤醒时才能收到事件
initCdp();
initActivity();
initScreenshotState();
// 清理上次遗留的调试会话；完成之前不执行工具，避免刚附加的调试器被清理掉
const startupCleanup = cleanupOnStartup();

const bridge = new Bridge((name, args, opts) => startupCleanup.then(() => runTool(name, args, opts)), {
  // 连接期间用离屏文档保活，避免后台节流导致连接中断
  onConnected: () => ensureOffscreen().catch(() => {}),
  // MCP 服务全部断开：隐藏指示器、断开所有调试器
  onDisconnected: () => {
    releaseAll().catch(() => {});
    closeOffscreen();
  },
});

chrome.alarms.create('bb-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bb-reconnect') bridge.ensureConnected();
});
chrome.runtime.onStartup.addListener(() => bridge.ensureConnected());
chrome.runtime.onInstalled.addListener(() => bridge.ensureConnected());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 发给离屏文档的消息由它自己处理
  if (msg?.type === 'BB_GENERATE_GIF') return false;
  (async () => {
    switch (msg?.type) {
      case 'BB_KEEPALIVE':
        return { ok: true };
      case 'BB_INDICATOR_HEARTBEAT':
        return { active: sender.tab ? isTabActive(sender.tab.id) : false };
      case 'BB_STOP':
        // 只接受来自标签页内容脚本（页面上的“停止 Claude”按钮）的请求
        if (!sender.tab) return { ok: false };
        await requestStop();
        return { ok: true };
      case 'status':
        return { ...bridge.status(), defaultPort: DEFAULT_PORT };
      case 'setPort':
        await chrome.storage.local.set({ port: Number(msg.port) || DEFAULT_PORT });
        bridge.reconnect();
        return { ok: true };
      case 'reconnect':
        bridge.reconnect();
        return { ok: true };
      case 'shareTab': {
        const tab = await addTabToGroup(msg.tabId);
        return { ok: true, tabId: tab.id };
      }
      default:
        return { error: 'unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

bridge.ensureConnected();
