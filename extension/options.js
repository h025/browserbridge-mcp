import { applyI18n, t } from './src/i18n.js';

applyI18n();
document.title = t('optionsTitle');

const $ = (id) => document.getElementById(id);

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

loadInput();
