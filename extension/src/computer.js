// computer 工具：鼠标、键盘、截图
import { hideIndicatorForTool, moveCursor, showIndicatorAfterTool } from './activity.js';
import { sleep, ToolError } from './cdp.js';
import { click, drag, hover, parseClickModifiers, pressKeys, scrollAt, typeText } from './input.js';
import { pageZoomShortcut } from './keys.js';
import { screenshot, storeImage, toViewport, zoom } from './screenshot.js';
import { assertSameDomain, getGroupId } from './tabs.js';

export const COMPUTER_ACTIONS = new Set([
  'left_click', 'right_click', 'type', 'screenshot', 'wait', 'scroll', 'key',
  'left_click_drag', 'double_click', 'triple_click', 'zoom', 'scroll_to', 'hover',
]);
const CLICK_COUNTS = { left_click: 1, right_click: 1, double_click: 2, triple_click: 3 };
const RELOAD_KEYS = new Set(['cmd+r', 'cmd+shift+r', 'ctrl+r', 'ctrl+shift+r', 'f5', 'ctrl+f5', 'shift+f5']);
const HARD_RELOAD_KEYS = new Set(['cmd+shift+r', 'ctrl+shift+r', 'ctrl+f5', 'shift+f5']);

const invalid = (message) => new ToolError('input_invalid', message);
const fmt = ([x, y]) => `(${Math.round(x)}, ${Math.round(y)})`;

function requirePoint(value, message) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw invalid(message);
  }
  return value;
}

// 点击可能打开新标签页（target=_blank 等），把它们收进标签组并告诉 Claude
function watchNewTabs(openerTabId) {
  const opened = [];
  const onCreated = (tab) => {
    if (tab.openerTabId === openerTabId && tab.id != null) opened.push(tab.id);
  };
  chrome.tabs.onCreated.addListener(onCreated);
  return async () => {
    await sleep(300);
    chrome.tabs.onCreated.removeListener(onCreated);
    const groupId = await getGroupId();
    for (const id of opened) {
      if (groupId == null) break;
      try {
        const t = await chrome.tabs.get(id);
        if (t.groupId !== groupId) await chrome.tabs.group({ tabIds: id, groupId });
      } catch {
        // 新标签页可能在其他窗口，无法加入标签组
      }
    }
    return opened;
  };
}

// 返回 [x, y]（视口 CSS 像素）；按 ref 定位且元素中心被遮挡时附带 covered 说明
async function resolveTarget(tabId, args, agent, action) {
  if (args.ref) {
    const { x, y, covered } = await agent(tabId, 'scrollToRef', { ref: args.ref });
    const point = [x, y];
    point.covered = covered;
    return point;
  }
  if (!args.coordinate) throw invalid(`Either ref or coordinate parameter is required for ${action} action`);
  return toViewport(tabId, requirePoint(args.coordinate, 'coordinate must be [x, y]'));
}

const coveredNote = (point) => (point.covered ? ` [note: the element's center is covered by ${point.covered}, so the action may have landed on that instead — take a screenshot to verify]` : '');

// 鼠标操作前把页面上的光标移到目标处，操作期间隐藏边框和停止按钮（避免误点到按钮）
async function withPointer(tabId, [x, y], fn) {
  await moveCursor(tabId, x, y);
  await hideIndicatorForTool(tabId, { cursor: false });
  try {
    return await fn();
  } finally {
    showIndicatorAfterTool(tabId);
  }
}

async function takeScreenshot(tabId, scale, pendingScope) {
  const s = await screenshot(tabId, { scale, pendingScope });
  const id = storeImage(s.base64, `image/${s.format}`);
  const scaleNote = scale !== undefined && scale < 1 ? ` — ${scale}-scale view; coordinate frame: ${s.frameWidth}x${s.frameHeight}.` : '';
  return {
    output: `Successfully captured screenshot (${s.width}x${s.height}, ${s.format}) - ID: ${id}${scaleNote}`,
    base64Image: s.base64,
    imageFormat: s.format,
    _viewport: [s.viewportWidth, s.viewportHeight],
  };
}

// ctx.startUrl：工具开始时的页面地址，用于在真正操作前确认页面没有跳到别的域名
export async function computer(args, ctx, agent) {
  const { tabId, action } = args;
  if (!COMPUTER_ACTIONS.has(action)) throw invalid(`Unsupported action: ${action}`);
  const guard = (label) => assertSameDomain(tabId, ctx.startUrl, label);

  if (CLICK_COUNTS[action]) {
    const point = await resolveTarget(tabId, args, agent, 'click');
    await guard('click action');
    const finishWatch = watchNewTabs(tabId);
    let opened;
    try {
      await withPointer(tabId, point, () => click(tabId, point[0], point[1], {
        button: action === 'right_click' ? 'right' : 'left',
        count: CLICK_COUNTS[action],
        modifiers: parseClickModifiers(args.modifiers),
      }));
    } finally {
      opened = await finishWatch();
    }
    const verb = { 1: 'Clicked', 2: 'Double-clicked', 3: 'Triple-clicked' }[CLICK_COUNTS[action]];
    const note = opened.length ? ` [note: the link opened in a new tab (tab ID ${opened.join(', ')}); pass that tab ID to interact with it]` : '';
    return { output: args.ref ? `${verb} on element ${args.ref}${note}${coveredNote(point)}` : `${verb} at ${fmt(args.coordinate)}${note}`, _point: point };
  }

  switch (action) {
    case 'screenshot':
      return takeScreenshot(tabId, args.scale, ctx.pendingScope);

    case 'type': {
      if (typeof args.text !== 'string' || !args.text) throw invalid('Text parameter must be a non-empty string for type action');
      await guard('type action');
      await typeText(tabId, args.text);
      return { output: `Typed "${args.text}"` };
    }

    case 'key': {
      if (typeof args.text !== 'string' || !args.text.trim()) throw invalid('Text parameter must be a non-empty string for key action');
      const repeat = args.repeat ?? 1;
      if (!Number.isInteger(repeat) || repeat < 1) throw invalid('Repeat parameter must be a positive integer');
      if (repeat > 100) throw invalid('Repeat parameter cannot exceed 100');
      const keys = args.text.trim().split(/\s+/);
      await guard('key action');
      if (keys.length === 1 && RELOAD_KEYS.has(keys[0].toLowerCase())) {
        const hard = HARD_RELOAD_KEYS.has(keys[0].toLowerCase());
        await chrome.tabs.reload(tabId, { bypassCache: hard });
        return { output: `Executed ${keys[0]} (${hard ? 'hard reload' : 'reload'} page)` };
      }
      const zoomKey = keys.find((k) => pageZoomShortcut(k));
      if (zoomKey) {
        throw new ToolError('page_zoom_shortcut_unsupported', `"${zoomKey}" was not pressed: page zoom keyboard shortcuts are not supported. To magnify part of the page for closer inspection, use the zoom action with a region instead.`);
      }
      await pressKeys(tabId, keys, repeat);
      return { output: `Pressed ${keys.length} key${keys.length === 1 ? '' : 's'}: ${keys.join(' ')}${repeat > 1 ? ` (repeated ${repeat} times)` : ''}` };
    }

    case 'wait': {
      if (!(args.duration > 0)) throw invalid('Duration parameter is required and must be positive');
      if (args.duration > 10) throw invalid('Duration cannot exceed 10 seconds');
      await sleep(Math.round(args.duration * 1000));
      return { output: `Waited for ${args.duration} second${args.duration === 1 ? '' : 's'}` };
    }

    case 'scroll': {
      let point;
      if (args.coordinate) {
        point = toViewport(tabId, requirePoint(args.coordinate, 'coordinate must be [x, y]'));
      } else {
        const tab = await chrome.tabs.get(tabId);
        point = [tab.width / 2, tab.height / 2];
      }
      const direction = args.scroll_direction || 'down';
      const amount = args.scroll_amount || 3;
      const delta = { up: [0, -amount * 100], down: [0, amount * 100], left: [-amount * 100, 0], right: [amount * 100, 0] }[direction];
      if (!delta) throw invalid(`Invalid scroll direction: ${direction}`);
      await guard('scroll');
      await withPointer(tabId, point, () => scrollAt(tabId, point[0], point[1], delta[0], delta[1]));
      await sleep(200);
      const where = args.coordinate ? ` at ${fmt(args.coordinate)}` : '';
      const shot = await takeScreenshot(tabId, undefined, ctx.pendingScope).catch(() => null);
      return { output: `Scrolled ${direction} by ${amount} ticks${where}`, ...(shot && { base64Image: shot.base64Image, imageFormat: shot.imageFormat }), _point: point };
    }

    case 'left_click_drag': {
      const start = toViewport(tabId, requirePoint(args.start_coordinate, 'start_coordinate parameter is required for left_click_drag action'));
      const end = toViewport(tabId, requirePoint(args.coordinate, 'coordinate parameter (end position) is required for left_click_drag action'));
      await guard('drag action');
      await withPointer(tabId, start, () => drag(tabId, start, end));
      moveCursor(tabId, end[0], end[1]);
      return { output: `Dragged from ${fmt(args.start_coordinate)} to ${fmt(args.coordinate)}`, _point: end, _startPoint: start };
    }

    case 'zoom': {
      const region = args.region;
      if (!Array.isArray(region) || region.length !== 4) throw invalid('Region parameter is required for zoom action and must be [x0, y0, x1, y1]');
      const [x0, y0, x1, y1] = region;
      if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) throw invalid('Invalid region coordinates: x0 and y0 must be non-negative, and x1 > x0, y1 > y0');
      const z = await zoom(tabId, region, args.scale);
      const id = storeImage(z.base64, `image/${z.format}`);
      return {
        output: `Successfully captured zoomed screenshot of region (${Math.round(x0)},${Math.round(y0)}) to (${Math.round(x1)},${Math.round(y1)}) - ${z.width}x${z.height} pixels - ID: ${id}`,
        base64Image: z.base64,
        imageFormat: z.format,
      };
    }

    case 'scroll_to': {
      if (!args.ref) throw invalid('ref parameter is required for scroll_to action');
      await guard('scroll_to action');
      await agent(tabId, 'scrollToRef', { ref: args.ref });
      return { output: `Scrolled to element with reference: ${args.ref}` };
    }

    case 'hover': {
      const point = await resolveTarget(tabId, args, agent, 'hover');
      await guard('hover action');
      await withPointer(tabId, point, () => hover(tabId, point[0], point[1]));
      return { output: args.ref ? `Hovered over element ${args.ref}${coveredNote(point)}` : `Hovered at ${fmt(args.coordinate)}`, _point: point };
    }
  }
}
