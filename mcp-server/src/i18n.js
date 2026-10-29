// 命令行和服务给人看的提示跟随系统语言：LC_ALL / LC_MESSAGES / LANG（都没有时看 Intl 区域）以 zh 开头用中文，否则用英文
const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || '';
export const ZH = /^zh/i.test(locale);
export const say = (zh, en) => (ZH ? zh : en);
