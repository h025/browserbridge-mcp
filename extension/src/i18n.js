// 界面文字跟随浏览器语言（_locales/en、zh_CN），缺少翻译时退回英文
export const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

// 填充带 data-i18n（文字）、data-i18n-title（悬停提示）属性的元素
export function applyI18n(root = document) {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}
