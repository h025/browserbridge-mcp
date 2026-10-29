// 键盘定义（US 键位）与 macOS 编辑命令映射。
// macOS 上 Chrome 的编辑快捷键由系统 NSResponder 处理，CDP 合成的按键不会触发，
// 需要在 Input.dispatchKeyEvent 里显式附带 commands。

const named = (key, code, keyCode, extra = {}) => ({ key, code, keyCode, ...extra });

const KEYS = {
  enter: named('Enter', 'Enter', 13, { text: '\r' }),
  return: named('Enter', 'Enter', 13, { text: '\r' }),
  kp_enter: named('Enter', 'NumpadEnter', 13, { text: '\r', location: 3, isKeypad: true }),
  numpadenter: named('Enter', 'NumpadEnter', 13, { text: '\r', location: 3, isKeypad: true }),
  tab: named('Tab', 'Tab', 9),
  delete: named('Delete', 'Delete', 46),
  backspace: named('Backspace', 'Backspace', 8),
  escape: named('Escape', 'Escape', 27),
  esc: named('Escape', 'Escape', 27),
  space: named(' ', 'Space', 32, { text: ' ' }),
  ' ': named(' ', 'Space', 32, { text: ' ' }),
  arrowup: named('ArrowUp', 'ArrowUp', 38),
  arrowdown: named('ArrowDown', 'ArrowDown', 40),
  arrowleft: named('ArrowLeft', 'ArrowLeft', 37),
  arrowright: named('ArrowRight', 'ArrowRight', 39),
  home: named('Home', 'Home', 36),
  end: named('End', 'End', 35),
  pageup: named('PageUp', 'PageUp', 33),
  pagedown: named('PageDown', 'PageDown', 34),
  insert: named('Insert', 'Insert', 45),
  capslock: named('CapsLock', 'CapsLock', 20),
  numlock: named('NumLock', 'NumLock', 144),
  scrolllock: named('ScrollLock', 'ScrollLock', 145),
  pause: named('Pause', 'Pause', 19),
  printscreen: named('PrintScreen', 'PrintScreen', 44),
  numpadmultiply: named('*', 'NumpadMultiply', 106, { text: '*', location: 3, isKeypad: true }),
  numpadadd: named('+', 'NumpadAdd', 107, { text: '+', location: 3, isKeypad: true }),
  numpadsubtract: named('-', 'NumpadSubtract', 109, { text: '-', location: 3, isKeypad: true }),
  numpaddecimal: named('.', 'NumpadDecimal', 110, { text: '.', location: 3, isKeypad: true }),
  numpaddivide: named('/', 'NumpadDivide', 111, { text: '/', location: 3, isKeypad: true }),
};
for (const [alias, target] of Object.entries({ up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', page_up: 'pageup', page_down: 'pagedown' })) {
  KEYS[alias] = KEYS[target];
}
for (let i = 1; i <= 12; i++) KEYS[`f${i}`] = named(`F${i}`, `F${i}`, 111 + i);
for (let i = 0; i <= 9; i++) {
  KEYS[`numpad${i}`] = named(String(i), `Numpad${i}`, 96 + i, { text: String(i), location: 3, isKeypad: true });
}

// 标点：[未按 shift 的字符, 按 shift 的字符, code, keyCode]
const PUNCTUATION = [
  [';', ':', 'Semicolon', 186], ['=', '+', 'Equal', 187], [',', '<', 'Comma', 188],
  ['-', '_', 'Minus', 189], ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191],
  ['`', '~', 'Backquote', 192], ['[', '{', 'BracketLeft', 219], ['\\', '|', 'Backslash', 220],
  [']', '}', 'BracketRight', 221], ["'", '"', 'Quote', 222],
];
for (const [plain, shifted, code, keyCode] of PUNCTUATION) {
  KEYS[plain] = named(plain, code, keyCode, { text: plain });
  KEYS[shifted] = named(shifted, code, keyCode, { text: shifted });
}
'!@#$%^&*()'.split('').forEach((ch, i) => {
  const digit = String((i + 1) % 10);
  KEYS[ch] = named(ch, `Digit${digit}`, 48 + Number(digit), { text: ch });
});

const SHIFTED_CHARS = '~!@#$%^&*()_+{}|:"<>?';

// 只按住 shift 时键位产生的字符：shift+a → A，shift+1 → !，shift+; → :
const SHIFT_MAP = Object.fromEntries(PUNCTUATION.map(([plain, shifted]) => [plain, shifted]));
'!@#$%^&*()'.split('').forEach((ch, i) => {
  SHIFT_MAP[String((i + 1) % 10)] = ch;
});

export function shiftedDefinition(def) {
  if (def.isKeypad || def.text?.length !== 1) return def;
  const ch = SHIFT_MAP[def.text] ?? (def.text >= 'a' && def.text <= 'z' ? def.text.toUpperCase() : null);
  return ch ? { ...def, key: ch, text: ch } : def;
}

export function getKeyDefinition(name) {
  const def = KEYS[name.toLowerCase()];
  if (def) return def;
  if (name.length === 1) {
    const upper = name.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') return named(name, `Key${upper}`, upper.charCodeAt(0), { text: name });
    if (name >= '0' && name <= '9') return named(name, `Digit${name}`, name.charCodeAt(0), { text: name });
  }
  return null;
}

export function requiresShift(ch) {
  return SHIFTED_CHARS.includes(ch) || (ch >= 'A' && ch <= 'Z');
}

export const MODIFIER_BITS = { alt: 1, ctrl: 2, cmd: 4, shift: 8 };
const MODIFIER_ALIASES = {
  alt: 'alt', option: 'alt', opt: 'alt',
  ctrl: 'ctrl', control: 'ctrl',
  cmd: 'cmd', meta: 'cmd', command: 'cmd', win: 'cmd', windows: 'cmd', super: 'cmd',
  shift: 'shift',
};
const MODIFIER_ORDER = ['shift', 'ctrl', 'alt', 'cmd'];
const KEY_ALIASES = { up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', return: 'enter', esc: 'escape', page_up: 'pageup', page_down: 'pagedown', kp_enter: 'numpadenter' };

export function normalizeModifier(name) {
  return MODIFIER_ALIASES[name.trim().toLowerCase()] || null;
}

// "cmd+shift+z" -> { modifiers: ['shift', 'cmd'], key: 'z', id: 'shift+cmd+z' }
export function parseChord(chord) {
  const parts = chord.replace(/\+\+$/, '+plus').split('+');
  let key = parts.pop() || '';
  if (key === 'plus') key = '+';
  const modifiers = [];
  for (const p of parts) {
    const m = normalizeModifier(p);
    if (!m) throw new Error(`Unknown modifier "${p}" in "${chord}"`);
    if (!modifiers.includes(m)) modifiers.push(m);
  }
  modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  const lower = key.toLowerCase();
  const id = [...modifiers, KEY_ALIASES[lower] || lower].join('+');
  return { modifiers, key, id };
}

export function modifierBits(modifiers) {
  return modifiers.reduce((bits, m) => bits | MODIFIER_BITS[m], 0);
}

// 浏览器缩放快捷键：返回 'in' / 'out' / 'reset'，其他返回 null
export function pageZoomShortcut(chord) {
  let parsed;
  try {
    parsed = parseChord(chord.toLowerCase());
  } catch {
    return null;
  }
  const { modifiers, key } = parsed;
  if (!modifiers.some((m) => m === 'ctrl' || m === 'cmd')) return null;
  if (modifiers.some((m) => m === 'alt')) return null;
  if (['+', '=', 'plus', 'add', 'numpadadd'].includes(key)) return 'in';
  if (modifiers.includes('shift')) return null;
  if (['-', 'minus', 'subtract', 'numpadsubtract'].includes(key)) return 'out';
  if (['0', 'numpad0'].includes(key)) return 'reset';
  return null;
}

// 键为 parseChord 生成的规范化 id（修饰键顺序 shift, ctrl, alt, cmd）
export const MAC_EDITING_COMMANDS = {
  backspace: 'deleteBackward',
  enter: 'insertNewline',
  numpadenter: 'insertNewline',
  escape: 'cancelOperation',
  arrowup: 'moveUp',
  arrowdown: 'moveDown',
  arrowleft: 'moveLeft',
  arrowright: 'moveRight',
  f5: 'complete',
  delete: 'deleteForward',
  home: 'scrollToBeginningOfDocument',
  end: 'scrollToEndOfDocument',
  pageup: 'scrollPageUp',
  pagedown: 'scrollPageDown',
  'shift+backspace': 'deleteBackward',
  'shift+enter': 'insertNewline',
  'shift+escape': 'cancelOperation',
  'shift+arrowup': 'moveUpAndModifySelection',
  'shift+arrowdown': 'moveDownAndModifySelection',
  'shift+arrowleft': 'moveLeftAndModifySelection',
  'shift+arrowright': 'moveRightAndModifySelection',
  'shift+delete': 'deleteForward',
  'shift+home': 'moveToBeginningOfDocumentAndModifySelection',
  'shift+end': 'moveToEndOfDocumentAndModifySelection',
  'shift+pageup': 'pageUpAndModifySelection',
  'shift+pagedown': 'pageDownAndModifySelection',
  'ctrl+tab': 'selectNextKeyView',
  'ctrl+enter': 'insertLineBreak',
  "ctrl+'": 'insertSingleQuoteIgnoringSubstitution',
  'ctrl+a': 'moveToBeginningOfParagraph',
  'ctrl+b': 'moveBackward',
  'ctrl+d': 'deleteForward',
  'ctrl+e': 'moveToEndOfParagraph',
  'ctrl+f': 'moveForward',
  'ctrl+h': 'deleteBackward',
  'ctrl+k': 'deleteToEndOfParagraph',
  'ctrl+l': 'centerSelectionInVisibleArea',
  'ctrl+n': 'moveDown',
  'ctrl+p': 'moveUp',
  'ctrl+t': 'transpose',
  'ctrl+y': 'yank',
  'ctrl+o': ['insertNewlineIgnoringFieldEditor', 'moveBackward'],
  'ctrl+backspace': 'deleteBackwardByDecomposingPreviousCharacter',
  'ctrl+arrowup': 'scrollPageUp',
  'ctrl+arrowdown': 'scrollPageDown',
  'ctrl+arrowleft': 'moveToLeftEndOfLine',
  'ctrl+arrowright': 'moveToRightEndOfLine',
  'shift+ctrl+enter': 'insertLineBreak',
  'shift+ctrl+tab': 'selectPreviousKeyView',
  'shift+ctrl+a': 'moveToBeginningOfParagraphAndModifySelection',
  'shift+ctrl+b': 'moveBackwardAndModifySelection',
  'shift+ctrl+e': 'moveToEndOfParagraphAndModifySelection',
  'shift+ctrl+f': 'moveForwardAndModifySelection',
  'shift+ctrl+n': 'moveDownAndModifySelection',
  'shift+ctrl+p': 'moveUpAndModifySelection',
  'shift+ctrl+arrowup': 'scrollPageUp',
  'shift+ctrl+arrowdown': 'scrollPageDown',
  'shift+ctrl+arrowleft': 'moveToLeftEndOfLineAndModifySelection',
  'shift+ctrl+arrowright': 'moveToRightEndOfLineAndModifySelection',
  'alt+backspace': 'deleteWordBackward',
  'alt+enter': 'insertNewlineIgnoringFieldEditor',
  'alt+escape': 'complete',
  'alt+arrowup': ['moveBackward', 'moveToBeginningOfParagraph'],
  'alt+arrowdown': ['moveForward', 'moveToEndOfParagraph'],
  'alt+arrowleft': 'moveWordLeft',
  'alt+arrowright': 'moveWordRight',
  'alt+delete': 'deleteWordForward',
  'alt+pageup': 'pageUp',
  'alt+pagedown': 'pageDown',
  'shift+alt+backspace': 'deleteWordBackward',
  'shift+alt+arrowup': 'moveParagraphBackwardAndModifySelection',
  'shift+alt+arrowdown': 'moveParagraphForwardAndModifySelection',
  'shift+alt+arrowleft': 'moveWordLeftAndModifySelection',
  'shift+alt+arrowright': 'moveWordRightAndModifySelection',
  'shift+alt+delete': 'deleteWordForward',
  'ctrl+alt+b': 'moveWordBackward',
  'ctrl+alt+f': 'moveWordForward',
  'ctrl+alt+backspace': 'deleteWordBackward',
  'shift+ctrl+alt+b': 'moveWordBackwardAndModifySelection',
  'shift+ctrl+alt+f': 'moveWordForwardAndModifySelection',
  'cmd+backspace': 'deleteToBeginningOfLine',
  'cmd+arrowup': 'moveToBeginningOfDocument',
  'cmd+arrowdown': 'moveToEndOfDocument',
  'cmd+arrowleft': 'moveToLeftEndOfLine',
  'cmd+arrowright': 'moveToRightEndOfLine',
  'cmd+home': 'moveToBeginningOfDocument',
  'shift+cmd+backspace': 'deleteToBeginningOfLine',
  'shift+cmd+arrowup': 'moveToBeginningOfDocumentAndModifySelection',
  'shift+cmd+arrowdown': 'moveToEndOfDocumentAndModifySelection',
  'shift+cmd+arrowleft': 'moveToLeftEndOfLineAndModifySelection',
  'shift+cmd+arrowright': 'moveToRightEndOfLineAndModifySelection',
  'cmd+a': 'selectAll',
  'cmd+c': 'copy',
  'cmd+x': 'cut',
  'cmd+v': 'paste',
  'cmd+z': 'undo',
  'shift+cmd+z': 'redo',
};
