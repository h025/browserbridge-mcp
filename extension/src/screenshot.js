// 截图与坐标系：
// 截图按设备像素截取，再缩放到视觉模型的 token 预算以内（每 28px 一个 token，
// 长边 ≤1568px、总 token ≤1568）。每个标签页记录“坐标上下文”（视口 CSS 尺寸与截图尺寸），
// Claude 给出的坐标都按最近一次全尺寸截图换算成 CSS 像素。
import { hideIndicatorForTool, showIndicatorAfterTool } from './activity.js';
import { sendCommand, sleep, ToolError, withTimeout } from './cdp.js';

const PX_PER_TOKEN = 28;
const MAX_TARGET_PX = 1568;
const MAX_TARGET_TOKENS = 1568;
const MAX_BASE64_CHARS = 1_398_100;
const INITIAL_JPEG_QUALITY = 0.75;
const JPEG_QUALITY_STEP = 0.05;
const MIN_JPEG_QUALITY = 0.1;

const contexts = new Map(); // tabId -> { viewportWidth, viewportHeight, screenshotWidth, screenshotHeight }
const pendingContexts = new Map(); // tabId -> { context, scope }
let nextScope = 1;

const tokens = (px) => Math.floor((px - 1) / PX_PER_TOKEN) + 1;
const fits = (w, h) => w <= MAX_TARGET_PX && h <= MAX_TARGET_PX && tokens(w) * tokens(h) <= MAX_TARGET_TOKENS;

// 保持宽高比，找出满足 token 预算的最大尺寸
export function fitToTokenBudget(width, height) {
  if (fits(width, height)) return [width, height];
  if (height > width) {
    const [h, w] = fitToTokenBudget(height, width);
    return [w, h];
  }
  const ratio = width / height;
  let lo = 1;
  let hi = width;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, Math.max(1, Math.round(mid / ratio)))) lo = mid;
    else hi = mid;
  }
  return [lo, Math.max(1, Math.round(lo / ratio))];
}

// browser_batch 中的截图先暂存坐标上下文，整批结束后才生效：
// 同一批里写下的坐标都以调用前的截图为准
export function beginPendingScope() {
  return nextScope++;
}

export function commitPendingContexts(scope) {
  for (const [tabId, p] of pendingContexts) {
    if (p.scope !== scope) continue;
    contexts.set(tabId, p.context);
    pendingContexts.delete(tabId);
  }
}

export function clearPendingContexts(scope) {
  for (const [tabId, p] of pendingContexts) if (p.scope === scope) pendingContexts.delete(tabId);
}

function saveContext(tabId, context, scope) {
  if (scope) pendingContexts.set(tabId, { context, scope });
  else contexts.set(tabId, context);
}

// 截图坐标 -> 视口 CSS 像素；没有截图时按 CSS 像素原样使用
export function toViewport(tabId, [x, y]) {
  const ctx = contexts.get(tabId);
  if (!ctx) return [x, y];
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= ctx.screenshotWidth + 2 || y >= ctx.screenshotHeight + 2) {
    throw new ToolError(
      'coordinate_out_of_bounds',
      `Coordinate (${Math.round(x)}, ${Math.round(y)}) is outside the coordinate frame (${ctx.screenshotWidth}x${ctx.screenshotHeight}). ` +
        'Coordinates are pixels in the full-resolution screenshot frame, never in a scaled image\'s own pixels — if the page or window changed, take a new screenshot first.',
    );
  }
  return [Math.round((x * ctx.viewportWidth) / ctx.screenshotWidth), Math.round((y * ctx.viewportHeight) / ctx.screenshotHeight)];
}

async function probeViewport(tabId) {
  const [res] = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: () => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        hidden: document.visibilityState === 'hidden',
      }),
    }),
    5000,
    () => new ToolError('page_loading', 'Timed out reading the viewport size — the page is busy or mid-navigation. Try again in a moment.'),
  );
  if (!res?.result) throw new Error('Failed to get viewport information');
  return res.result;
}

// 后台标签页不会主动绘制，先触发一次绘制再探测视口
async function probeAndDraw(tabId) {
  let probe = await probeViewport(tabId);
  if (probe.hidden) {
    await sendCommand(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 1, fromSurface: true }, 5000).catch(() => {});
    probe = await probeViewport(tabId).catch(() => probe);
  }
  return probe;
}

async function captureRaw(tabId, params, probe) {
  try {
    return (await sendCommand(tabId, 'Page.captureScreenshot', { ...params, captureBeyondViewport: false, fromSurface: true }, 15_000)).data;
  } catch (e) {
    if (!probe.hidden && e?.code !== 'cdp_timeout') throw e;
    // 极少数情况下后台标签页仍然出不了图：切到前台再试一次
    await chrome.tabs.update(tabId, { active: true });
    await sleep(300);
    return (await sendCommand(tabId, 'Page.captureScreenshot', { ...params, captureBeyondViewport: false, fromSurface: true }, 15_000)).data;
  }
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function drawToCanvas(bitmap, [sx, sy, sw, sh], width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  return canvas;
}

// JPEG 质量从 0.75 逐步降低，直到 base64 体积不超过上限
async function encodeJpeg(canvas) {
  let quality = INITIAL_JPEG_QUALITY;
  let data = await blobToBase64(await canvas.convertToBlob({ type: 'image/jpeg', quality }));
  while (data.length > MAX_BASE64_CHARS && quality > MIN_JPEG_QUALITY) {
    quality -= JPEG_QUALITY_STEP;
    data = await blobToBase64(await canvas.convertToBlob({ type: 'image/jpeg', quality }));
  }
  return data;
}

// 截图期间隐藏页面上的 Claude 指示器
async function withIndicatorHidden(tabId, fn) {
  await hideIndicatorForTool(tabId);
  try {
    return await fn();
  } finally {
    showIndicatorAfterTool(tabId);
  }
}

// scale ∈ [0.1, 1]：返回更小的图片以节省 token，但坐标系仍是全尺寸截图。
// updateContext=false 时不更新坐标上下文（录制 GIF 帧用）
export async function screenshot(tabId, { scale = 1, pendingScope, updateContext = true } = {}) {
  return withIndicatorHidden(tabId, async () => {
    const probe = await probeAndDraw(tabId);
    const dpr = probe.dpr || 1;
    const [frameWidth, frameHeight] = fitToTokenBudget(Math.round(probe.width * dpr), Math.round(probe.height * dpr));
    const s = Number.isFinite(scale) && scale >= 0.1 && scale <= 1 ? scale : 1;
    const width = Math.max(1, Math.round(frameWidth * s));
    const height = Math.max(1, Math.round(frameHeight * s));

    const raw = await captureRaw(tabId, { format: 'jpeg', quality: Math.round(INITIAL_JPEG_QUALITY * 100) }, probe);
    const bitmap = await createImageBitmap(base64ToBlob(raw, 'image/jpeg'));
    let data;
    if (Math.abs(bitmap.width - width) <= 1 && Math.abs(bitmap.height - height) <= 1 && raw.length <= MAX_BASE64_CHARS) {
      data = raw;
    } else {
      data = await encodeJpeg(drawToCanvas(bitmap, [0, 0, bitmap.width, bitmap.height], width, height));
    }
    if (updateContext) {
      saveContext(tabId, { viewportWidth: probe.width, viewportHeight: probe.height, screenshotWidth: frameWidth, screenshotHeight: frameHeight }, pendingScope);
    }
    return { base64: data, format: 'jpeg', width, height, frameWidth, frameHeight, viewportWidth: probe.width, viewportHeight: probe.height };
  });
}

// region 为截图坐标 [x0, y0, x1, y1]，返回该区域的高清 PNG
export async function zoom(tabId, region, scale = 1) {
  const [x0, y0] = toViewport(tabId, [region[0], region[1]]);
  const [x1, y1] = toViewport(tabId, [region[2], region[3]]);
  return withIndicatorHidden(tabId, async () => {
    const probe = await probeAndDraw(tabId);
    if (x1 > probe.width || y1 > probe.height) {
      throw new ToolError('coordinate_out_of_bounds', `Region exceeds viewport boundaries (${probe.width}x${probe.height}). Please choose a region within the visible viewport.`);
    }
    const dpr = probe.dpr || 1;
    const regionW = Math.max(1, Math.round((x1 - x0) * dpr));
    const regionH = Math.max(1, Math.round((y1 - y0) * dpr));
    const s = Number.isFinite(scale) && scale >= 0.1 && scale <= 1 ? scale : 1;
    const [fw, fh] = fitToTokenBudget(regionW, regionH);
    const width = Math.max(1, Math.round(fw * s));
    const height = Math.max(1, Math.round(fh * s));

    const raw = await captureRaw(tabId, { format: 'png' }, probe);
    const bitmap = await createImageBitmap(base64ToBlob(raw, 'image/png'));
    const k = bitmap.width / probe.width;
    const canvas = drawToCanvas(bitmap, [x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k], width, height);
    const data = await blobToBase64(await canvas.convertToBlob({ type: 'image/png' }));
    return { base64: data, format: 'png', width, height };
  });
}

// 截图字节缓存：upload_image 按截图 ID 取图。保留 5 分钟、总量 8MB，
// 同时写入 session storage，Service Worker 重启后仍可取回
const IMAGE_TTL_MS = 5 * 60_000;
const IMAGE_BUDGET_CHARS = 8 * 1024 * 1024;
const IMAGE_KEY_PREFIX = 'bbImage:';
const imageCache = new Map(); // id -> { data, mimeType, storedAt }
let imageCacheChars = 0;

function dropImage(id) {
  const entry = imageCache.get(id);
  if (entry) {
    imageCacheChars -= entry.data.length;
    imageCache.delete(id);
  }
  chrome.storage.session.remove(IMAGE_KEY_PREFIX + id).catch(() => {});
}

export function storeImage(data, mimeType) {
  const id = `ss_${Date.now().toString().slice(-4)}${Math.random().toString(36).slice(2, 7)}`;
  if (data.length > IMAGE_BUDGET_CHARS) return id;
  const entry = { data, mimeType, storedAt: Date.now() };
  imageCache.set(id, entry);
  imageCacheChars += data.length;
  for (const old of imageCache.keys()) {
    if (imageCacheChars <= IMAGE_BUDGET_CHARS) break;
    dropImage(old);
  }
  if (imageCache.has(id)) chrome.storage.session.set({ [IMAGE_KEY_PREFIX + id]: entry }).catch(() => {});
  return id;
}

// Service Worker 启动时调用：清理已关闭标签页的坐标上下文，删除 session storage 里过期的截图
export function initScreenshotState() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    contexts.delete(tabId);
    pendingContexts.delete(tabId);
  });
  chrome.storage.session.get(null).then((all) => {
    const expired = Object.entries(all)
      .filter(([k, v]) => k.startsWith(IMAGE_KEY_PREFIX) && !(Date.now() - (v?.storedAt ?? 0) <= IMAGE_TTL_MS))
      .map(([k]) => k);
    if (expired.length) chrome.storage.session.remove(expired);
  }).catch(() => {});
}

export async function loadImage(id) {
  let entry = imageCache.get(id);
  if (!entry) {
    const stored = (await chrome.storage.session.get(IMAGE_KEY_PREFIX + id).catch(() => ({})))[IMAGE_KEY_PREFIX + id];
    if (stored?.data) entry = stored;
  }
  if (!entry) return null;
  if (Date.now() - entry.storedAt > IMAGE_TTL_MS) {
    dropImage(id);
    return null;
  }
  return { data: entry.data, mimeType: entry.mimeType };
}
