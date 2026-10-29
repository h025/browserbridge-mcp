// 多个 agent 同时使用：每个会话有自己的标签组，互不干扰；停止只拦下自己；
// agent 退出后组保留，同一客户端在同一目录重启时接回原来的组；hub 换人后照常工作
import { EXT_ID, openPage, setup, sleep, userPage } from './harness.mjs';

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
  const groupInfo = (id) => ext.evaluate(`chrome.tabGroups.get(${id}).then((g) => ({ title: g.title.replace(/^(⌛|✅) /, ''), color: g.color }), () => null)`);
  const ga = await groupInfo(ca.tabGroupId);
  const gb = await groupInfo(cb.tabGroupId);
  expect(ga?.title === 'e2e · e2e' && gb?.title === 'second-agent · e2e' && ga.color !== gb.color, `组名按客户端和目录区分、颜色不同（${ga?.title} / ${gb?.title}）`);

  // 用户在 A 的页面上点「停止」：只拦下 A
  const vp = JSON.parse((await callWith(a, 'javascript_tool', { action: 'javascript_exec', tabId: tabA, text: 'JSON.stringify({ w: innerWidth, h: innerHeight })' }, { quiet: true })).t);
  const user = await userPage('agent-a');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await user.send('Input.dispatchMouseEvent', { type, x: vp.w / 2, y: vp.h - 36, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
  await sleep(500);
  expect(!(await callWith(b, 'computer', { tabId: tabB, action: 'wait', duration: 0.1 }, { quiet: true })).isError, '另一个 agent 不受停止影响');
  expect(/clicked "Stop"/.test((await callWith(a, 'computer', { tabId: tabA, action: 'wait', duration: 0.1 }, { expectError: true })).t), '点了停止的那个 agent 被拦下');

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
