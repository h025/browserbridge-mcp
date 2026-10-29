// 多个 agent 同时使用：每个会话有自己的标签组，互不干扰；
// agent 退出后组保留，同一客户端在同一目录重启时接回原来的组；hub 换人后照常工作
import { EXT_ID, openPage, setup, sleep } from './harness.mjs';

const t = await setup();
const { callWith, expect } = t;
const context = async (c, args = {}) => JSON.parse((await callWith(c, 'tabs_context_mcp', args, { quiet: true })).t);
try {
  const a = t.client;
  const b = await t.connect('second-agent');
  const ca = await context(a, { createIfEmpty: true });
  const cb = await context(b, { createIfEmpty: true });
  const tabA = ca.availableTabs[0].tabId;
  const tabB = cb.availableTabs[0].tabId;
  expect(ca.tabGroupId !== cb.tabGroupId && tabA !== tabB, '两个 agent 各自新建了自己的标签组');
  expect(JSON.stringify((await context(b)).availableTabs.map((x) => x.tabId)) === JSON.stringify([tabB]), '每个 agent 只看到自己组里的标签页');

  const [na, nb] = await Promise.all([
    callWith(a, 'navigate', { tabId: tabA, url: 'http://127.0.0.1:18801/test.html?agent-a' }, { quiet: true }),
    callWith(b, 'navigate', { tabId: tabB, url: 'http://127.0.0.1:18801/test.html?agent-b' }, { quiet: true }),
  ]);
  expect(!na.isError && !nb.isError, '两个 agent 同时操作各自的标签页');
  expect(/not in the ".*" tab group/.test((await callWith(a, 'navigate', { tabId: tabB, url: 'example.com' }, { expectError: true })).t), '不能操作别的 agent 的标签页');

  const ext = await openPage(`chrome-extension://${EXT_ID}/options.html`);
  const groupInfo = (id) => ext.evaluate(`chrome.tabGroups.get(${id}).then((g) => ({ title: g.title, color: g.color, windowId: g.windowId }), () => null)`);
  const ga = await groupInfo(ca.tabGroupId);
  const gb = await groupInfo(cb.tabGroupId);
  // 组名开头是 emoji（正在操作时是 ⌛），后面是客户端名，没有任务名时只有客户端名
  const base = (title) => title?.replace(/^\S+ /, '');
  expect(base(ga?.title) === 'e2e' && base(gb?.title) === 'second-agent' && ga.color !== gb.color, `没有任务名时组名是客户端名、颜色不同（${ga?.title} / ${gb?.title}）`);
  expect(ga.windowId === gb.windowId, '新建的标签组都在当前窗口里，不另开窗口');

  // agent 给出任务名（emoji + 名称）后组名随之更新；刚操作过，标题开头是 ⌛；弹窗里显示任务的 emoji
  await callWith(a, 'tabs_context_mcp', { taskName: '✈️ 查机票' }, { quiet: true });
  const named = await groupInfo(ca.tabGroupId);
  expect(named?.title === '⌛ e2e · 查机票', `组名为 emoji + 客户端 + 任务名，正在操作时 emoji 换成 ⌛（${named?.title}）`);
  const listed = await ext.evaluate(`chrome.runtime.sendMessage({ type: 'sessions' }).then((r) => r.sessions.map((s) => s.title).join(' / '))`);
  expect(listed.includes('✈️ e2e · 查机票'), `弹窗里显示任务的 emoji（${listed}）`);

  // B 退出：组保留；同一客户端在同一目录重启后接回原来的组
  await b.close();
  await sleep(800);
  expect((await groupInfo(cb.tabGroupId)) !== null, 'agent 退出后它的标签组保留');
  const c = await t.connect('second-agent');
  const cc = await context(c);
  expect(cc.tabGroupId === cb.tabGroupId && cc.availableTabs.some((x) => x.tabId === tabB), '同一客户端重启后接回原来的标签组');
  expect(/not in the ".*" tab group/.test((await callWith(c, 'navigate', { tabId: tabA, url: 'example.com' }, { expectError: true })).t), '接回后仍不能操作 A 的标签页');

  // A 是 hub，退出后 C 接任 hub：C 仍用自己的组，A 的组保留
  await a.close();
  await sleep(4000);
  const after = await context(c);
  expect(after.tabGroupId === cb.tabGroupId, 'hub 换人后 agent 仍使用自己的标签组');
  expect(!(await callWith(c, 'computer', { tabId: tabB, action: 'screenshot' }, { quiet: true })).isError, 'hub 换人后照常操作');
  expect((await groupInfo(ca.tabGroupId)) !== null, '退出的 hub 的标签组保留');
} catch (e) {
  t.fail(e);
}
await t.done();
