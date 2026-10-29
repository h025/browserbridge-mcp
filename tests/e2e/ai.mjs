// AI 元素查找：用模拟的 OpenAI 兼容接口测试设置页、请求格式、结果解析与各种失败退回
import { createServer } from 'node:http';
import { EXT_ID, openPage, setup, sleep } from './harness.mjs';

// 模拟接口：Key 为 test-key；模型 new-model 只接受 max_completion_tokens
const aiLog = [];
const ai = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    aiLog.push({ auth: req.headers.authorization, model: json.model, tokenField: 'max_tokens' in json ? 'max_tokens' : 'max_completion_tokens' });
    const reply = (content) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    };
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end('not found');
    if (req.headers.authorization !== 'Bearer test-key') return res.writeHead(401).end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    if (json.model === 'new-model' && 'max_tokens' in json) {
      return res.writeHead(400).end(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } }));
    }
    const prompt = json.messages[0].content;
    if (prompt.includes('single word: pong')) return reply('pong');
    const query = prompt.match(/wants to find: "([^"]*)"/)[1];
    if (/unicorn/.test(query)) return reply('FOUND: 0\nERROR: There is no unicorn widget on this page.');
    const ref = prompt.split('\n').find((l) => l.includes('提交表单')).match(/\[(ref_\d+)\]/)[1];
    reply(`<think>The submit button sends the form; ref_99999 is not real.</think>FOUND: 2\nSHOWING: 2\n---\n${ref} | button | 提交表单 | submit | Submits the form, which sends it\nref_99999 | button | Fake | | invented by the model`);
  });
}).listen(18802, '127.0.0.1');

const t = await setup();
const { call, expect } = t;
const fill = (page, cfg) => page.evaluate(`(() => { for (const [k, v] of Object.entries(${JSON.stringify(cfg)})) document.getElementById(k).value = v; return true; })()`);
const click = async (page, id, waitMs = 300) => {
  await page.evaluate(`(document.getElementById('${id}').click(), true)`);
  await sleep(waitMs);
  return page.evaluate(`document.getElementById('status').textContent + ' | ' + document.getElementById('mode').textContent`);
};
try {
  const tabId = JSON.parse((await call('tabs_context_mcp', { createIfEmpty: true })).t).availableTabs[0].tabId;
  await call('navigate', { tabId, url: 'http://127.0.0.1:18801/test.html' });

  const kw = (await call('find', { tabId, query: '提交' })).t;
  expect(aiLog.length === 0 && /提交表单/.test(kw), '未配置时使用关键词匹配，不调用 AI');

  const opts = await openPage(`chrome-extension://${EXT_ID}/options.html`);
  await fill(opts, { baseUrl: 'http://127.0.0.1:18802', apiKey: 'test-key', model: 'mock-model' });
  expect(/连接成功，模型回复：pong/.test(await click(opts, 'test', 800)), '设置页“测试连接”成功（只填域名，自动补 /v1）');
  expect(/已保存.*AI 匹配（模型 mock-model）/.test(await click(opts, 'save')), '保存后显示 AI 模式');

  const found = (await call('find', { tabId, query: 'the button that sends the form' })).t;
  const last = aiLog.at(-1);
  expect(last.auth === 'Bearer test-key' && last.model === 'mock-model' && last.tokenField === 'max_tokens', '请求带上 Key 和模型，格式为 OpenAI chat/completions');
  expect(/^Found 1 matching element\n/.test(found) && /ref_\d+: button "提交表单" \(submit\) - Submits the form/.test(found), 'AI 结果带匹配理由，总数不含模型编造的 ref');
  expect(!/ref_99999/.test(found) && !/think/.test(found), '过滤模型编造的 ref，去掉 <think> 内容');
  await call('computer', { tabId, action: 'left_click', ref: found.match(/(ref_\d+): button/)[1] });

  expect(/no unicorn widget/.test((await call('find', { tabId, query: 'unicorn widget' }, { expectError: true })).t), 'AI 判定无匹配时返回其原因');

  await fill(opts, { baseUrl: 'http://127.0.0.1:18802/v1/chat/completions', apiKey: 'test-key', model: 'new-model' });
  await click(opts, 'save');
  const retried = (await call('find', { tabId, query: 'the button that sends the form' })).t;
  expect(/提交表单/.test(retried) && aiLog.slice(-2).map((l) => l.tokenField).join() === 'max_tokens,max_completion_tokens', 'max_tokens 被拒后改用 max_completion_tokens，完整 URL 也能用');

  await fill(opts, { baseUrl: 'http://127.0.0.1:18802/v1', apiKey: 'wrong', model: 'mock-model' });
  await click(opts, 'save');
  const fb = (await call('find', { tabId, query: '提交' })).t;
  expect(/提交表单/.test(fb) && /AI matching with model "mock-model" failed \(HTTP 401/.test(fb), 'AI 调用失败时退回关键词匹配并注明原因');

  expect(/已清除.*本地关键词匹配/.test(await click(opts, 'clear')), '清除配置后显示关键词模式');
  const before = aiLog.length;
  await call('find', { tabId, query: '提交' }, { quiet: true });
  expect(aiLog.length === before, '清除后不再调用 AI');
  const popup = await openPage(`chrome-extension://${EXT_ID}/popup.html`);
  await sleep(300);
  expect((await popup.evaluate(`document.getElementById('aiMode').textContent`)) === '元素查找：关键词匹配', '弹窗显示当前查找模式');
  opts.close();
  popup.close();
} catch (e) {
  t.fail(e);
}
ai.close();
await t.done();
