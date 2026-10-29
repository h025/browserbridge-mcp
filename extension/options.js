import { aiEnabled, clearAiConfig, getAiConfig, saveAiConfig, testConnection } from './src/ai.js';
import { applyI18n, t } from './src/i18n.js';

applyI18n();
document.title = t('optionsTitle');

const $ = (id) => document.getElementById(id);
const fields = ['baseUrl', 'apiKey', 'model'];
const current = () => Object.fromEntries(fields.map((f) => [f, $(f).value.trim()]));

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

async function showMode() {
  const c = await getAiConfig();
  $('mode').textContent = aiEnabled(c) ? t('modeAi', [c.model]) : t('modeKeyword');
}

async function load() {
  const c = await getAiConfig();
  for (const f of fields) $(f).value = c[f];
  await showMode();
}

function validate(c) {
  if (!c.baseUrl && !c.model && !c.apiKey) return null;
  if (!c.baseUrl) return t('errNoBaseUrl');
  if (!/^https?:\/\//i.test(c.baseUrl)) return t('errScheme');
  if (!c.model) return t('errNoModel');
  return null;
}

$('save').onclick = async () => {
  const c = current();
  const err = validate(c);
  if (err) return setStatus(err, 'err');
  if (!c.baseUrl) {
    await clearAiConfig();
    setStatus(t('cleared'), 'ok');
  } else {
    await saveAiConfig(c);
    setStatus(t('saved'), 'ok');
  }
  await showMode();
};

$('test').onclick = async () => {
  const c = current();
  const err = validate(c) || (!c.baseUrl ? t('errNeedConfig') : null);
  if (err) return setStatus(err, 'err');
  setStatus(t('stateConnecting'));
  $('test').disabled = true;
  try {
    const reply = await testConnection(c);
    setStatus(t('testOk', [reply.slice(0, 200) || t('testEmpty')]), 'ok');
  } catch (e) {
    setStatus(t('testFailed', [e.message]), 'err');
  } finally {
    $('test').disabled = false;
  }
};

$('clear').onclick = async () => {
  await clearAiConfig();
  for (const f of fields) $(f).value = '';
  setStatus(t('cleared'), 'ok');
  await showMode();
};

$('toggleKey').onclick = () => {
  const show = $('apiKey').type === 'password';
  $('apiKey').type = show ? 'text' : 'password';
  $('toggleKey').textContent = t(show ? 'hide' : 'show');
};

// 输入设置：勾选即保存
async function loadInput() {
  const { inputConfig } = await chrome.storage.local.get('inputConfig');
  $('humanTyping').checked = inputConfig?.humanTyping !== false;
}

$('humanTyping').onchange = async () => {
  await chrome.storage.local.set({ inputConfig: { humanTyping: $('humanTyping').checked } });
  $('inputStatus').textContent = t($('humanTyping').checked ? 'humanTypingOn' : 'humanTypingOff');
  $('inputStatus').className = 'status ok';
};

load();
loadInput();
