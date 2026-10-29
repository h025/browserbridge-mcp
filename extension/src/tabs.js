// 每个 MCP 会话（一个 agent）有自己的标签组，只能操作自己组里的标签页，多个 agent 互不干扰。
// 会话还没有标签组时，tabs_context_mcp(createIfEmpty) 会新开一个窗口并建组，与用户自己的窗口分开。
// 用户也可以把标签页拖进某个 agent 的组，或在扩展弹窗里把当前标签页交给某个 agent。
//
// 会话记录 { id, client, folder, cwd, groupId, title, color } 存在 chrome.storage.session，Service Worker
// 重启后仍在。agent 退出后标签组保留；同一客户端在同一目录重新启动（例如 /mcp 重连）时接回原来的组。
import { hostnameOf, sleep, ToolError } from './cdp.js';

// 旧版 MCP 服务（0.6.0 及以前）的请求不带会话 ID，归入这个默认会话
export const DEFAULT_SESSION = 'default';
const DEFAULT_TITLE = 'Browser Bridge';
// 0.7.0 之前所有会话共用一个标签组，由第一个需要标签组的会话接手
const LEGACY_GROUP_KEY = 'bridgeTabGroupId';
const LEGACY_TITLES = ['Browser Bridge', 'Claude Bridge'];
const SESSIONS_KEY = 'bridgeSessions';
const COLORS = ['purple', 'blue', 'pink', 'cyan', 'orange', 'green', 'red', 'yellow', 'grey'];
const PREFIX_RE = /^(⌛|✅) /;
// 常见 MCP 客户端的显示名称
const CLIENT_LABELS = [
  [/claude-code/i, 'Claude Code'], [/claude/i, 'Claude'], [/codex/i, 'Codex'], [/cursor/i, 'Cursor'], [/windsurf/i, 'Windsurf'],
  [/cline/i, 'Cline'], [/gemini/i, 'Gemini'], [/zed/i, 'Zed'], [/visual studio code|vscode/i, 'VS Code'],
];

const live = new Set(); // 当前连着的会话；扩展与 MCP 服务断开时清空，重连后服务会重新告知
const registering = new Map(); // 会话 ID -> 正在进行的登记（接回旧标签组等），请求要等它完成
let sessionsPromise = null; // 会话记录的内存副本，修改后写回 storage

function sessions() {
  sessionsPromise ||= chrome.storage.session.get(SESSIONS_KEY).then((r) => r[SESSIONS_KEY] || {});
  return sessionsPromise;
}

async function save() {
  await chrome.storage.session.set({ [SESSIONS_KEY]: await sessions() });
}

async function groupExists(groupId) {
  if (groupId == null) return false;
  return chrome.tabGroups.get(groupId).then(() => true, () => false);
}

function clientLabel(client) {
  if (!client) return 'Agent';
  return CLIENT_LABELS.find(([re]) => re.test(client))?.[1] || client.slice(0, 20);
}

// 组名：客户端 · 项目目录；与其他组重名时加序号，已有的组名尽量不变
function makeTitle(rec, all) {
  if (rec.id === DEFAULT_SESSION) return DEFAULT_TITLE;
  const base = rec.folder ? `${clientLabel(rec.client)} · ${rec.folder}` : clientLabel(rec.client);
  const taken = new Set(Object.values(all).filter((r) => r.id !== rec.id && r.groupId != null).map((r) => r.title));
  if (rec.title && (rec.title === base || rec.title.startsWith(`${base} `)) && !taken.has(rec.title)) return rec.title;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

function pickColor(rec, all) {
  const used = new Set(Object.values(all).filter((r) => r.id !== rec.id && r.groupId != null).map((r) => r.color));
  if (rec.color && !used.has(rec.color)) return rec.color;
  return COLORS.find((c) => !used.has(c)) || COLORS[Object.keys(all).length % COLORS.length];
}

// 设置组名和颜色，保留 ⌛ / ✅ 状态前缀
async function styleGroup(rec) {
  const group = await chrome.tabGroups.get(rec.groupId);
  const prefix = group.title?.match(PREFIX_RE)?.[0] || '';
  await chrome.tabGroups.update(rec.groupId, { title: prefix + rec.title, color: rec.color });
}

// 请求所属的会话记录；没告知过的会话（旧版服务，或通告还没到）先建一条
async function sessionRecord(id = DEFAULT_SESSION) {
  await registering.get(id);
  const all = await sessions();
  let rec = all[id];
  if (!rec) {
    rec = all[id] = { id, client: '', folder: '', cwd: '' };
    rec.title = makeTitle(rec, all);
    await save();
  }
  live.add(id);
  return rec;
}

// MCP 服务告知一个会话（新连上，或握手后带上了客户端名称）
export function registerSession(info) {
  if (!info?.id) return Promise.resolve();
  const p = (registering.get(info.id) || Promise.resolve()).then(() => register(info)).catch(() => {});
  registering.set(info.id, p);
  p.then(() => {
    if (registering.get(info.id) === p) registering.delete(info.id);
  });
  return p;
}

async function register(info) {
  const all = await sessions();
  const rec = all[info.id] || (all[info.id] = { id: info.id });
  rec.client = info.client || rec.client || '';
  rec.folder = info.folder ?? rec.folder ?? '';
  rec.cwd = info.cwd ?? rec.cwd ?? '';
  live.add(info.id);
  // 同一客户端在同一目录重新启动：接回上一个已结束会话的标签组
  let adopted = false;
  if (rec.groupId == null && rec.client) {
    for (const old of Object.values(all)) {
      if (old.id === rec.id || live.has(old.id) || old.client !== rec.client || old.cwd !== rec.cwd) continue;
      if (!(await groupExists(old.groupId))) continue;
      rec.groupId = old.groupId;
      rec.color = old.color;
      rec.title = old.title;
      delete all[old.id];
      adopted = true;
      break;
    }
  }
  const title = makeTitle(rec, all);
  const renamed = title !== rec.title;
  rec.title = title;
  if (rec.groupId != null && (renamed || adopted)) await styleGroup(rec).catch(() => {});
  await save();
}

export function endSession(id) {
  live.delete(id);
}

// 扩展与 MCP 服务断开：所有会话都视为离线，重连后服务会重新告知
export function markAllOffline() {
  live.clear();
}

export async function sessionTitle(session) {
  return (await sessionRecord(session)).title;
}

// 该标签组属于哪个会话（不属于任何会话时返回 null）
export async function sessionOfGroup(groupId) {
  if (groupId == null || groupId < 0) return null;
  return Object.values(await sessions()).find((r) => r.groupId === groupId)?.id ?? null;
}

export async function groupOfSession(id) {
  const rec = (await sessions())[id];
  return (await groupExists(rec?.groupId)) ? rec.groupId : null;
}

// 当前连着的会话，给扩展弹窗用
export async function liveSessions() {
  const all = await sessions();
  const out = [];
  for (const id of live) {
    const rec = all[id];
    if (rec) out.push({ id, title: rec.title, color: rec.color || null, hasGroup: await groupExists(rec.groupId) });
  }
  return out;
}

// 接手 0.7.0 之前共用的标签组（没被其他会话占用时）
async function takeLegacyGroup(rec) {
  const all = await sessions();
  const owned = new Set(Object.values(all).map((r) => r.groupId).filter((g) => g != null));
  const { [LEGACY_GROUP_KEY]: stored } = await chrome.storage.session.get(LEGACY_GROUP_KEY);
  const groups = (await chrome.tabGroups.query({})).filter((g) => !owned.has(g.id));
  const group = groups.find((g) => g.id === stored) || groups.find((g) => LEGACY_TITLES.includes((g.title || '').replace(PREFIX_RE, '')));
  if (stored != null) await chrome.storage.session.remove(LEGACY_GROUP_KEY);
  if (!group) return null;
  rec.groupId = group.id;
  rec.color = pickColor(rec, all);
  rec.title = makeTitle(rec, all);
  await styleGroup(rec).catch(() => {});
  await save();
  return group.id;
}

export async function getGroupId(session) {
  const rec = await sessionRecord(session);
  if (rec.groupId != null) {
    if (await groupExists(rec.groupId)) return rec.groupId;
    // 组已被关闭
    rec.groupId = null;
    await save();
  }
  return takeLegacyGroup(rec);
}

async function newGroup(rec, tabId, windowId) {
  const all = await sessions();
  rec.groupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId } });
  rec.color = pickColor(rec, all);
  rec.title = makeTitle(rec, all);
  await styleGroup(rec).catch(() => {});
  await save();
  return rec.groupId;
}

// 在标签组标题前显示状态：⌛ 执行中、✅ 已完成，null 表示清除
export async function setGroupPrefix(groupId, prefix) {
  if (groupId == null || groupId < 0) return;
  try {
    const group = await chrome.tabGroups.get(groupId);
    const base = (group.title || '').replace(PREFIX_RE, '');
    const title = prefix ? `${prefix} ${base}` : base;
    if (group.title !== title) await chrome.tabGroups.update(groupId, { title });
  } catch {
    // 组已不存在
  }
}

// 清除所有会话标签组的状态前缀
export async function clearAllPrefixes() {
  for (const rec of Object.values(await sessions())) await setGroupPrefix(rec.groupId, null);
}

export async function listGroupTabs(groupId) {
  if (groupId == null) return [];
  const tabs = await chrome.tabs.query({ groupId });
  return tabs
    .filter((t) => t.id != null)
    .sort((a, b) => a.index - b.index)
    .map((t) => ({ id: t.id, title: t.title || '', url: t.url || t.pendingUrl || '' }));
}

export async function getOrCreateContext(session, { createIfEmpty = false } = {}) {
  const groupId = await getGroupId(session);
  if (groupId != null) {
    const tabs = await listGroupTabs(groupId);
    if (tabs.length) return { tabGroupId: groupId, availableTabs: tabs };
  }
  if (!createIfEmpty) return null;
  const win = await chrome.windows.create({ url: 'about:blank', focused: true, type: 'normal' });
  const tabId = win.tabs?.[0]?.id;
  if (tabId == null) throw new Error('Failed to create window with new tab');
  const newGroupId = await newGroup(await sessionRecord(session), tabId, win.id);
  return { tabGroupId: newGroupId, availableTabs: await listGroupTabs(newGroupId) };
}

export async function createTabInGroup(session) {
  const groupId = await getGroupId(session);
  if (groupId == null) {
    throw new ToolError('tab_create_no_group', `No "${await sessionTitle(session)}" tab group exists. Use tabs_context_mcp with createIfEmpty: true first to create a group.`);
  }
  const { windowId } = await chrome.tabGroups.get(groupId);
  const tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: false });
  await chrome.tabs.group({ tabIds: tab.id, groupId });
  return { tab, groupId };
}

// 扩展弹窗：把标签页交给某个会话
export async function addTabToGroup(tabId, session) {
  const tab = await chrome.tabs.get(tabId);
  const groupId = await getGroupId(session);
  if (groupId == null) {
    await newGroup(await sessionRecord(session), tabId, tab.windowId);
  } else {
    const group = await chrome.tabGroups.get(groupId);
    // 标签组不能跨窗口，先把标签页移过去
    if (group.windowId !== tab.windowId) await chrome.tabs.move(tabId, { windowId: group.windowId, index: -1 });
    await chrome.tabs.group({ tabIds: tabId, groupId });
  }
  return chrome.tabs.get(tabId);
}

// 校验 tabId 属于该会话的标签组，返回标签页对象
export async function assertTabInGroup(tabId, session) {
  if (typeof tabId !== 'number') {
    throw new ToolError('input_invalid', 'tabId is required. Use tabs_context_mcp first to get available tab IDs.');
  }
  const groupId = await getGroupId(session);
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    tab = null;
  }
  if (!tab || groupId == null || tab.groupId !== groupId) {
    const valid = (await listGroupTabs(groupId)).map((t) => t.id);
    throw new ToolError(
      tab ? 'tab_outside_group' : 'tab_not_found',
      `${tab ? `Tab ${tabId} is not in the "${await sessionTitle(session)}" tab group.` : `Tab ${tabId} does not exist.`} ` +
        (valid.length ? `Valid tab IDs are: ${valid.join(', ')}` : 'There are no tabs in the group yet. Use tabs_context_mcp with createIfEmpty: true.'),
    );
  }
  return tab;
}

// 真正执行点击、输入等操作前确认页面仍在工具开始时的域名上（包括正在跳转的目标）
export async function assertSameDomain(tabId, startUrl, label) {
  if (!startUrl) return;
  const tab = await chrome.tabs.get(tabId);
  const host = hostnameOf(startUrl);
  if (hostnameOf(tab.url) !== host || (tab.pendingUrl && hostnameOf(tab.pendingUrl) !== host)) {
    throw new ToolError('security_check_failed', `Security check failed: the page navigated to a different domain during ${label}. Re-read the tab state before retrying.`);
  }
}

export async function tabContext(executedOnTabId, session) {
  const groupId = await getGroupId(session);
  return { executedOnTabId, tabGroupId: groupId ?? undefined, availableTabs: await listGroupTabs(groupId) };
}

export async function waitForLoad(tabId, timeoutMs) {
  const start = Date.now();
  let sawLoading = false;
  while (Date.now() - start < timeoutMs) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
    if (tab.status === 'loading') sawLoading = true;
    else if (sawLoading || Date.now() - start > 500) return tab;
    await sleep(100);
  }
  return chrome.tabs.get(tabId).catch(() => null);
}
