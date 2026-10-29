// 代码审查中修复的问题：扩展 ID 校验、重定向状态、下拉框名称、复选框 click、遮挡提示、
// 遗留对话框、取消、本机文件限制、控制台去重、Service Worker 重启后的恢复
import { browserSession, EXT_ID, setup, sleep, TEST_PORT, userPage, WebSocket } from './harness.mjs';

const t = await setup();
const { call, js, refOf, expect } = t;
try {
  // 1. 未授权的扩展无法连接
  const fake = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/extension`, { headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', (e) => resolve(e.message));
  });
  expect(fake !== 'open', `伪造扩展 Origin 被拒绝（${fake}）`);

  const tabId = JSON.parse((await call('tabs_context_mcp', { createIfEmpty: true })).t).availableTabs[0].tabId;
  await call('read_network_requests', { tabId }, { quiet: true });
  await call('navigate', { tabId, url: 'http://127.0.0.1:18801/redir' });
  // 2. 重定向链状态码
  const net = (await call('read_network_requests', { tabId, urlPattern: 'redir' })).t;
  expect(/statusCode: 302/.test(net) && !/pending/.test(net), '重定向请求显示 302 而不是 pending');

  // 3. 下拉框名称跟随当前选择；复选框用 click 切换
  const rp = (await call('read_page', { tabId, filter: 'interactive' }, { quiet: true })).t;
  await call('form_input', { tabId, ref: refOf(rp, /combobox/), value: '上海' });
  expect(/combobox "上海"/.test((await call('read_page', { tabId, filter: 'interactive' }, { quiet: true })).t), '下拉框名称显示当前选项');
  await js(tabId, `window.__clicks = 0; document.getElementById('agree').addEventListener('click', () => window.__clicks++); 1`);
  await call('form_input', { tabId, ref: refOf(rp, /checkbox/), value: true });
  expect((await js(tabId, 'window.__clicks + "/" + document.getElementById("agree").checked')) === '1/true', '复选框通过 click 切换（React 等框架可感知）');

  // 4. 点击被遮挡的元素时提示遮挡者
  await js(tabId, `(() => { const r = document.getElementById('card').getBoundingClientRect(); const o = document.createElement('div'); o.id = 'overlay'; o.textContent = 'Cookie 横幅'; Object.assign(o.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', background: '#eee', zIndex: 99 }); document.body.appendChild(o); return 1; })()`);
  const card = refOf((await call('find', { tabId, query: '可点击卡片' }, { quiet: true })).t, /ref_/);
  expect(/covered by .*Cookie 横幅/.test((await call('computer', { tabId, action: 'left_click', ref: card })).t), '点击被遮挡元素时提示遮挡者');
  await js(tabId, `document.getElementById('overlay').remove(); 1`);

  // 5. Claude 空闲时出现的对话框留给用户，下次操作时才自动处理
  await js(tabId, `setTimeout(() => { window.__openAt = Date.now(); alert('later'); window.__closedAt = Date.now(); }, 300); 'scheduled'`);
  await sleep(2500);
  expect(/alert dialog appeared \("later"\)/.test((await call('read_page', { tabId, filter: 'interactive', max_chars: 200 }, { quiet: true })).t), '下次操作时处理遗留对话框并提示');
  const held = Number(await js(tabId, 'window.__closedAt - window.__openAt'));
  expect(held > 1500, `空闲期间对话框没有被自动关闭（保持了 ${held}ms）`);

  // 6. 取消：browser_batch 执行中被客户端取消后，后续步骤不再执行
  await js(tabId, 'window.__batchRan = false; 1');
  const controller = new AbortController();
  const pending = call('browser_batch', { actions: [
    { name: 'computer', input: { tabId, action: 'wait', duration: 2 } },
    { name: 'computer', input: { tabId, action: 'wait', duration: 2 } },
    { name: 'javascript_tool', input: { tabId, action: 'javascript_exec', text: 'window.__batchRan = true' } },
  ] }, { signal: controller.signal, quiet: true }).catch((e) => e.message);
  await sleep(1000);
  controller.abort();
  await pending;
  await sleep(5000);
  expect((await js(tabId, 'String(window.__batchRan)')) === 'false', '取消后 browser_batch 的后续步骤没有执行');

  // 7. 本机文件访问限制
  expect(/not allowed/.test((await call('file_upload', { tabId, ref: 'ref_1', paths: ['/etc/hosts'] }, { expectError: true })).t), '拒绝上传允许目录之外的文件');
  expect(/not allowed|not found/i.test((await call('file_upload', { tabId, ref: 'ref_1', paths: ['~/.ssh/known_hosts'] }, { expectError: true })).t), '拒绝上传隐藏目录中的文件');

  // 8. 空闲释放后重新附加，控制台日志不重复
  await call('read_console_messages', { tabId }, { quiet: true });
  await call('navigate', { tabId, url: 'http://127.0.0.1:18801/test.html?console' });
  console.log('  等待 22 秒空闲释放…');
  await sleep(22_000);
  const logs = (await call('read_console_messages', { tabId, pattern: 'page loaded' })).t;
  const count = (logs.match(/test\.html\?console:\d+:\d+\)\npage loaded 42/g) || []).length;
  expect(count === 1, `重新附加后控制台日志不重复（?console 页面的日志出现 ${count} 次）`);

  // 9. Service Worker 被终止重启：页面指示器自行隐藏，工具照常可用
  await call('read_page', { tabId, filter: 'interactive', max_chars: 100 }, { quiet: true });
  const user = await userPage('test.html');
  await sleep(300);
  const before = await user.edgeColor();
  const browser = await browserSession();
  const { targetInfos } = await browser.send('Target.getTargets');
  const sw = targetInfos.find((x) => x.type === 'service_worker' && x.url.startsWith(`chrome-extension://${EXT_ID}/`));
  await browser.send('Target.closeTarget', { targetId: sw.targetId });
  await sleep(8000);
  const after = await user.edgeColor();
  // 光晕颜色在旋转，按饱和度判断：显示时边缘是彩色，隐藏后是白色
  const saturation = (rgb) => Math.max(...rgb) - Math.min(...rgb);
  expect(saturation(before) > 60 && saturation(after) < 15, 'Service Worker 重启后页面指示器自行隐藏');
  expect(!(await call('read_page', { tabId, filter: 'interactive', max_chars: 100 }, { quiet: true })).isError, 'Service Worker 重启后工具照常可用');
  browser.close();
  user.close();
} catch (e) {
  t.fail(e);
}
await t.done();
