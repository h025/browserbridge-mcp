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

// 已连接的 agent（每个有自己的标签组），选择把当前标签页交给谁
async function showSessions() {
  const { sessions = [] } = await chrome.runtime.sendMessage({ type: 'sessions' });
  const select = $('target');
  const ids = sessions.map((s) => s.id).join();
  if (select.dataset.ids !== ids) {
    const keep = select.value;
    select.replaceChildren(...sessions.map((s) => new Option(s.title, s.id)));
    if (sessions.some((s) => s.id === keep)) select.value = keep;
    select.dataset.ids = ids;
  }
  select.disabled = !sessions.length;
  $('share').disabled = !sessions.length;
  if (!sessions.length) select.replaceChildren(new Option(t('noAgents'), ''));
}

$('share').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await chrome.runtime.sendMessage({ type: 'shareTab', tabId: tab.id, session: $('target').value });
  $('share').textContent = res.error ? t('shareFailed', [res.error]) : t('shareDone', [String(res.tabId)]);
};

$('openSettings').onclick = () => chrome.runtime.openOptionsPage();

refresh();
showSessions();
setInterval(() => {
  refresh();
  showSessions();
}, 1000);
