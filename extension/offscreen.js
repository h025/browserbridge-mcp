// 离屏文档：
// 1. 每 20 秒给 Service Worker 发一条消息，防止后台被节流/冻结导致与 MCP 服务的连接中断
// 2. 合成 GIF：在截图帧上叠加点击标记、拖拽路径、动作标签、进度条和水印，再用 gifenc 编码
import { applyPalette, GIFEncoder, quantize } from './vendor/gifenc.js';

setInterval(() => {
  chrome.runtime.sendMessage({ type: 'BB_KEEPALIVE' }).catch(() => {});
}, 20_000);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'BB_GENERATE_GIF') return;
  generateGif(msg.frames, msg.options || {}).then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
});

// 与扩展图标一致的彩色渐变
const STOPS = [[0, '#3B82F6'], [0.35, '#8B5CF6'], [0.7, '#EC4899'], [1, '#F59E0B']];
const VIOLET = '#8B5CF6';
const PINK = '#EC4899';

function gradient(ctx, x0, y0, x1, y1, stops = STOPS) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [t, c] of stops) g.addColorStop(t, c);
  return g;
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawClickIndicator(ctx, x, y, s) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 15 * s, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(139, 92, 246, 0.25)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 11 * s, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(236, 72, 153, 0.35)';
  ctx.fill();
  ctx.strokeStyle = gradient(ctx, x - 11 * s, y - 11 * s, x + 11 * s, y + 11 * s);
  ctx.lineWidth = 2 * s;
  ctx.stroke();
  ctx.restore();
}

function drawDragPath(ctx, x0, y0, x1, y1, s) {
  ctx.save();
  ctx.strokeStyle = gradient(ctx, x0, y0, x1, y1, [[0, VIOLET], [1, PINK]]);
  ctx.fillStyle = PINK;
  ctx.lineWidth = 3 * s;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const len = 15 * s;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - len * Math.cos(angle - Math.PI / 6), y1 - len * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x1 - len * Math.cos(angle + Math.PI / 6), y1 - len * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  for (const [x, y, color] of [[x0, y0, VIOLET], [x1, y1, PINK]]) {
    ctx.beginPath();
    ctx.arc(x, y, 6 * s, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * s;
    ctx.stroke();
  }
  ctx.restore();
}

function drawLabel(ctx, text, x, y, s) {
  ctx.save();
  ctx.font = `${14 * s}px system-ui, -apple-system, "PingFang SC", sans-serif`;
  ctx.textBaseline = 'top';
  const padding = 8 * s;
  const w = ctx.measureText(text).width + padding * 2;
  const h = 20 * s + padding;
  let lx = x + 20 * s;
  let ly = y - 10 * s;
  if (lx + w > ctx.canvas.width) lx = x - w - 20 * s;
  if (lx < 0) lx = 4 * s;
  if (ly < 0) ly = y + 20 * s;
  roundedRect(ctx, lx, ly, w, h, h / 2);
  ctx.shadowColor = 'rgba(139, 92, 246, 0.35)';
  ctx.shadowBlur = 6 * s;
  ctx.shadowOffsetY = 2 * s;
  ctx.fillStyle = 'rgba(17, 24, 39, 0.9)';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.5 * s;
  ctx.strokeStyle = gradient(ctx, lx, ly, lx + w, ly);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, lx + padding, ly + padding);
  ctx.restore();
}

function drawProgressBar(ctx, progress, s) {
  const h = 4 * s;
  const y = ctx.canvas.height - h;
  ctx.fillStyle = 'rgba(17, 24, 39, 0.25)';
  ctx.fillRect(0, y, ctx.canvas.width, h);
  ctx.fillStyle = gradient(ctx, 0, 0, ctx.canvas.width, 0);
  ctx.fillRect(0, y, ctx.canvas.width * progress, h);
}

// 水印：扩展图标（彩色渐变圆角方块 + 白色指针）
const POINTER = [[0.30, 0.22], [0.30, 0.78], [0.44, 0.65], [0.54, 0.84], [0.63, 0.80], [0.53, 0.61], [0.72, 0.61]];
function drawWatermark(ctx, s) {
  const size = 32 * s;
  const x = ctx.canvas.width - 8 * s - size;
  const y = ctx.canvas.height - 8 * s - size - 4 * s;
  ctx.save();
  roundedRect(ctx, x, y, size, size, size * 0.22);
  ctx.fillStyle = gradient(ctx, x, y, x + size, y + size);
  ctx.fill();
  ctx.beginPath();
  POINTER.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * size, y + py * size) : ctx.moveTo(x + px * size, y + py * size)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
  ctx.fill();
  ctx.restore();
}

function applyActionOverlays(ctx, action, options, s) {
  if (!action) return;
  const scaled = (p) => (p ? [p[0] * s, p[1] * s] : null);
  const point = scaled(action.coordinate);
  if (options.showClickIndicators && point && (action.type.includes('click') || action.type === 'scroll')) {
    drawClickIndicator(ctx, point[0], point[1], s);
    if (options.showActionLabels && action.description) drawLabel(ctx, action.description, point[0], point[1], s);
  }
  const start = scaled(action.start_coordinate);
  if (options.showDragPaths && action.type === 'left_click_drag' && start && point) {
    drawDragPath(ctx, start[0], start[1], point[0], point[1], s);
    if (options.showActionLabels && action.description) drawLabel(ctx, action.description, point[0], point[1], s);
  }
  if (options.showActionLabels && action.description && !point && ['type', 'key', 'wait', 'navigate', 'zoom', 'scroll_to'].includes(action.type)) {
    drawLabel(ctx, action.description, 20 * s, 20 * s, s);
  }
}

async function decode(frame) {
  const bin = atob(frame.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return createImageBitmap(new Blob([bytes], { type: `image/${frame.format || 'jpeg'}` }));
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function generateGif(frames, options) {
  if (!frames?.length) throw new Error('No frames to encode');
  const bitmaps = await Promise.all(frames.map(decode));
  // GIF 的所有帧共用一个画布尺寸：较小的帧（如放大图）在右/下方补白
  const width = Math.max(...bitmaps.map((b) => b.width));
  const height = Math.max(...bitmaps.map((b) => b.height));
  const format = (options.quality ?? 10) <= 10 ? 'rgb565' : 'rgb444';
  const gif = GIFEncoder();
  const padded = new OffscreenCanvas(width, height);
  const pctx = padded.getContext('2d', { willReadFrequently: true });

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const bitmap = bitmaps[i];
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    // 动作坐标是视口 CSS 像素，按截图与视口的比例换算
    const s = frame.viewportWidth ? bitmap.width / frame.viewportWidth : 1;
    applyActionOverlays(ctx, frame.action, options, s);
    if (options.showProgressBar) drawProgressBar(ctx, (i + 1) / frames.length, s);
    if (options.showWatermark) drawWatermark(ctx, s);

    pctx.fillStyle = '#ffffff';
    pctx.fillRect(0, 0, width, height);
    pctx.drawImage(canvas, 0, 0);
    const { data } = pctx.getImageData(0, 0, width, height);
    const palette = quantize(data, 256, { format });
    const index = applyPalette(data, palette, format);
    // 最后一帧多停留 2 秒
    const delay = (frame.delay || 800) + (i === frames.length - 1 ? 2000 : 0);
    gif.writeFrame(index, width, height, { palette, delay, ...(i === 0 && { repeat: 0 }) });
    await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  const bytes = gif.bytes();
  return { base64: toBase64(bytes), size: bytes.length, width, height };
}
