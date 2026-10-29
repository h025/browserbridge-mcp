// 实测中发现的问题：元素名称混入 <style> 内容、控制台/网络记录按需开启、模拟真人打字节奏
import { EXT_ID, openPage, setup, sleep } from './harness.mjs';

const t = await setup();
const { call, js, refOf, expect } = t;
try {
  const tabId = JSON.parse((await call('tabs_context_mcp', { createIfEmpty: true })).t).availableTabs[0].tabId;
  await call('navigate', { tabId, url: 'http://127.0.0.1:18801/test.html' });

  // 1. 元素名称不含 <style> 里的 CSS
  const tree = (await call('read_page', { tabId, filter: 'interactive' }, { quiet: true })).t;
  expect(/link "样式链接"/.test(tree) && !/styled-x|color:red/.test(tree), 'read_page：链接名称不含 <style> 里的 CSS');
  const f = (await call('find', { tabId, query: '样式链接' })).t;
  expect(/提交表单/.test((await call('find', { tabId, query: '提交' })).t), 'find：按文字匹配到按钮');
  const cand = (await call('find', { tabId, query: 'unicorn widget' })).t;
  expect(/No element text matched/.test(cand) && /button "提交表单"/.test(cand), 'find：文字匹配不上时，把视口里的可交互元素交给 agent 自己挑');
  expect(!/href="[^"]{62,}"/.test(cand) && /长地址链接" \[ref_\d+\] href="[^"]{60}…"/.test(cand), 'find：候选列表里的长链接地址被截短');
  expect(/^Found \d+ matching element[\s\S]*?- ref_\d+: textbox/.test((await call('find', { tabId, query: '输入框' })).t), 'find：只写类型词（输入框）时按元素类型找');
  expect(/^Found \d+ matching element[^\n]*\n\n- ref_\d+: button "提交表单"/.test((await call('find', { tabId, query: '提交按钮' })).t), 'find：类型词加文字（提交按钮）时，文字和类型都对上的排第一');
  const heading = (await call('find', { tabId, query: '测试表单' })).t;
  expect(/heading "测试表单"/.test(heading) && /None of these can be clicked/.test(heading) && /button "提交表单"/.test(heading), 'find：匹配到的都不能点击时，附上可交互的候选元素');
  expect(/link "样式链接"/.test(f) && !/color/.test(f), 'find：结果同样不含 CSS');

  // 2. 控制台/网络记录在第一次读取时才开启
  expect(/No network requests found/.test((await call('read_network_requests', { tabId })).t), '页面加载时尚未开启网络记录（第一次读取才开启）');
  expect(/page loaded 42/.test((await call('read_console_messages', { tabId, pattern: 'page loaded' })).t), '控制台第一次读取时补上页面已输出的消息');
  await call('navigate', { tabId, url: 'http://127.0.0.1:18801/test.html?again' });
  expect(/statusCode: 200/.test((await call('read_network_requests', { tabId, urlPattern: 'again' })).t), '开启后，之后的请求都会被记录');
  const con = (await call('read_console_messages', { tabId, pattern: 'page loaded' })).t;
  expect((con.match(/page loaded 42/g) || []).length === 2, '控制台记录跨导航持续（两次加载各一条，无重复）');

  // 3. 模拟真人打字节奏：默认开启；在设置页关闭后恢复快速输入
  const measure = async () => {
    await js(tabId, `window.__kd = []; const n = document.getElementById('note'); n.value = ''; n.onkeydown = () => __kd.push(performance.now()); 1`);
    await call('computer', { tabId, action: 'left_click', ref: refOf((await call('find', { tabId, query: '备注' }, { quiet: true })).t, /ref_/) }, { quiet: true });
    await call('computer', { tabId, action: 'type', text: 'Claude Code' }, { quiet: true });
    return { spanMs: Number(await js(tabId, 'Math.round(__kd.at(-1) - __kd[0])')), value: await js(tabId, `document.getElementById('note').value`) };
  };
  const human = await measure();
  expect(human.value === 'Claude Code' && human.spanMs >= 300, `默认模拟真人打字：11 个字符用时 ${human.spanMs}ms`);
  const opts = await openPage(`chrome-extension://${EXT_ID}/options.html`);
  expect((await opts.evaluate(`document.getElementById('humanTyping').checked`)) === true, '设置页里「模拟真人打字节奏」默认勾选');
  await opts.evaluate(`(document.getElementById('humanTyping').click(), true)`);
  await sleep(300);
  opts.close();
  const fast = await measure();
  expect(fast.value === 'Claude Code' && fast.spanMs < 100, `关闭后快速输入：用时 ${fast.spanMs}ms`);
} catch (e) {
  t.fail(e);
}
await t.done();
