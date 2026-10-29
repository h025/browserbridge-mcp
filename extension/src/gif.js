// GIF 录制：start_recording 之后，每次 computer / navigate 操作完成都会截一帧并记下动作；
// 导出时在离屏文档里叠加点击标记、拖拽路径、动作标签、进度条并编码成 GIF。
// 录制按标签组区分，最多保留 50 帧。
import { sleep, ToolError } from './cdp.js';
import { screenshot, toViewport } from './screenshot.js';
import { assertSameDomain } from './tabs.js';

const MAX_FRAMES = 50;
const ACTION_DELAYS = {
  wait: 300, screenshot: 300, navigate: 800, scroll: 800, scroll_to: 800, type: 800, key: 800, zoom: 800,
  left_click: 1500, right_click: 1500, double_click: 1500, triple_click: 1500, left_click_drag: 1500,
};
const recordings = new Map(); // groupId -> { recording, frames }

function recordingOf(groupId) {
  let r = recordings.get(groupId);
  if (!r) {
    r = { recording: false, frames: [] };
    recordings.set(groupId, r);
  }
  return r;
}

function addFrame(groupId, frame) {
  const frames = recordingOf(groupId).frames;
  frames.push(frame);
  if (frames.length > MAX_FRAMES) frames.shift();
}

const isRecording = (groupId) => !!recordings.get(groupId)?.recording;

function describeAction(args) {
  const a = args.action;
  // GIF 上的动作标签给人看，跟随浏览器语言
  const t = (key, sub) => chrome.i18n.getMessage(key, sub) || key;
  if (a.includes('click')) return t('gifClick');
  if (a === 'type' && args.text) return t('gifType', [args.text]);
  if (a === 'key' && args.text) return t('gifKey', [args.text]);
  if (a === 'scroll') return t('gifScroll');
  if (a === 'left_click_drag') return t('gifDrag');
  return a;
}

// 工具成功执行后调用；result 中的 _point / _startPoint 是该操作使用的视口 CSS 坐标
export async function recordAction(tool, args, result) {
  if ((tool !== 'computer' && tool !== 'navigate') || typeof args.tabId !== 'number') return;
  const tab = await chrome.tabs.get(args.tabId).catch(() => null);
  if (!tab) return;
  const groupId = tab.groupId ?? -1;
  if (!isRecording(groupId)) return;

  let action;
  if (tool === 'computer') {
    if (args.action === 'screenshot' || args.action === 'zoom') {
      // 截图、放大图本身就是一帧
      if (result.base64Image) {
        addFrame(groupId, {
          base64: result.base64Image,
          format: result.imageFormat,
          action: args.action === 'zoom' ? { type: 'zoom', description: chrome.i18n.getMessage('gifZoom') || 'Zoomed in' } : null,
          viewportWidth: args.action === 'screenshot' ? result._viewport?.[0] : undefined,
          viewportHeight: args.action === 'screenshot' ? result._viewport?.[1] : undefined,
        });
      }
      return;
    }
    action = {
      type: args.action,
      coordinate: result._point,
      start_coordinate: result._startPoint,
      text: args.text,
      description: describeAction(args),
    };
    // 点击/拖拽：先用操作前的画面加一帧，标出点击位置
    if (action.type.includes('click') || action.type === 'left_click_drag') {
      const prev = recordingOf(groupId).frames.at(-1);
      if (prev?.viewportWidth) addFrame(groupId, { ...prev, action });
    }
  } else {
    action = { type: 'navigate', description: chrome.i18n.getMessage('gifNavigate', [args.url]) || `Navigated to ${args.url}` };
  }

  await sleep(100);
  try {
    const s = await screenshot(args.tabId, { updateContext: false });
    addFrame(groupId, { base64: s.base64, format: s.format, action, viewportWidth: s.viewportWidth, viewportHeight: s.viewportHeight });
  } catch {
    // 页面正在跳转等情况下跳过这一帧
  }
}

export async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Encode GIF recordings of browser automation and keep the local MCP bridge connection alive.',
    });
  } catch (e) {
    if (!/single offscreen document/i.test(String(e?.message))) throw e;
  }
}

export async function closeOffscreen() {
  await chrome.offscreen.closeDocument().catch(() => {});
}

// gif_creator 工具
export async function gifCreator(args, tab, agent, startUrl) {
  const groupId = tab.groupId ?? -1;
  const rec = recordingOf(groupId);
  switch (args.action) {
    case 'start_recording':
      if (rec.recording) return { output: "Recording is already active for this tab group. Use 'stop_recording' to stop or 'export' to generate GIF." };
      rec.frames = [];
      rec.recording = true;
      return { output: `Started recording browser actions for this tab group. All computer and navigate tool actions will now be captured (max ${MAX_FRAMES} frames). Previous frames cleared.` };

    case 'stop_recording':
      if (!rec.recording) return { output: "Recording is not active for this tab group. Use 'start_recording' to begin capturing." };
      rec.recording = false;
      return { output: `Stopped recording for this tab group. Captured ${rec.frames.length} frame${rec.frames.length === 1 ? '' : 's'}. Use 'export' to generate GIF or 'clear' to discard.` };

    case 'clear': {
      const n = rec.frames.length;
      rec.frames = [];
      rec.recording = false;
      return { output: n ? `Cleared ${n} frame${n === 1 ? '' : 's'} for this tab group. Recording stopped.` : 'No frames to clear for this tab group.' };
    }

    case 'export': {
      const download = args.download === true;
      if (!download && !(Array.isArray(args.coordinate) && args.coordinate.length === 2)) {
        throw new ToolError('input_invalid', 'coordinate parameter is required for export action (or set download: true to save the GIF)');
      }
      if (!rec.frames.length) throw new ToolError('gif_no_frames', "No frames recorded for this tab group. Use 'start_recording' and perform browser actions first.");
      const point = download ? null : toViewport(tab.id, args.coordinate);
      const o = args.options || {};
      const options = {
        showClickIndicators: o.showClickIndicators ?? true,
        showDragPaths: o.showDragPaths ?? true,
        showActionLabels: o.showActionLabels ?? true,
        showProgressBar: o.showProgressBar ?? true,
        showWatermark: o.showWatermark ?? true,
        quality: o.quality ?? 10,
      };
      const frames = rec.frames.map((f) => ({ ...f, delay: f.action ? ACTION_DELAYS[f.action.type] ?? 800 : 800 }));
      await ensureOffscreen();
      const res = await chrome.runtime.sendMessage({ type: 'BB_GENERATE_GIF', frames, options });
      if (!res?.ok) throw new ToolError('gif_export_failed', `GIF generation failed: ${res?.error || 'no response from offscreen document'}`);
      const { base64, size, width, height } = res.result;
      let filename = args.filename || `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.gif`;
      if (!/\.gif$/i.test(filename)) filename += '.gif';
      const count = frames.length;

      if (download) {
        rec.frames = [];
        return {
          output: `Successfully exported GIF with ${count} frames (${Math.round(size / 1024)}KB). Dimensions: ${width}x${height}. Recording cleared.`,
          gifFile: { filename, base64 },
        };
      }
      await assertSameDomain(tab.id, startUrl, 'GIF export upload action');
      const dropped = await agent(tab.id, 'dropFiles', {
        point,
        label: args.coordinate,
        files: [{ name: filename.split(/[\\/]/).pop(), data: base64, mimeType: 'image/gif' }],
      });
      rec.frames = [];
      return { output: `Successfully exported GIF with ${count} frames. ${dropped}. Dimensions: ${width}x${height}. Recording cleared.` };
    }

    default:
      throw new ToolError('input_invalid', `Unknown action: ${args.action}. Must be one of: start_recording, stop_recording, export, clear`);
  }
}
