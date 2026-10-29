import { applyI18n, t } from './src/i18n.js';

const $ = (id) => document.getElementById(id);
const STATE_KEY = { connected: 'stateConnected', connecting: 'stateConnecting', disconnected: 'stateDisconnected' };

applyI18n();

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  $('dot').className = `dot ${s.state}`;
  $('state').textContent = t('stateWithPort', [STATE_KEY[s.state] ? t(STATE_KEY[s.state]) : s.state, String(s.port)]);
  $('err').textContent = s.state === 'connected' ? '' : s.lastError || t('waitingServer');
  if (document.activeElement !== $('port')) $('port').value = s.port;
}

$('save').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'setPort', port: $('port').value });
  setTimeout(refresh, 300);
};

$('reconnect').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(refresh, 300);
};

$('share').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await chrome.runtime.sendMessage({ type: 'shareTab', tabId: tab.id });
  $('share').textContent = res.error ? t('shareFailed', [res.error]) : t('shareDone', [String(res.tabId)]);
};

$('aiSettings').onclick = () => chrome.runtime.openOptionsPage();

async function showAiMode() {
  const { aiConfig: c } = await chrome.storage.local.get('aiConfig');
  $('aiMode').textContent = c?.baseUrl && c?.model ? t('findModeAi', [c.model]) : t('findModeKeyword');
}

refresh();
showAiMode();
setInterval(refresh, 1000);
