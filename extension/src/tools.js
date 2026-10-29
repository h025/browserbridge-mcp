// 工具实现与分发。每个工具返回 { output, base64Image?, imageFormat?, tabContext?, batchItems? }
// 或抛出 ToolError；runTool 统一转成 { error, errorCode }，由 MCP 服务格式化后交给 Claude。
import { toolFinished, toolStarted } from './activity.js';
import { extensionVersion } from './bridge.js';
import {
  clearConsoleMessages, clearNetworkRequests, enableConsoleTracking, enableNetworkTracking, ensureAttached, getConsoleMessages, getNetworkRequests,
  navigateWithBeforeunload, protectedProtocol, sendCommand, settlePendingDialog, sleep, takeDialogNotes, ToolError, withTimeout,
} from './cdp.js';
import { computer } from './computer.js';
import { gifCreator, recordAction } from './gif.js';
import { beginPendingScope, clearPendingContexts, commitPendingContexts, loadImage, toViewport } from './screenshot.js';
import {
  assertSameDomain, assertTabInGroup, createTabInGroup, getGroupId, getOrCreateContext, listGroupTabs, sessionTitle, setSessionTask, tabContext, waitForLoad,
} from './tabs.js';

const JS_TIMEOUT_MS = 30_000;
const JS_OUTPUT_LIMIT = 51_200;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SCRIPT_TIMEOUT_MS = 15_000;
const CANDIDATES_MAX_CHARS = 8_000;
// 候选元素列表里的链接地址只保留开头，几百个字符的地址既占篇幅又没用
const HREF_KEEP = 60;
// 候选清单被截断（页面很大）时，建议能开子助手的调用方交给子助手读整页，主对话只拿回编号
const CANDIDATES_TRUNCATED_HINT =
  'This list is incomplete. If you can delegate to a sub-agent, have it call read_page on this tab and report back only the matching ref, ' +
  'and whether that line is marked hidden (a hidden element must be revealed first, e.g. by expanding its menu or section). ' +
  'It shares this tab group, and refs it finds stay valid for you. Otherwise scroll to bring other elements into view, or use read_page yourself.';

const invalid = (message) => new ToolError('input_invalid', message);

// 调用 page-agent.js 里的方法；扩展安装前已打开的页面没有内容脚本，按需注入后重试
async function agent(tabId, method, args = {}) {
  const call = async () => {
    const [res] = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        func: (m, a) => (typeof window.__bbAgent === 'function' ? window.__bbAgent(m, a) : null),
        args: [method, args],
      }),
      SCRIPT_TIMEOUT_MS,
      () => new ToolError('page_loading', `Script injection timed out after ${SCRIPT_TIMEOUT_MS}ms — the page is busy or mid-navigation. Try again in a moment.`),
    );
    return res?.result;
  };
  let result = await call();
  if (result == null) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/page-agent.js'] });
    result = await call();
  }
  if (!result) throw new ToolError('injected_script_failed', 'Page script returned no result. The page may still be loading — try again in a moment.');
  if (!result.ok) throw new ToolError(result.code || 'injected_script_failed', result.error);
  return result.value;
}

// 标记 Claude 正在操作该标签页（显示页面指示器），工具结束时由 runOne 收尾
function markActive(tabId, ctx) {
  toolStarted(tabId);
  ctx.activeTabs.push(tabId);
}

// 校验标签页、标记活动，并尽早附加调试器（开始记录控制台/网络、启用焦点模拟）
async function useTab(tabId, ctx) {
  const tab = await assertTabInGroup(tabId, ctx.session);
  const proto = protectedProtocol(tab.url);
  if (proto) {
    throw new ToolError('chrome_protected_page', `Cannot control ${proto}// pages. Navigate to a regular web page (http:// or https://) first, then retry.`);
  }
  markActive(tabId, ctx);
  await ensureAttached(tabId).catch(() => {});
  settlePendingDialog(tabId);
  return tab;
}

function normalizeUrl(url) {
  const u = url.trim();
  if (/^javascript:/i.test(u)) throw invalid('javascript: URLs are not supported; use javascript_tool instead.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(about|data):/i.test(u)) return u;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u)) return `http://${u}`;
  return `https://${u}`;
}

// 防止把页面里的凭据、令牌等敏感数据带进对话
const SENSITIVE_KEYS = [/password/i, /token/i, /secret/i, /api[_-]?key/i, /auth/i, /credential/i, /private[_-]?key/i, /access[_-]?key/i, /bearer/i, /oauth/i, /session/i];
function sanitize(value, depth = 0) {
  if (depth > 5) return '[TRUNCATED: Max depth exceeded]';
  if (typeof value === 'string') {
    if (value.includes('=') && (value.includes(';') || value.includes('&'))) return '[BLOCKED: Cookie/query string data]';
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return '[BLOCKED: JWT token]';
    if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(value)) return '[BLOCKED: Base64 encoded data]';
    if (/^[a-f0-9]{32,}$/i.test(value)) return '[BLOCKED: Hex credential]';
    return value.length > 1000 ? `${value.slice(0, 1000)}[TRUNCATED]` : value;
  }
  if (Array.isArray(value)) {
    const out = value.slice(0, 100).map((v) => sanitize(v, depth + 1));
    if (value.length > 100) out.push(`[TRUNCATED: ${value.length - 100} more items]`);
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.some((re) => re.test(k))) out[k] = '[BLOCKED: Sensitive key]';
      else if (k === 'cookie' || k === 'cookies') out[k] = '[BLOCKED: Cookie access]';
      else out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

function formatJsResult(r) {
  if (!r || r.type === 'undefined') return 'undefined';
  if (r.type === 'object' && r.subtype === 'null') return 'null';
  if (r.type === 'function') return r.description || '[Function]';
  if (r.type === 'object' && r.subtype === 'node') return r.description || '[DOM Node]';
  if (r.value !== undefined) {
    const v = sanitize(r.value);
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  }
  return r.description || r.unserializableValue || String(r.value);
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_KEYS.some((re) => re.test(key)) || /^(code|sig|signature|key)$/i.test(key)) u.searchParams.set(key, 'REDACTED');
    }
    return u.toString();
  } catch {
    return url;
  }
}

const TOOLS = {
  async tabs_context_mcp({ createIfEmpty, taskName } = {}, { session }) {
    // 任务名用于标签组标题，先记下来，新建的组直接用上
    if (taskName) await setSessionTask(session, taskName);
    const ctx = await getOrCreateContext(session, { createIfEmpty: !!createIfEmpty });
    if (!ctx) return { output: `No "${await sessionTitle(session)}" tab group found. Use createIfEmpty: true to create a group.` };
    return {
      output: JSON.stringify({
        availableTabs: ctx.availableTabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url })),
        tabGroupId: ctx.tabGroupId,
      }),
    };
  },

  async tabs_create_mcp(_args, ctx) {
    const { tab } = await createTabInGroup(ctx.session);
    // 和其他工具一样标记活动：调用结束后计时，空闲一段时间自动断开调试器
    markActive(tab.id, ctx);
    await ensureAttached(tab.id).catch(() => {});
    return { output: `Created new tab. Tab ID: ${tab.id}`, tabContext: await tabContext(tab.id, ctx.session) };
  },

  async tabs_close_mcp({ tabId }, { session }) {
    if (!Number.isInteger(tabId)) throw new ToolError('tab_close_invalid_params', 'Missing required parameter tabId (integer)');
    await assertTabInGroup(tabId, session);
    const groupId = await getGroupId(session);
    await chrome.tabs.remove(tabId);
    const remaining = await listGroupTabs(groupId);
    return {
      output: remaining.length ? `Closed tab ${tabId}. ${remaining.length} tab(s) remain.` : `Closed tab ${tabId}. Group is now empty (auto-removed).`,
      tabContext: { availableTabs: remaining },
    };
  },

  async navigate({ url, tabId, force }, ctx) {
    if (typeof url !== 'string' || !url.trim()) throw invalid('URL parameter is required');
    await assertTabInGroup(tabId, ctx.session);
    markActive(tabId, ctx);
    await ensureAttached(tabId).catch(() => {});
    settlePendingDialog(tabId);
    const direction = ['back', 'forward'].includes(url.toLowerCase()) ? url.toLowerCase() : null;
    let target;
    if (!direction) {
      target = normalizeUrl(url);
      try {
        new URL(target);
      } catch {
        throw invalid(`Invalid URL: ${url}`);
      }
    }
    const outcome = await navigateWithBeforeunload(tabId, !!force, async () => {
      if (!direction) return chrome.tabs.update(tabId, { url: target });
      try {
        await (direction === 'back' ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId));
      } catch {
        throw new ToolError('navigate_no_history', `Cannot go ${direction}: there is no ${direction} history for this tab.`);
      }
    });
    if (outcome?.action === 'dismissed') {
      throw new ToolError(
        'navigate_beforeunload_blocked',
        `Navigation was blocked by a "Leave site?" dialog — the page at ${outcome.url} has unsaved changes. The page is still open and unchanged. ` +
          'Either address the unsaved state first, or retry with force: true to discard it and navigate anyway.',
      );
    }
    const tab = await waitForLoad(tabId, 15_000);
    const finalUrl = tab?.pendingUrl || tab?.url || target;
    const suffix = outcome?.action === 'accepted' ? ' (discarded a "Leave site?" dialog — the page had unsaved changes that are now lost)' : '';
    const stillLoading = tab?.status === 'loading' ? ' (page is still loading)' : '';
    return { output: `Navigated ${direction ? `${direction} ` : ''}to ${finalUrl}${stillLoading}${suffix}` };
  },

  async computer(args, ctx) {
    const tab = await useTab(args.tabId, ctx);
    return computer(args, { ...ctx, startUrl: tab.url }, agent);
  },

  async read_page({ tabId, filter, depth, ref_id, max_chars }, ctx) {
    await useTab(tabId, ctx);
    const r = await agent(tabId, 'accessibilityTree', { filter, depth, maxChars: max_chars, refId: ref_id });
    return { output: `${r.pageContent}\n\nViewport: ${r.viewport.width}x${r.viewport.height}` };
  },

  // 按文字和元素类型做关键词匹配；匹配不上，或匹配到的都不能点击、输入时，把视口里可交互的元素交给调用方 agent，
  // 由它自己判断（不依赖任何外部 AI 接口）
  async find({ tabId, query }, ctx) {
    if (typeof query !== 'string' || !query.trim()) throw invalid('Query parameter is required');
    await useTab(tabId, ctx);
    const { total, items } = await agent(tabId, 'find', { query, limit: 20 });
    const candidates = async () =>
      (await agent(tabId, 'accessibilityTree', { filter: 'interactive', maxChars: CANDIDATES_MAX_CHARS, hrefMax: HREF_KEEP, truncatedHint: CANDIDATES_TRUNCATED_HINT })).pageContent;
    if (!items.length) {
      const list = await candidates();
      if (!list.trim()) {
        throw new ToolError('find_no_match', `No elements matching "${query}" found. Try different keywords, or use read_page to inspect the page.`);
      }
      return {
        output: `No element text matched "${query}". These are the interactive elements currently in view; pick the one that fits the description yourself (refs work with the other tools):\n\n${list}`,
      };
    }
    const more = total > items.length ? ` (showing first ${items.length}, use a more specific query to narrow results)` : '';
    const name = (s) => ` "${s.replace(/\s+/g, ' ').slice(0, 100).replace(/[\\"]/g, '\\$&')}"`;
    const lines = items.map((m) => `- ${m.ref}: ${m.role}${m.name ? name(m.name) : ''}${m.type ? ` (${m.type})` : ''}${m.hidden ? ' [not visible]' : ''}`);
    let output = `Found ${total} matching element${total === 1 ? '' : 's'}${more}\n\n${lines.join('\n')}`;
    if (!items.some((m) => m.interactive)) {
      const list = await candidates();
      if (list.trim()) output += `\n\nNone of these can be clicked or typed into. Interactive elements currently in view, if you need one of them instead:\n\n${list}`;
    }
    return { output };
  },

  async form_input({ tabId, ref, value }, ctx) {
    if (!ref) throw invalid('ref parameter is required');
    if (value === undefined || value === null) throw invalid('Value parameter is required');
    const tab = await useTab(tabId, ctx);
    await assertSameDomain(tabId, tab.url, 'form input action');
    return { output: await agent(tabId, 'formInput', { ref, value }) };
  },

  async get_page_text({ tabId, max_chars }, ctx) {
    await useTab(tabId, ctx);
    const r = await agent(tabId, 'pageText', { maxChars: max_chars ?? 50_000 });
    return { output: `Title: ${r.title}\nURL: ${redactUrl(r.url)}\nSource element: <${r.source}>\n---\n${r.text}` };
  },

  async javascript_tool({ action, text, tabId }, ctx) {
    if (action !== 'javascript_exec') throw invalid("'javascript_exec' is the only supported action");
    if (typeof text !== 'string' || !text.trim()) throw invalid('Code parameter is required');
    const tab = await useTab(tabId, ctx);
    await assertSameDomain(tabId, tab.url, 'JavaScript execution');
    const evaluate = (expression, replMode) =>
      sendCommand(tabId, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        replMode,
        userGesture: true,
        timeout: JS_TIMEOUT_MS,
      }, JS_TIMEOUT_MS + 5000);
    // REPL 语义：支持顶层 await 并返回最后一个表达式；代码里写了 return 时改用 async 函数包裹
    let res = await evaluate(`{${text}\n}`, true);
    const syntax = res.exceptionDetails?.exception?.className === 'SyntaxError' ? res.exceptionDetails.exception.description || '' : '';
    if (/Illegal return statement/.test(syntax)) res = await evaluate(`(async()=>{\n${text}\n})()`, false);
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Unknown error';
      if (desc.includes('execution was terminated')) throw new ToolError('js_timeout', `Execution timeout: Code exceeded ${JS_TIMEOUT_MS / 1000}-second limit`);
      throw new ToolError('js_execution_error', `JavaScript execution error: ${desc}`);
    }
    let out = formatJsResult(res.result);
    if (out.length > JS_OUTPUT_LIMIT) out = `${out.slice(0, JS_OUTPUT_LIMIT)}\n[OUTPUT TRUNCATED: Exceeded 50KB limit]`;
    return { output: out };
  },

  async read_console_messages({ tabId, onlyErrors = false, clear = false, pattern, limit = 100 }, ctx) {
    await useTab(tabId, ctx);
    await enableConsoleTracking(tabId);
    const messages = getConsoleMessages(tabId, onlyErrors, pattern);
    if (clear) clearConsoleMessages(tabId);
    if (!messages.length) {
      return {
        output: `No console ${onlyErrors ? 'errors or exceptions' : 'messages'} found for this tab.\n\n` +
          'Note: Console tracking starts when this tool is first called on a tab (messages the page already logged are included when available). If you expected messages from page load, refresh the page and read again.',
      };
    }
    const shown = messages.slice(0, limit);
    const body = shown.map((m, i) => {
      const where = m.url && m.lineNumber !== undefined ? ` (${redactUrl(m.url)}:${m.lineNumber}${m.columnNumber !== undefined ? `:${m.columnNumber}` : ''})` : '';
      let entry = `[${i + 1}] [${new Date(m.timestamp).toLocaleTimeString()}] [${m.type.toUpperCase()}]${where}\n${m.text}`;
      if (m.stackTrace) entry += `\nStack trace:\n${m.stackTrace}`;
      return entry;
    }).join('\n\n');
    const more = messages.length > limit ? ` (showing first ${limit} of ${messages.length})` : '';
    return { output: `Found ${messages.length} ${onlyErrors ? 'error/exception messages' : 'console messages'}${more}:\n\n${body}` };
  },

  async read_network_requests({ tabId, urlPattern, clear = false, limit = 100 }, ctx) {
    await useTab(tabId, ctx);
    await enableNetworkTracking(tabId);
    const all = getNetworkRequests(tabId);
    const matched = urlPattern ? all.filter((r) => redactUrl(r.url).includes(urlPattern)) : all;
    if (clear) clearNetworkRequests(tabId);
    if (!matched.length) {
      return {
        output: `No ${urlPattern ? `requests matching "${urlPattern}"` : 'network requests'} found for this tab.\n\n` +
          'Note: Network tracking starts when this tool is first called on a tab. If the page loaded before that, refresh the page or perform actions that trigger network requests, then read again.',
      };
    }
    const shown = matched.slice(0, limit);
    const body = shown.map((r, i) => `${i + 1}. url: ${redactUrl(r.url)}\n   method: ${r.method}\n   statusCode: ${r.status ?? 'pending'}${r.type ? `\n   type: ${r.type}` : ''}`).join('\n\n');
    const filter = urlPattern ? ` (filtered by URL pattern: "${urlPattern}")` : '';
    const more = matched.length > limit ? ` (showing first ${limit} of ${matched.length})` : '';
    return { output: `Found ${matched.length} network request${matched.length === 1 ? '' : 's'}${filter}${more}:\n\n${body}` };
  },

  async resize_window({ width, height, tabId }, { session }) {
    if (typeof width !== 'number' || typeof height !== 'number') throw invalid('Both width and height parameters are required and must be numbers');
    if (width <= 0 || height <= 0) throw invalid('Width and height must be positive numbers');
    if (width > 7680 || height > 4320) throw invalid('Dimensions exceed 8K resolution limit. Maximum dimensions are 7680x4320');
    const tab = await assertTabInGroup(tabId, session);
    await chrome.windows.update(tab.windowId, { state: 'normal', width: Math.floor(width), height: Math.floor(height) });
    return { output: `Successfully resized window containing tab ${tabId} to ${Math.floor(width)}x${Math.floor(height)} pixels` };
  },

  async file_upload({ ref, tabId, files }, ctx) {
    if (!Array.isArray(files) || !files.length) throw invalid('files parameter is required and must be a non-empty array');
    let total = 0;
    for (const f of files) {
      if (typeof f?.data !== 'string' || typeof f?.name !== 'string' || !f.name || /[\\/]/.test(f.name)) {
        throw invalid('each file must have `data` (base64) and a plain file `name`');
      }
      total += Math.floor((f.data.length * 3) / 4);
    }
    if (total > MAX_UPLOAD_BYTES) throw invalid('Total upload size exceeds 10 MB; use smaller files or split across multiple file_upload calls.');
    if (!ref) throw invalid('ref parameter is required');
    const tab = await useTab(tabId, ctx);
    await assertSameDomain(tabId, tab.url, 'file upload action');
    return { output: await agent(tabId, 'uploadFiles', { ref, files }) };
  },

  // 把之前的截图（按 ID）上传到文件输入框，或拖放到页面坐标处
  async upload_image({ imageId, ref, coordinate, tabId, filename }, ctx) {
    if (!imageId) throw invalid('imageId parameter is required');
    if (!ref && !coordinate) throw invalid('Either ref or coordinate parameter is required. Provide ref for targeting specific elements or coordinate for drag & drop to a location.');
    if (ref && coordinate) throw invalid('Provide either ref or coordinate, not both. Use ref for specific elements or coordinate for drag & drop.');
    const tab = await useTab(tabId, ctx);
    const point = coordinate ? toViewport(tabId, coordinate) : null;
    const image = await loadImage(imageId);
    if (!image) {
      throw new ToolError('screenshot_bytes_unavailable', 'The requested screenshot is no longer available (it may have expired, or was not taken in this session). Take a new screenshot with the computer tool and retry the upload with its new ID.');
    }
    const name = filename || (image.mimeType === 'image/png' ? 'image.png' : 'image.jpg');
    await assertSameDomain(tabId, tab.url, 'upload image action');
    return { output: await agent(tabId, 'dropFiles', { ref, point, label: coordinate, files: [{ name, data: image.data, mimeType: image.mimeType }] }) };
  },

  async gif_creator(args, ctx) {
    if (!args.action) throw invalid('action parameter is required');
    const tab = await useTab(args.tabId, ctx);
    return gifCreator(args, tab, agent, tab.url);
  },

  // 一次往返顺序执行多个工具调用，遇到第一个错误即停止
  async browser_batch({ actions }, ctx) {
    if (!Array.isArray(actions) || !actions.length) throw new ToolError('batch_invalid_input', 'actions must be a non-empty array');
    actions.forEach((a, i) => {
      if (!a || typeof a.name !== 'string') throw new ToolError('batch_invalid_input', `actions[${i}].name must be a string`);
      if (a.name === 'browser_batch') throw new ToolError('batch_invalid_input', `actions[${i}]: browser_batch cannot be nested`);
      if (!a.input || typeof a.input !== 'object') throw new ToolError('batch_invalid_input', `actions[${i}].input must be an object`);
      if (!TOOLS[a.name]) throw new ToolError('batch_invalid_input', `actions[${i}]: unknown tool "${a.name}"`);
    });
    const scope = beginPendingScope();
    const items = [];
    let lastTabId;
    try {
      const done = () => items.map((it) => `[${it.label}] ${it.output ?? 'ok'}${it.base64Image ? ' [Image omitted due to error]' : ''}`).join('\n');
      for (let i = 0; i < actions.length; i++) {
        const { name, input } = actions[i];
        const label = typeof input.action === 'string' ? `${name}:${input.action}` : name;
        if (ctx.isCancelled?.()) {
          throw new ToolError('batch_cancelled', `${done() ? `${done()}\n\n` : ''}Batch cancelled by the client before action ${i + 1} of ${actions.length}.`);
        }
        let result;
        try {
          result = await runOne(name, input, { pendingScope: scope, session: ctx.session });
        } catch (e) {
          throw new ToolError(e?.code || 'batch_action_failed', `${done() ? `${done()}\n\n` : ''}[${label}] failed (action ${i + 1} of ${actions.length}): ${e?.message || e}`);
        }
        items.push({ label, output: result.output, base64Image: result.base64Image, imageFormat: result.imageFormat, gifFile: result.gifFile });
        if (typeof input.tabId === 'number') {
          lastTabId = input.tabId;
          // 上一步可能触发了页面跳转，最多等 3 秒让它加载
          const start = Date.now();
          while (Date.now() - start < 3000) {
            const tab = await chrome.tabs.get(lastTabId).catch(() => null);
            if (!tab || tab.status !== 'loading') break;
            await sleep(100);
          }
        }
      }
      commitPendingContexts(scope);
    } finally {
      clearPendingContexts(scope);
    }
    return { batchItems: items, tabContext: await tabContext(lastTabId, ctx.session) };
  },
};

const NO_TAB_CONTEXT = new Set(['tabs_context_mcp', 'resize_window', 'browser_batch', 'tabs_close_mcp']);

function errorCodeFor(e) {
  if (e instanceof ToolError) return e.code;
  const msg = String(e?.message || e);
  if (/^No tab with (given )?id/.test(msg)) return 'tab_not_found';
  if (/Cannot access a chrome:\/\/ URL|extensions gallery cannot be scripted/.test(msg)) return 'chrome_protected_page';
  if (/must request permission to access|Cannot access contents of/.test(msg)) return 'chrome_refused_page_access';
  if (/Inspected target navigated or closed|Execution context was destroyed|Frame with ID/.test(msg)) return 'page_navigated_or_closed';
  return 'tool_execution_exception';
}

// 执行单个工具：结束后收尾页面指示器（开始 20 秒空闲计时），录制中则记录 GIF 帧
async function runOne(name, args, ctx) {
  const local = { ...ctx, activeTabs: [] };
  try {
    const result = await TOOLS[name](args, local);
    await recordAction(name, args, result).catch(() => {});
    return result;
  } finally {
    for (const tabId of local.activeTabs) toolFinished(tabId);
  }
}

// opts.isCancelled：MCP 客户端取消了这次调用（例如用户在 Claude Code 里按了 Esc）
// opts.session：发起调用的会话（agent），只能操作该会话自己的标签组
export async function runTool(name, args = {}, opts = {}) {
  if (!TOOLS[name]) {
    const version = extensionVersion();
    return { error: `Unknown tool: ${name}. The Browser Bridge extension (v${version}) may be older than the MCP server — ask the user to reload it in chrome://extensions.`, errorCode: 'unknown_tool' };
  }
  let result;
  try {
    result = await runOne(name, args || {}, { isCancelled: opts.isCancelled, session: opts.session });
  } catch (e) {
    const code = errorCodeFor(e);
    let message = String(e?.message || e);
    if (code === 'chrome_refused_page_access') {
      message = 'Chrome blocked the extension from accessing this page, usually because the page was still navigating or redirecting. Wait for it to finish loading and try again.';
    } else if (code === 'page_navigated_or_closed') {
      message += ' The tab navigated or was closed mid-operation; call tabs_context_mcp to refresh tab IDs, then retry against the current page.';
    }
    return { error: message, errorCode: code };
  }
  // 把执行期间自动处理的对话框告诉 Claude（browser_batch 里涉及的标签页也一并收集）
  const tabIds = new Set(name === 'browser_batch'
    ? (args.actions || []).map((a) => a?.input?.tabId).filter((t) => typeof t === 'number')
    : [args?.tabId].filter((t) => typeof t === 'number'));
  const notes = [...tabIds].flatMap((t) => takeDialogNotes(t));
  if (notes.length) {
    const text = notes.map((n) => `[note: ${n}]`).join('\n');
    const target = result.batchItems?.at(-1) ?? result;
    target.output = target.output ? `${target.output}\n\n${text}` : text;
  }
  const tabId = args?.tabId;
  if (typeof tabId === 'number' && !result.tabContext && !NO_TAB_CONTEXT.has(name)) {
    result.tabContext = await tabContext(tabId, opts.session).catch(() => undefined);
  }
  for (const key of Object.keys(result)) if (key.startsWith('_')) delete result[key];
  return result;
}
