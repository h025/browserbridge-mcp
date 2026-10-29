// 回归测试：各工具的基本功能 + 多会话 hub/peer 与接管
import { setup, sleep } from './harness.mjs';

const t = await setup(process.env.HEADFUL ? {} : { windowSize: '1440,900', dpr: 2 });
const { call, callWith, js, refOf, expect } = t;
try {
  await call('tabs_context_mcp', {});
  const tabId = JSON.parse((await call('tabs_context_mcp', { createIfEmpty: true })).t).availableTabs[0].tabId;
  await call('read_network_requests', { tabId }, { quiet: true }); // 网络记录在第一次读取时开启
  await call('navigate', { tabId, url: '127.0.0.1:18801/test.html' });
  const rp = await call('read_page', { tabId, filter: 'interactive' });
  await call('read_page', { tabId, max_chars: 1500 }, { quiet: true });

  // 表单与点击
  const email = refOf((await call('find', { tabId, query: '邮箱' })).t, /textbox/);
  await call('form_input', { tabId, ref: email, value: 'a@b.com' });
  await call('form_input', { tabId, ref: refOf(rp.t, /checkbox/), value: true });
  await call('form_input', { tabId, ref: refOf(rp.t, /combobox/), value: '上海' });
  await call('form_input', { tabId, ref: refOf(rp.t, /combobox/), value: '深圳' }, { expectError: true });
  await call('computer', { tabId, action: 'left_click', ref: refOf(rp.t, /提交表单/) });
  const card = refOf(rp.t, /可点击卡片/);
  await call('computer', { tabId, action: 'double_click', ref: card });
  await call('computer', { tabId, action: 'left_click', ref: refOf(rp.t, /备注/) });
  await call('computer', { tabId, action: 'type', text: 'Hello World!\n你好，世界' });
  await call('computer', { tabId, action: 'key', text: 'cmd+a Backspace' });
  await call('computer', { tabId, action: 'type', text: 'after-clear' });
  const st = JSON.parse(await js(tabId, `({ out: document.getElementById('out').textContent, card: document.getElementById('card').textContent,
    note: document.getElementById('note').value, keys: document.getElementById('keys').textContent.slice(0, 60),
    agree: document.getElementById('agree').checked, city: document.getElementById('city').value })`));
  expect(st.out === 'submitted:a@b.com', 'form_input + 点击提交');
  expect(st.card === '卡片已点击 2', 'double_click');
  expect(st.note === 'after-clear', 'type + cmd+a / Backspace');
  expect(st.agree === true && st.city === 'sh', '复选框与下拉框');
  expect(st.keys.startsWith('H,e,l,l,o, ,W'), 'type 触发 keydown');

  // 截图与坐标
  const shot = await call('computer', { tabId, action: 'screenshot' });
  const [sw, sh] = shot.t.match(/\((\d+)x(\d+), jpeg\)/).slice(1).map(Number);
  expect(Math.ceil(sw / 28) * Math.ceil(sh / 28) <= 1568 && sw <= 1568 && sh <= 1568, `截图在 token 预算内 ${sw}x${sh}`);
  const vp = JSON.parse(await js(tabId, `(() => { const r = document.getElementById('card').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: innerWidth, h: innerHeight }; })()`));
  await call('computer', { tabId, action: 'left_click', coordinate: [Math.round(vp.x * sw / vp.w), Math.round(vp.y * sh / vp.h)] });
  expect((await js(tabId, `document.getElementById('card').textContent`)) === '卡片已点击 3', '按截图坐标点击');
  expect(/outside the coordinate frame/.test((await call('computer', { tabId, action: 'left_click', coordinate: [sw + 50, 10] }, { expectError: true })).t), '坐标越界报错');
  expect(/0\.5-scale view; coordinate frame/.test((await call('computer', { tabId, action: 'screenshot', scale: 0.5 })).t), 'scale=0.5 截图说明坐标系');
  await call('computer', { tabId, action: 'zoom', region: [0, 0, 400, 200] });
  const sc = await call('computer', { tabId, action: 'scroll', coordinate: [Math.round(sw / 2), Math.round(sh / 2)], scroll_direction: 'down', scroll_amount: 5 });
  expect(!!sc.img && Number(await js(tabId, 'scrollY')) > 100, '滚动生效并返回截图');
  await call('computer', { tabId, action: 'scroll_to', ref: refOf((await call('find', { tabId, query: '跳到底部' })).t, /link/) });

  // 上传、正文、日志、JS
  await call('file_upload', { tabId, ref: refOf((await call('find', { tabId, query: 'file' })).t, /\(file\)/), paths: ['site/upload.txt'] });
  expect((await js(tabId, `document.getElementById('out').textContent`)) === 'files:upload.txt', 'file_upload');
  await call('get_page_text', { tabId, max_chars: 300 }, { quiet: true });
  const cons = (await call('read_console_messages', { tabId, pattern: 'loaded|error|fetched' })).t;
  expect(/page loaded 42/.test(cons) && /test error message/.test(cons) && /fetched pong/.test(cons), '控制台日志');
  expect(/statusCode: 200/.test((await call('read_network_requests', { tabId, urlPattern: '/api/' })).t), '网络请求');
  await call('javascript_tool', { action: 'javascript_exec', text: 'throw new Error("boom")', tabId }, { expectError: true });
  expect((await js(tabId, 'const a = 2;\nreturn a * 21;')) === '42', 'javascript 的 return 语句回退为 async 函数');
  expect(/BLOCKED: Sensitive key/.test(await js(tabId, '({ token: "abc", ok: 1 })')), 'javascript 结果屏蔽敏感字段');
  await call('computer', { tabId, action: 'key', text: 'cmd+=' }, { expectError: true });
  await call('computer', { tabId, action: 'key', text: 'hyper+x' }, { expectError: true });
  expect(new RegExp(`Valid tab IDs are: .*${tabId}`).test((await call('navigate', { tabId: 999999, url: 'example.com' }, { expectError: true })).t), '无效 tabId 时列出可用 ID');

  // 对话框、新标签页、离开页面
  await js(tabId, `setTimeout(() => alert('hello alert'), 50); 'scheduled'`);
  expect(/alert dialog appeared \("hello alert"\)/.test((await call('computer', { tabId, action: 'wait', duration: 1 })).t), 'alert 自动确认并提示');
  const newTabLink = refOf((await call('find', { tabId, query: '新标签页' })).t, /link/);
  const nt = await call('computer', { tabId, action: 'left_click', ref: newTabLink });
  const openedId = Number(nt.t.match(/new tab \(tab ID (\d+)\)/)?.[1]);
  expect(openedId > 0, '点击打开新标签页并加入标签组');
  await call('navigate', { tabId, url: 'http://127.0.0.1:18801/test.html?second' });
  await call('computer', { tabId, action: 'left_click', coordinate: [50, 50] });
  await js(tabId, `window.addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = ''; }); 'armed'`);
  expect(/Leave site/.test((await call('navigate', { tabId, url: 'http://127.0.0.1:18801/test.html?third' }, { expectError: true })).t), 'beforeunload 默认阻止导航');
  const forced = await call('navigate', { tabId, url: 'http://127.0.0.1:18801/test.html?third', force: true });
  expect(/third/.test(forced.t) && /discarded/.test(forced.t), 'force 时放弃修改并导航');
  expect(/second/.test((await call('navigate', { tabId, url: 'back' })).t), '后退');

  // 后台标签页 + browser_batch
  const bgTab = Number((await call('tabs_create_mcp', {})).t.match(/Tab ID: (\d+)/)[1]);
  await call('navigate', { tabId: bgTab, url: 'http://127.0.0.1:18801/test.html?bg' });
  await call('computer', { tabId: bgTab, action: 'screenshot' });
  const batch = await call('browser_batch', { actions: [
    { name: 'find', input: { tabId: bgTab, query: '邮箱' } },
    { name: 'computer', input: { tabId: bgTab, action: 'left_click', ref: 'ref_1' } },
    { name: 'computer', input: { tabId: bgTab, action: 'type', text: 'batch@x.com' } },
    { name: 'computer', input: { tabId: bgTab, action: 'screenshot', scale: 0.3 } },
  ] });
  expect(/\[computer:type\] Typed/.test(batch.t) && batch.imgs.length === 1, 'browser_batch 顺序执行并穿插图片');
  const batchErr = await call('browser_batch', { actions: [
    { name: 'computer', input: { tabId: bgTab, action: 'wait', duration: 0.1 } },
    { name: 'computer', input: { tabId: bgTab, action: 'zoom' } },
  ] }, { expectError: true });
  expect(/\[computer:wait\] Waited/.test(batchErr.t) && /failed \(action 2 of 2\)/.test(batchErr.t), 'browser_batch 出错即停并保留前面的结果');
  await call('tabs_close_mcp', { tabId: bgTab });
  if (openedId) await call('tabs_close_mcp', { tabId: openedId });

  // 多会话：第二个 MCP 进程作为 peer 经 hub 转发；hub 退出后接任
  const peer = await t.connect();
  expect(!(await callWith(peer, 'tabs_context_mcp', {})).isError, 'peer 经 hub 转发');
  await t.client.close();
  await sleep(3000);
  expect(!(await callWith(peer, 'tabs_context_mcp', {})).isError, 'hub 退出后 peer 接任');
} catch (e) {
  t.fail(e);
}
await t.done();
