// 页面上的活动指示器：沿屏幕四周旋转、带呼吸节奏的多层彩色光晕（各层宽度、速度、方向不同），以及渐变光标。
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

  // 光晕各层和光标共用一个呼吸节奏：周期相同，并且都按同一个时钟对齐相位（后出现的元素从当前进度接着呼吸）
  const BREATH_MS = 3200;
  const breathPhase = () => `${-(Date.now() % BREATH_MS) / 1000}s`;

  // 光标：通透的蓝紫水晶（鼓鼓的光影、彩虹细边、圆润的尖端），由光标调整工具按最终参数生成；
  // 实际大小 27px，圆角尖端的顶点（距左上角 3.07px）对准光标位置，呼吸时以尖端为中心放大缩小
  const CURSOR_TIP = 3.07;
  const CURSOR_SVG = `<svg width="26.6" height="26.6" viewBox="0 0 24.6 24.6" style="overflow:visible;margin-left:-${CURSOR_TIP}px;margin-top:-${CURSOR_TIP}px;transform-origin:${CURSOR_TIP}px ${CURSOR_TIP}px">` +
    '<defs><clipPath id="bbcc"><path d="M5.10 3.07 L19.83 9.24 Q22.60 10.40 19.76 11.37 L16.74 12.42 Q13.52 13.52 12.42 16.74 L11.37 19.76 Q10.40 22.60 9.24 19.83 L3.07 5.10 Q1.60 1.60 5.10 3.07 Z"/></clipPath><filter id="bbcs" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation=".8"/></filter><filter id="bbcS" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="1.7"/></filter><filter id="bbch" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation=".5"/></filter><radialGradient id="bbcb" cx=".34" cy=".3" r=".8"><stop offset="0" stop-color="#F0F9FF" stop-opacity="0.576"/><stop offset=".3" stop-color="#7DD3FC" stop-opacity="0.44639999999999996"/><stop offset=".7" stop-color="#818CF8" stop-opacity="0.3744"/><stop offset="1" stop-color="#9333EA" stop-opacity="0.48960000000000004"/></radialGradient><radialGradient id="bbcpearl" cx=".7" cy=".7" r=".6"><stop offset="0" stop-color="#F9A8D4" stop-opacity=".6"/><stop offset=".5" stop-color="#A5F3FC" stop-opacity=".4"/><stop offset="1" stop-color="#C4B5FD" stop-opacity="0"/></radialGradient><linearGradient id="bbci" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#60A5FA" stop-opacity="1"/><stop offset="0.5" stop-color="#A78BFA" stop-opacity="1"/><stop offset="1" stop-color="#F472B6" stop-opacity="1"/></linearGradient><linearGradient id="bbcbev" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.81"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.108"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><linearGradient id="bbccandy" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.75"/><stop offset="1" stop-color="#fff" stop-opacity="0.06"/></linearGradient><linearGradient id="bbcflow" x1="0" y1="0" x2="1" y2="0.4"><stop offset="0" stop-color="#22D3EE" stop-opacity="0"/><stop offset="0.35" stop-color="#22D3EE" stop-opacity="0.55"/><stop offset="0.55" stop-color="#A78BFA" stop-opacity="0.6"/><stop offset="0.75" stop-color="#F472B6" stop-opacity="0.55"/><stop offset="1" stop-color="#F472B6" stop-opacity="0"/></linearGradient></defs><path d="M5.10 3.07 L19.83 9.24 Q22.60 10.40 19.76 11.37 L16.74 12.42 Q13.52 13.52 12.42 16.74 L11.37 19.76 Q10.40 22.60 9.24 19.83 L3.07 5.10 Q1.60 1.60 5.10 3.07 Z" fill="#9333EA" opacity="0.28" transform="translate(1.2 2.2)" filter="url(#bbcS)"/><path d="M5.10 3.07 L19.83 9.24 Q22.60 10.40 19.76 11.37 L16.74 12.42 Q13.52 13.52 12.42 16.74 L11.37 19.76 Q10.40 22.60 9.24 19.83 L3.07 5.10 Q1.60 1.60 5.10 3.07 Z" fill="url(#bbcb)"/><g clip-path="url(#bbcc)"><path d="M5.10 3.07 L19.83 9.24 Q22.60 10.40 19.76 11.37 L16.74 12.42 Q13.52 13.52 12.42 16.74 L11.37 19.76 Q10.40 22.60 9.24 19.83 L3.07 5.10 Q1.60 1.60 5.10 3.07 Z" fill="none" stroke="#9333EA" stroke-opacity="0.5" stroke-width="3" transform="translate(-.9 -1.1)" filter="url(#bbcs)"/><path d="M5.10 3.07 L19.83 9.24 Q22.60 10.40 19.76 11.37 L16.74 12.42 Q13.52 13.52 12.42 16.74 L11.37 19.76 Q10.40 22.60 9.24 19.83 L3.07 5.10 Q1.60 1.60 5.10 3.07 Z" fill="none" stroke="#fff" stroke-opacity="0.7" stroke-width="2.2" transform="translate(.8 1)" filter="url(#bbcs)"/><path d="M5.10 3.07 L19.83 9.24 Q22.60 10.40 19.76 11.37 L16.74 12.42 Q13.52 13.52 12.42 16.74 L11.37 19.76 Q10.40 22.60 9.24 19.83 L3.07 5.10 Q1.60 1.60 5.10 3.07 Z" fill="none" stroke="url(#bbcbev)" stroke-width="1.80"/><ellipse cx="12.8" cy="17.8" rx="1.2" ry="3" transform="rotate(20 12.8 17.8)" fill="#fff" opacity="0.35" filter="url(#bbch)"/><ellipse cx="9" cy="6.8" rx="4.6" ry="1.9" transform="rotate(24 9 6.8)" fill="#fff" opacity="0.55" filter="url(#bbch)"/></g><path d="M5.10 3.07 L19.83 9.24 Q22.60 10.40 19.76 11.37 L16.74 12.42 Q13.52 13.52 12.42 16.74 L11.37 19.76 Q10.40 22.60 9.24 19.83 L3.07 5.10 Q1.60 1.60 5.10 3.07 Z" fill="none" stroke="url(#bbci)" stroke-width="0.9" stroke-opacity=".9"/><path d="M5.10 3.07 L19.83 9.24 Q22.60 10.40 19.76 11.37 L16.74 12.42 Q13.52 13.52 12.42 16.74 L11.37 19.76 Q10.40 22.60 9.24 19.83 L3.07 5.10 Q1.60 1.60 5.10 3.07 Z" fill="none" stroke="#fff" stroke-width="0.45" stroke-opacity=".95"/><ellipse cx="6.83" cy="7.33" rx=".95" ry="2.1" transform="rotate(-26 6.83 7.33)" fill="#fff" opacity="0.95"/></svg>';

  // 页面四周的光晕（光标调整工具里定下的参数），从外到内：淡淡的彩虹光雾 → 暖色光雾 → 贴边的冷色光；
  // 越靠边越窄、越清晰、转得越快，方向交替，看起来像光从屏幕边缘发出来
  const HALO_LAYERS = [
    { w: 60, blur: 24, op: 0.42, dur: 10, dir: 'normal',
      bg: 'conic-gradient(#3B82F6, #8B5CF6 18%, rgba(139,92,246,.6) 30%, #EC4899 44%, #F59E0B 58%, rgba(245,158,11,.6) 70%, #22D3EE 84%, #3B82F6)' },
    { w: 36, blur: 12, op: 0.5, dur: 7, dir: 'reverse',
      bg: 'conic-gradient(#F472B6, #FB923C 22%, rgba(251,146,60,.55) 38%, #FACC15 52%, #F472B6 72%, rgba(244,114,182,.55) 86%, #F472B6)' },
    { w: 20, blur: 6, op: 0.65, dur: 4.5, dir: 'normal',
      bg: 'conic-gradient(#22D3EE, #3B82F6 24%, rgba(59,130,246,.55) 40%, #8B5CF6 56%, #22D3EE 80%, rgba(34,211,238,.55) 90%, #22D3EE)' },
  ];

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
        /* 多层光晕：每层是一圈旋转的彩色光环，宽度、模糊、速度、方向各不相同，颜色互相交错流动。
           呼吸：放大时光环往屏幕外推、变窄变淡，回到原大小时变宽变亮；放大比例由 sizeLayers() 按像素算好（--bx/--by），
           每层只往外推自身宽度的四分之一，窄的贴边光不会被推出屏幕 */
        @keyframes bb-breathe-layer { 0%, 100% { opacity: calc(var(--op) * .75); transform: scale(var(--bx, 1), var(--by, 1)); } 50% { opacity: var(--op); transform: scale(1); } }
        .border { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; opacity: 0; transition: opacity .4s ease-in-out; }
        /* 光环一半在屏幕外，屏幕内是柔和、圆角的光晕 */
        .layer { position: absolute; inset: calc(var(--w) * -.5); filter: blur(var(--blur)); animation: bb-breathe-layer ${BREATH_MS}ms ease-in-out infinite; }
        /* 只保留四周宽 --w 的一圈，里面是旋转的彩色圆盘（比对角线还大，转起来四边始终被覆盖） */
        .ring { position: absolute; inset: 0; padding: var(--w); overflow: hidden;
          -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
        .ring::before { content: ""; position: absolute; top: 50%; left: 50%; width: 170vmax; height: 170vmax;
          transform: translate(-50%, -50%); animation: bb-spin var(--dur) linear infinite; animation-direction: var(--dir); background: var(--bg); }
        @media (prefers-reduced-motion: reduce) { .layer, .ring::before, .cursor svg { animation: none; } }
        .cursor { position: fixed; top: 0; left: 0; pointer-events: none; z-index: 2147483646; will-change: transform;
          transition: transform 180ms cubic-bezier(.2, 0, 0, 1); }
        /* 光标随光晕的呼吸节奏轻轻放大缩小（以尖端为中心，不影响指向的位置） */
        @keyframes bb-cursor-bob { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
        .cursor svg { display: block; animation: bb-cursor-bob ${BREATH_MS}ms ease-in-out infinite; }
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
    wrap.innerHTML = CURSOR_SVG;
    wrap.firstElementChild.style.animationDelay = breathPhase();
    return wrap;
  }

  // 呼吸时每层往外推固定的像素（自身宽度的四分之一），换算成横向、纵向各自的放大比例
  function sizeLayers() {
    for (const el of border?.querySelectorAll('.layer') || []) {
      const w = Number(el.dataset.w); const push = w / 4;
      el.style.setProperty('--bx', String(1 + (2 * push) / (innerWidth + w)));
      el.style.setProperty('--by', String(1 + (2 * push) / (innerHeight + w)));
    }
  }
  addEventListener('resize', () => { if (active) sizeLayers(); });

  function show() {
    active = true;
    startHeartbeat();
    const r = ensureRoot();
    if (!border) {
      border = document.createElement('div');
      border.className = 'border';
      const delay = breathPhase();
      border.innerHTML = HALO_LAYERS.map((l) =>
        `<div class="layer" data-w="${l.w}" style="--w:${l.w}px;--blur:${l.blur}px;--op:${l.op};--dur:${l.dur}s;--dir:${l.dir};--bg:${l.bg};animation-delay:${delay}"><div class="ring"></div></div>`).join('');
      sizeLayers();
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
  // 用 visibility 而不是 display：display: none 会让光晕和光标的动画从头开始，每次点击、截图后边缘都会跳一下
  function applyVisibility(hideAll = false) {
    if (layer) layer.style.visibility = hiddenForTool && hideAll ? 'hidden' : '';
    if (border) border.style.visibility = hiddenForTool ? 'hidden' : '';
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
