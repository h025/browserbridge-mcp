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
        /* 贴边光带：两道亮色光束沿四边追逐，转得比外层快，一眼能看出在绕圈 */
        .edge { position: absolute; inset: 0; filter: blur(2px); animation: bb-breathe-edge 3.2s ease-in-out infinite; }
        .edge .ring { --t: 6px; }
        .edge .ring::before { animation-duration: 3.5s;
          background: conic-gradient(transparent 0deg, #3B82F6 50deg, #A78BFA 95deg, transparent 140deg, transparent 180deg,
            #EC4899 230deg, #FBBF24 275deg, transparent 320deg); }
        /* 光环：只保留四周宽 --t 的一圈，里面是旋转的彩色圆盘（比对角线还大，转起来四边始终被覆盖） */
        .ring { position: absolute; inset: 0; padding: var(--t); overflow: hidden;
          -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
        /* 外层的颜色有明有暗，亮色块沿四周移动，旋转更容易看出来 */
        .ring::before { content: ""; position: absolute; top: 50%; left: 50%; width: 170vmax; height: 170vmax;
          transform: translate(-50%, -50%); animation: bb-spin 6s linear infinite;
          background: conic-gradient(#3B82F6, #8B5CF6 18%, rgba(139,92,246,.35) 30%, #EC4899 44%, #F59E0B 58%,
            rgba(245,158,11,.35) 70%, #22D3EE 84%, #3B82F6); }
        @media (prefers-reduced-motion: reduce) { .aura, .edge, .ring::before, .cursor svg { animation: none; } }
        .cursor { position: fixed; top: 0; left: 0; pointer-events: none; z-index: 2147483646; will-change: transform;
          transition: transform 180ms cubic-bezier(.2, 0, 0, 1); filter: drop-shadow(0 2px 4px rgba(139,92,246,.45)); }
        /* 光标随光晕的呼吸节奏轻轻放大缩小（以尖端为中心，不影响指向的位置） */
        @keyframes bb-cursor-bob { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
        .cursor svg { transform-origin: 0 0; animation: bb-cursor-bob 3.2s ease-in-out infinite; }
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
    // 圆润的箭头（尖端、底角、右角都是圆的）+ 柔和渐变 + 白色粗描边 + 尖端附近一点高光；尖端对准 (0, 0)
    wrap.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" style="overflow:visible">
      <defs><linearGradient id="bb-cursor-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#60A5FA"/><stop offset=".5" stop-color="#A78BFA"/><stop offset="1" stop-color="#F472B6"/>
      </linearGradient></defs>
      <g transform="translate(-1.6 -2.4)">
        <path d="M3.1 2.6C2 2.1.9 3.1 1.3 4.2l6.4 18c.4 1.2 2.1 1.2 2.6.1l2.6-6.3c.2-.5.6-.9 1.1-1.1l6.3-2.6c1.1-.5 1.1-2.2-.1-2.6Z"
          fill="url(#bb-cursor-grad)" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/>
        <ellipse cx="5.6" cy="7.6" rx="1.4" ry="2.4" transform="rotate(-24 5.6 7.6)" fill="#fff" opacity=".55"/>
      </g></svg>`;
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
