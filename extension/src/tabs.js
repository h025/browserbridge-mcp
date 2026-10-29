// 客户端只能操作专属标签组里的标签页。没有标签组时，tabs_context_mcp(createIfEmpty)
// 会新开一个窗口并建组，与用户自己的窗口分开。用户也可以把已有标签页拖进这个组，
// 或在扩展弹窗里点“交出当前标签页”。
import { hostnameOf, sleep, ToolError } from './cdp.js';

export const GROUP_TITLE = 'Browser Bridge';
const GROUP_COLOR = 'purple';
// 0.6.0 及以前的组名，找到后改成新名称和颜色
const LEGACY_TITLES = ['Claude Bridge'];
const STORAGE_KEY = 'bridgeTabGroupId';

async function saveGroupId(groupId) {
  await chrome.storage.session.set({ [STORAGE_KEY]: groupId });
}

export async function getGroupId() {
  const { [STORAGE_KEY]: stored } = await chrome.storage.session.get(STORAGE_KEY);
  if (stored != null) {
    try {
      await chrome.tabGroups.get(stored);
      return stored;
    } catch {
      // 组已被关闭，按标题重新查找
    }
  }
  // 标题可能带有 ⌛ / ✅ 状态前缀
  const ours = (title) => [GROUP_TITLE, ...LEGACY_TITLES].some((t) => title === t || title?.endsWith(` ${t}`));
  const group = (await chrome.tabGroups.query({})).find((g) => ours(g.title));
  if (group && (!group.title.endsWith(GROUP_TITLE) || group.color !== GROUP_COLOR)) await styleGroup(group.id).catch(() => {});
  await saveGroupId(group ? group.id : null);
  return group ? group.id : null;
}

async function styleGroup(groupId) {
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
}

// 在标签组标题前显示状态：⌛ 执行中、✅ 已完成，null 表示清除
export async function setGroupPrefix(prefix) {
  const groupId = await getGroupId();
  if (groupId == null) return;
  const title = prefix ? `${prefix} ${GROUP_TITLE}` : GROUP_TITLE;
  try {
    const group = await chrome.tabGroups.get(groupId);
    if (group.title !== title) await chrome.tabGroups.update(groupId, { title });
  } catch {
    // 组已不存在
  }
}

export async function listGroupTabs(groupId) {
  const gid = groupId ?? (await getGroupId());
  if (gid == null) return [];
  const tabs = await chrome.tabs.query({ groupId: gid });
  return tabs
    .filter((t) => t.id != null)
    .sort((a, b) => a.index - b.index)
    .map((t) => ({ id: t.id, title: t.title || '', url: t.url || t.pendingUrl || '' }));
}

export async function getOrCreateContext({ createIfEmpty = false } = {}) {
  const groupId = await getGroupId();
  if (groupId != null) {
    const tabs = await listGroupTabs(groupId);
    if (tabs.length) return { tabGroupId: groupId, availableTabs: tabs };
  }
  if (!createIfEmpty) return null;
  const win = await chrome.windows.create({ url: 'about:blank', focused: true, type: 'normal' });
  const tabId = win.tabs?.[0]?.id;
  if (tabId == null) throw new Error('Failed to create window with new tab');
  const newGroupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: win.id } });
  await styleGroup(newGroupId);
  await saveGroupId(newGroupId);
  return { tabGroupId: newGroupId, availableTabs: await listGroupTabs(newGroupId) };
}

export async function createTabInGroup() {
  const groupId = await getGroupId();
  if (groupId == null) {
    throw new ToolError('tab_create_no_group', `No "${GROUP_TITLE}" tab group exists. Use tabs_context_mcp with createIfEmpty: true first to create a group.`);
  }
  const { windowId } = await chrome.tabGroups.get(groupId);
  const tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: false });
  await chrome.tabs.group({ tabIds: tab.id, groupId });
  return { tab, groupId };
}

export async function addTabToGroup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const groupId = await getGroupId();
  if (groupId == null) {
    const newGroupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: tab.windowId } });
    await styleGroup(newGroupId);
    await saveGroupId(newGroupId);
  } else {
    const group = await chrome.tabGroups.get(groupId);
    // 标签组不能跨窗口，先把标签页移过去
    if (group.windowId !== tab.windowId) await chrome.tabs.move(tabId, { windowId: group.windowId, index: -1 });
    await chrome.tabs.group({ tabIds: tabId, groupId });
  }
  return chrome.tabs.get(tabId);
}

// 校验 tabId 属于标签组，返回标签页对象
export async function assertTabInGroup(tabId) {
  if (typeof tabId !== 'number') {
    throw new ToolError('input_invalid', 'tabId is required. Use tabs_context_mcp first to get available tab IDs.');
  }
  const groupId = await getGroupId();
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
      `${tab ? `Tab ${tabId} is not in the "${GROUP_TITLE}" tab group.` : `Tab ${tabId} does not exist.`} ` +
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

export async function tabContext(executedOnTabId) {
  const groupId = await getGroupId();
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
