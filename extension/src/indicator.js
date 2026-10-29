// 页面上的活动指示器：彩色渐变边框与光晕、渐变光标、底部“停止”按钮（文字跟随浏览器语言）。
// 全部放在 closed shadow root 里，不影响页面样式，也不会出现在可访问性树中。
(() => {
  if (window.__bbIndicator) return;
  window.__bbIndicator = true;

  let host = null;
  let root = null;
  let layer = null; // 所有指示器元素的容器，截图时整体隐藏
  let border = null;
  let stopBar = null;
  let cursor = null;
  let active = false;
  let hiddenForTool = false;
  let restoreTimer = null;
  let heartbeat = null;
  const t = (key) => chrome.i18n.getMessage(key) || key;

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
        @keyframes bb-breathe { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
        .border { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; opacity: 0; transition: opacity .3s ease-in-out; }
        .glow { position: absolute; inset: 0; animation: bb-breathe 2.4s ease-in-out infinite;
          box-shadow: inset 7px 0 22px -6px rgba(59,130,246,.75), inset 0 7px 22px -6px rgba(139,92,246,.75),
            inset -7px 0 22px -6px rgba(236,72,153,.75), inset 0 -7px 22px -6px rgba(245,158,11,.7); }
        .ring { position: absolute; inset: 0; padding: 3px; overflow: hidden;
          -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
        .ring::before { content: ""; position: absolute; top: 50%; left: 50%; width: 150vmax; height: 150vmax;
          transform: translate(-50%, -50%); animation: bb-spin 6s linear infinite;
          background: conic-gradient(#3B82F6, #8B5CF6, #EC4899, #F59E0B, #10B981, #3B82F6); }
        @media (prefers-reduced-motion: reduce) { .glow, .ring::before { animation: none; } }
        .cursor { position: fixed; top: 0; left: 0; pointer-events: none; z-index: 2147483646; will-change: transform;
          transition: transform 180ms cubic-bezier(.2, 0, 0, 1); filter: drop-shadow(0 1px 3px rgba(139,92,246,.8)); }
        .stop-bar { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 2147483647; pointer-events: none; }
        .stop { pointer-events: auto; display: inline-flex; align-items: center; gap: 9px; padding: 9px 18px 9px 14px; border-radius: 999px;
          color: #F9FAFB; border: 1.5px solid transparent; cursor: pointer; user-select: none;
          background: linear-gradient(#111827, #111827) padding-box, linear-gradient(90deg, #3B82F6, #8B5CF6, #EC4899, #F59E0B) border-box;
          font: 600 13.5px -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; letter-spacing: .01em;
          box-shadow: 0 10px 30px rgba(139,92,246,.35), 0 2px 8px rgba(17,24,39,.35);
          transform: translateY(100px); opacity: 0; transition: all .3s cubic-bezier(.4, 0, .2, 1); }
        .stop:hover { background: linear-gradient(#1F2937, #1F2937) padding-box, linear-gradient(90deg, #3B82F6, #8B5CF6, #EC4899, #F59E0B) border-box; }
        .stop .dot { width: 10px; height: 10px; border-radius: 3px; background: linear-gradient(135deg, #3B82F6, #EC4899); }
        .toast { position: fixed; bottom: 72px; left: 50%; transform: translateX(-50%); z-index: 2147483647; pointer-events: none;
          padding: 8px 14px; border-radius: 999px; background: #111827; color: #F9FAFB; box-shadow: 0 6px 20px rgba(139,92,246,.3);
          font: 500 13px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; transition: opacity .2s; }
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

  function buildStopBar() {
    const bar = document.createElement('div');
    bar.className = 'stop-bar';
    const btn = document.createElement('button');
    btn.className = 'stop';
    btn.innerHTML = '<span class="dot"></span><span></span>';
    btn.lastChild.textContent = t('stopButton');
    btn.addEventListener('click', async (e) => {
      // Claude 自己的点击也是可信事件，但点击期间按钮已隐藏，这里只会是用户点击
      if (!e.isTrusted) return;
      try {
        await chrome.runtime.sendMessage({ type: 'BB_STOP' });
        toast(t('stopSent'));
      } catch {
        toast(t('stopFailed'));
      }
    });
    bar.appendChild(btn);
    return bar;
  }

  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    ensureRoot().appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }, 2500);
  }

  function show() {
    active = true;
    startHeartbeat();
    const r = ensureRoot();
    if (!border) {
      border = document.createElement('div');
      border.className = 'border';
      border.innerHTML = '<div class="glow"></div><div class="ring"></div>';
      r.appendChild(border);
    }
    if (!stopBar) {
      stopBar = buildStopBar();
      r.appendChild(stopBar);
    }
    if (!cursor) {
      cursor = buildCursor(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
      r.appendChild(cursor);
    }
    applyVisibility();
    requestAnimationFrame(() => {
      if (!active) return;
      border.style.opacity = '1';
      const btn = stopBar.querySelector('.stop');
      btn.style.transform = 'translateY(0)';
      btn.style.opacity = '1';
    });
  }

  function hide() {
    active = false;
    hiddenForTool = false;
    clearTimeout(restoreTimer);
    clearInterval(heartbeat);
    heartbeat = null;
    if (border) border.style.opacity = '0';
    const btn = stopBar?.querySelector('.stop');
    if (btn) {
      btn.style.transform = 'translateY(100px)';
      btn.style.opacity = '0';
    }
    setTimeout(() => {
      if (active) return;
      for (const el of [border, stopBar, cursor]) el?.remove();
      border = stopBar = cursor = null;
    }, 300);
  }

  // 截图时整体隐藏（包括提示气泡）；点击时只隐藏边框和停止按钮，保留光标
  function applyVisibility(hideAll = false) {
    if (layer) layer.style.display = hiddenForTool && hideAll ? 'none' : '';
    const display = hiddenForTool ? 'none' : '';
    if (border) border.style.display = display;
    if (stopBar) stopBar.style.display = display;
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
