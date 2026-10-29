// 页面上的活动指示器：沿屏幕四周缓慢旋转、带呼吸节奏的彩色光晕（外层宽光晕 + 贴边亮色光带），以及渐变光标。
// 全部放在 closed shadow root 里，不影响页面样式，也不会出现在可访问性树中。
(() => {
  if (window.__bbIndicator) return;
  window.__bbIndicator = true;

  let host = null;
  let root = null;
  let layer = null; // 所有指示器元素的容器，截图时整体隐藏
  let border = null;
  let cursor = null;
  let active = false;
  let hiddenForTool = false;
  let restoreTimer = null;
  let heartbeat = null;

  // 显示期间每 5 秒确认一次：扩展后台重启或已释放该标签页时自行隐藏；被页面移除时重新挂上
  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(async () => {
      if (!active) return;
      if (host && !host.isConnected) ensureRoot();
      try {
        const res = await chrome.runtime.sendMessage({ type: 'BB_INDICATOR_HEARTBEAT' });
        if (!res?.active) hide();
      } catch {
        hide();
      }
    }, 5000);
  }

  function ensureRoot() {
    if (!host) {
      host = document.createElement('div');
      host.setAttribute('data-bb-indicator', '');
      root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        :host { all: initial !important; display: contents !important; }
        @keyframes bb-spin { to { transform: translate(-50%, -50%) rotate(360deg); } }
        /* 呼吸：放大时光环往屏幕外推、变窄变淡，回到原大小时变宽变亮 */
        @keyframes bb-breathe-aura { 0%, 100% { opacity: .6; transform: scale(1.06); } 50% { opacity: 1; transform: scale(1); } }
        @keyframes bb-breathe-edge { 0%, 100% { opacity: .75; } 50% { opacity: 1; } }
        .border { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; opacity: 0; transition: opacity .4s ease-in-out; }
        /* 外层光晕：比屏幕大一圈的彩色光环整体模糊，一半在屏幕外，屏幕内是柔和、圆角的宽光晕 */
        .aura { position: absolute; inset: -48px; filter: blur(26px); animation: bb-breathe-aura 3.2s ease-in-out infinite; }
        .aura .ring { --t: 100px; }
        /* 贴边亮色光带：细光环轻微模糊，勾出清楚的边缘 */
        .edge { position: absolute; inset: 0; filter: blur(2px); animation: bb-breathe-edge 3.2s ease-in-out infinite; }
        .edge .ring { --t: 5px; }
        /* 光环：只保留四周宽 --t 的一圈，里面是旋转的彩色圆盘（比对角线还大，转起来四边始终被覆盖） */
        .ring { position: absolute; inset: 0; padding: var(--t); overflow: hidden;
          -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
        .ring::before { content: ""; position: absolute; top: 50%; left: 50%; width: 170vmax; height: 170vmax;
          transform: translate(-50%, -50%); animation: bb-spin 10s linear infinite;
          background: conic-gradient(#3B82F6, #8B5CF6, #EC4899, #F59E0B, #22D3EE, #3B82F6); }
        @media (prefers-reduced-motion: reduce) { .aura, .edge, .ring::before { animation: none; } }
        .cursor { position: fixed; top: 0; left: 0; pointer-events: none; z-index: 2147483646; will-change: transform;
          transition: transform 180ms cubic-bezier(.2, 0, 0, 1); filter: drop-shadow(0 1px 3px rgba(139,92,246,.8)); }
      `;
      root.appendChild(style);
      layer = document.createElement('div');
      root.appendChild(layer);
    }
    const parent = document.body || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
    return layer;
  }

  function buildCursor(x, y) {
    const wrap = document.createElement('div');
    wrap.className = 'cursor';
    wrap.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    wrap.innerHTML = `<svg width="20" height="26" viewBox="0 0 20 26" style="overflow:visible">
      <defs><linearGradient id="bb-cursor-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#3B82F6"/><stop offset=".5" stop-color="#8B5CF6"/><stop offset="1" stop-color="#EC4899"/>
      </linearGradient></defs>
      <path d="M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z" fill="url(#bb-cursor-grad)" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    return wrap;
  }

  function show() {
    active = true;
    startHeartbeat();
    const r = ensureRoot();
    if (!border) {
      border = document.createElement('div');
      border.className = 'border';
      border.innerHTML = '<div class="aura"><div class="ring"></div></div><div class="edge"><div class="ring"></div></div>';
      r.appendChild(border);
    }
    if (!cursor) {
      cursor = buildCursor(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
      r.appendChild(cursor);
    }
    applyVisibility();
    requestAnimationFrame(() => {
      if (!active) return;
      border.style.opacity = '1';
    });
  }

  function hide() {
    active = false;
    hiddenForTool = false;
    clearTimeout(restoreTimer);
    clearInterval(heartbeat);
    heartbeat = null;
    if (border) border.style.opacity = '0';
    setTimeout(() => {
      if (active) return;
      for (const el of [border, cursor]) el?.remove();
      border = cursor = null;
    }, 300);
  }

  // 截图时整体隐藏；点击时只隐藏边框，保留光标
  function applyVisibility(hideAll = false) {
    if (layer) layer.style.display = hiddenForTool && hideAll ? 'none' : '';
    if (border) border.style.display = hiddenForTool ? 'none' : '';
  }

  function moveCursor(x, y) {
    if (!active) return Promise.resolve();
    if (!cursor) {
      cursor = buildCursor(x, y);
      ensureRoot().appendChild(cursor);
      return Promise.resolve();
    }
    cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    return new Promise((resolve) => {
      const done = () => resolve();
      cursor.addEventListener('transitionend', done, { once: true });
      setTimeout(done, 220);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'BB_SHOW':
        show();
        sendResponse({ ok: true });
        return;
      case 'BB_HIDE':
        hide();
        sendResponse({ ok: true });
        return;
      case 'BB_HIDE_FOR_TOOL':
        hiddenForTool = true;
        applyVisibility(msg.cursor !== false);
        // 兜底：5 秒后自动恢复，避免因消息丢失而一直隐藏
        clearTimeout(restoreTimer);
        restoreTimer = setTimeout(() => {
          hiddenForTool = false;
          applyVisibility();
        }, 5000);
        sendResponse({ ok: true });
        return;
      case 'BB_SHOW_AFTER_TOOL':
        hiddenForTool = false;
        clearTimeout(restoreTimer);
        applyVisibility();
        sendResponse({ ok: true });
        return;
      case 'BB_CURSOR':
        moveCursor(msg.x, msg.y).then(() => sendResponse({ ok: true }));
        return true;
    }
  });
})();
