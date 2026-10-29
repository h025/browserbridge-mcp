// 可选的 AI 元素查找：在设置页填写 OpenAI 兼容接口（地址、Key、模型）后，find 工具把页面的
// 可访问性树和查询发给该模型，由模型理解自然语言；
// 未填写时 find 使用本地关键词匹配。配置只存在本机 chrome.storage.local，不会同步。

const STORAGE_KEY = 'aiConfig';
const REQUEST_TIMEOUT_MS = 60_000;
export const AI_TREE_MAX_CHARS = 30_000;

export async function getAiConfig() {
  const { [STORAGE_KEY]: c } = await chrome.storage.local.get(STORAGE_KEY);
  return { baseUrl: c?.baseUrl || '', apiKey: c?.apiKey || '', model: c?.model || '' };
}

export async function saveAiConfig({ baseUrl, apiKey, model }) {
  await chrome.storage.local.set({ [STORAGE_KEY]: { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() } });
}

export async function clearAiConfig() {
  await chrome.storage.local.remove(STORAGE_KEY);
}

// 接口地址和模型都填了才启用；API Key 可以为空（例如本机的 Ollama）
export const aiEnabled = (c) => Boolean(c.baseUrl && c.model);

// 接受 https://host（补成 /v1/chat/completions）、https://host/v1，或完整的 …/chat/completions
export function endpointOf(baseUrl) {
  const u = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) return u;
  let hasPath = false;
  try {
    hasPath = new URL(u).pathname.replace(/\/+$/, '') !== '';
  } catch {
    // 地址不合法，交给 fetch 报错
  }
  return hasPath ? `${u}/chat/completions` : `${u}/v1/chat/completions`;
}

async function chat(config, messages, maxTokens) {
  const send = (tokenField) => fetch(endpointOf(config.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey && { Authorization: `Bearer ${config.apiKey}` }),
    },
    body: JSON.stringify({ model: config.model, messages, [tokenField]: maxTokens }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let res;
  let text;
  try {
    res = await send('max_tokens');
    text = await res.text();
    // 部分新模型不接受 max_tokens，只接受 max_completion_tokens
    if (res.status === 400 && /max_tokens/.test(text) && /max_completion_tokens/.test(text)) {
      res = await send('max_completion_tokens');
      text = await res.text();
    }
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new Error(`request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw new Error(`request failed: ${e?.message || e}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`response is not JSON: ${text.slice(0, 200)}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  const out = Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : content;
  if (typeof out !== 'string') throw new Error(`unexpected response: ${text.slice(0, 200)}`);
  // 推理模型可能把思考过程放在 <think> 里
  return out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// 设置页的“测试连接”
export async function testConnection(config) {
  return chat(config, [{ role: 'user', content: 'Reply with the single word: pong' }], 20);
}

function findPrompt(query, tree) {
  return `You are helping find elements on a web page. The user wants to find: "${query}"

Here is the accessibility tree of the page. Each element ends with its reference in brackets, like [ref_12]:
${tree}

Find ALL elements that match the user's query. Return up to 20 of the most relevant matches, ordered by relevance.

Reply in exactly this format (one line per matching element):

FOUND: <total number of matching elements>
SHOWING: <number shown, at most 20>
---
ref_X | role | name | type | reason why this matches
ref_Y | role | name | type | reason why this matches

If there are more than 20 matches, add this line at the end:
MORE: Use a more specific query to see additional results

If no matching elements are found, reply only:
FOUND: 0
ERROR: <explanation of why no elements were found>`;
}

// 解析模型回复；只保留页面里真实存在的 ref，防止模型编造
export function parseFindReply(reply, tree) {
  const valid = new Set((tree.match(/\[ref_\d+\]/g) || []).map((r) => r.slice(1, -1)));
  const items = [];
  let total = 0;
  let invented = 0;
  let more = false;
  let error;
  for (const raw of reply.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s*/, '');
    if (/^FOUND:/i.test(line)) total = parseInt(line.slice(6), 10) || 0;
    else if (/^ERROR:/i.test(line)) error = line.slice(6).trim();
    else if (/^MORE:/i.test(line)) more = true;
    else if (/^ref_\d+\s*\|/.test(line)) {
      const [ref, role = '', name = '', type = '', ...reason] = line.split('|').map((s) => s.trim());
      if (!valid.has(ref)) invented++;
      else if (items.length < 20 && !items.some((i) => i.ref === ref)) items.push({ ref, role, name, type, reason: reason.join(' | ') });
    }
  }
  // 模型声称的总数里去掉被过滤的编造 ref
  return { total: Math.max(total - invented, items.length), items, more, error };
}

export async function aiFind(config, query, tree) {
  const reply = await chat(config, [{ role: 'user', content: findPrompt(query, tree) }], 1200);
  return parseFindReply(reply, tree);
}
