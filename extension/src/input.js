// 通过 CDP 派发真实的鼠标/键盘事件（isTrusted = true）
import { ensureAttached, sendCommand, sendCommandFast, sleep, ToolError, withTimeout } from './cdp.js';
import { getKeyDefinition, MAC_EDITING_COMMANDS, modifierBits, normalizeModifier, parseChord, requiresShift } from './keys.js';

const BUTTON_MASK = { none: 0, left: 1, right: 2, middle: 4 };
const MODIFIER_KEYS = {
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  cmd: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
};

let isMacPromise;
function isMac() {
  isMacPromise ??= chrome.runtime.getPlatformInfo().then((info) => info.os === 'mac');
  return isMacPromise;
}

export function dispatchMouse(tabId, ev, timeoutMs) {
  const params = { type: ev.type, x: Math.round(ev.x), y: Math.round(ev.y), modifiers: ev.modifiers || 0 };
  if (ev.type === 'mouseWheel') {
    params.deltaX = ev.deltaX || 0;
    params.deltaY = ev.deltaY || 0;
  } else {
    params.button = ev.button || 'none';
    params.buttons = ev.buttons ?? 0;
    if (ev.type !== 'mouseMoved') params.clickCount = ev.clickCount || 1;
  }
  return sendCommand(tabId, 'Input.dispatchMouseEvent', params, timeoutMs);
}

export async function click(tabId, x, y, { button = 'left', count = 1, modifiers = 0 } = {}) {
  await dispatchMouse(tabId, { type: 'mouseMoved', x, y, modifiers });
  await sleep(100);
  for (let i = 1; i <= count; i++) {
    await dispatchMouse(tabId, { type: 'mousePressed', x, y, button, buttons: BUTTON_MASK[button], clickCount: i, modifiers });
    await sleep(12);
    await dispatchMouse(tabId, { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i, modifiers });
    if (i < count) await sleep(100);
  }
}

export async function hover(tabId, x, y) {
  await dispatchMouse(tabId, { type: 'mouseMoved', x, y });
}

export async function drag(tabId, [x0, y0], [x1, y1]) {
  await dispatchMouse(tabId, { type: 'mouseMoved', x: x0, y: y0 });
  await dispatchMouse(tabId, { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    await dispatchMouse(tabId, {
      type: 'mouseMoved',
      x: x0 + ((x1 - x0) * i) / steps,
      y: y0 + ((y1 - y0) * i) / steps,
      button: 'left',
      buttons: 1,
    });
  }
  await dispatchMouse(tabId, { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1 });
}

// 鼠标滚轮；窗口最小化时滚轮事件不生效，或 6 秒内页面没有响应，退回到用脚本滚动该位置最近的可滚动容器
export async function scrollAt(tabId, x, y, deltaX, deltaY) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (win?.state === 'minimized') throw new Error('window minimized');
    await withTimeout(
      dispatchMouse(tabId, { type: 'mouseWheel', x, y, deltaX, deltaY }),
      6000,
      () => new ToolError('scroll_timeout', 'Scroll timeout'),
    );
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (dx, dy, px, py) => {
        const scrollable = (el) => {
          const s = getComputedStyle(el);
          const overflow = [s.overflowX, s.overflowY].some((v) => v === 'auto' || v === 'scroll');
          return overflow && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth);
        };
        let el = document.elementFromPoint(px, py);
        while (el && el !== document.body && el !== document.documentElement && !scrollable(el)) el = el.parentElement;
        const target = el && el !== document.body && el !== document.documentElement ? el : window;
        target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      },
      args: [deltaX, deltaY, x, y],
    });
  }
}

export function parseClickModifiers(str) {
  if (!str) return 0;
  return str.split('+').reduce((bits, part) => {
    const m = normalizeModifier(part);
    return m ? bits | modifierBits([m]) : bits;
  }, 0);
}

function keyEventParams(type, def, modifiers) {
  return {
    type,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
    location: def.location ?? 0,
    isKeypad: def.isKeypad ?? false,
  };
}

function pressKey(tabId, def, modifiers = 0, commands = []) {
  // 按住 ctrl/alt/cmd 时不产生文本输入，否则 cmd+a 之类会把字母输进去
  const text = modifiers & 7 ? '' : def.text ?? '';
  const down = { ...keyEventParams(text ? 'keyDown' : 'rawKeyDown', def, modifiers), text, unmodifiedText: text, commands };
  return Promise.all([
    sendCommandFast(tabId, 'Input.dispatchKeyEvent', down),
    sendCommandFast(tabId, 'Input.dispatchKeyEvent', keyEventParams('keyUp', def, modifiers)),
  ]);
}

async function pressChord(tabId, chord) {
  const { modifiers, key, id } = parseChord(chord);
  if (!key) throw new ToolError('input_invalid', `No key to press in chord: ${chord}`);
  const def = getKeyDefinition(key) || MODIFIER_KEYS[normalizeModifier(key)];
  if (!def) throw new ToolError('input_invalid', `Unknown key: ${chord}`);
  const commands = (await isMac()) ? [].concat(MAC_EDITING_COMMANDS[id] ?? []) : [];

  let bits = 0;
  for (const m of modifiers) {
    bits |= modifierBits([m]);
    await sendCommandFast(tabId, 'Input.dispatchKeyEvent', { ...keyEventParams('rawKeyDown', MODIFIER_KEYS[m], bits) });
  }
  await pressKey(tabId, def, bits, commands);
  for (const m of [...modifiers].reverse()) {
    bits &= ~modifierBits([m]);
    await sendCommandFast(tabId, 'Input.dispatchKeyEvent', keyEventParams('keyUp', MODIFIER_KEYS[m], bits));
  }
}

// keys 为按空格分隔的按键列表，例如 "Backspace Backspace"、"cmd+a"
export async function pressKeys(tabId, keys, repeat = 1) {
  await ensureAttached(tabId);
  for (let r = 0; r < repeat; r++) {
    for (const token of keys) {
      if (token.length > 1 && token.includes('+')) {
        await pressChord(tabId, token);
      } else {
        const def = getKeyDefinition(token) || MODIFIER_KEYS[normalizeModifier(token)];
        if (def) await pressKey(tabId, def);
        else await sendCommandFast(tabId, 'Input.insertText', { text: token });
      }
    }
  }
}

// 逐字符输入：键盘上有的字符走真实按键（触发 keydown/keyup），其他字符（中文、emoji 等）直接插入
// 设置页可关闭“模拟真人打字节奏”（默认开启）
export async function humanTypingEnabled() {
  const { inputConfig } = await chrome.storage.local.get('inputConfig');
  return inputConfig?.humanTyping !== false;
}

export async function typeText(tabId, text) {
  await ensureAttached(tabId);
  const chars = [...text.replace(/\r\n?/g, '\n')];
  const typeChar = (ch) => {
    const def = getKeyDefinition(ch === '\n' ? 'Enter' : ch);
    return def ? pressKey(tabId, def, requiresShift(ch) ? 8 : 0) : sendCommandFast(tabId, 'Input.insertText', { text: ch });
  };
  if (!(await humanTypingEnabled())) {
    await Promise.all(chars.map(typeChar));
    return;
  }
  // 模拟真人节奏：每个字符之间随机间隔。一口气打完的输入（如几十毫秒打完一个词）
  // 会被部分网站判定为机器人；文本越长间隔越短，一次输入总共约在 12 秒以内
  const base = Math.min(60, 12_000 / Math.max(chars.length, 1));
  for (let i = 0; i < chars.length; i++) {
    await typeChar(chars[i]);
    if (i < chars.length - 1) await sleep(base * (0.6 + Math.random() * 0.8));
  }
}
