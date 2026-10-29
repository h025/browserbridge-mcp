// 运行在页面隔离世界（isolated world）的内容脚本：生成可访问性树并为元素分配 ref，
// 以及按 ref 定位、填写表单、上传文件、提取正文、关键词查找元素。
// 由 manifest 在 document_start 注入；扩展安装前已打开的页面由工具按需注入。重复注入时复用已有实例。
(() => {
  if (window.__bbAgent) return;

  const refMap = new Map(); // 'ref_N' -> WeakRef<Element>
  const reverseMap = new WeakMap();
  let refCounter = 0;

  const MAX_NODES = 10000;
  const DEFAULT_DEPTH = 15;
  const DEFAULT_MAX_CHARS = 50000;
  const SKIP_TAGS = new Set(['script', 'style', 'meta', 'link', 'title', 'noscript', 'template']);
  const SENSITIVE_AUTOCOMPLETE = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'];
  const TAG_ROLES = {
    a: 'link', button: 'button', select: 'combobox', textarea: 'textbox',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    img: 'image', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
    section: 'region', article: 'article', aside: 'complementary', form: 'form', table: 'table',
    ul: 'list', ol: 'list', li: 'listitem', label: 'label', dialog: 'dialog', summary: 'button',
  };
  const INPUT_ROLES = {
    submit: 'button', button: 'button', reset: 'button', image: 'button', file: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
  };
  const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'details', 'summary']);
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem',
  ]);
  const LANDMARK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav', 'main', 'header', 'footer', 'section', 'article', 'aside']);

  function refFor(el) {
    const existing = reverseMap.get(el);
    if (existing && refMap.get(existing)?.deref() === el) return existing;
    const ref = `ref_${++refCounter}`;
    refMap.set(ref, new WeakRef(el));
    reverseMap.set(el, ref);
    return ref;
  }

  class AgentError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  function getElement(ref) {
    const el = refMap.get(ref)?.deref();
    if (!el || !el.isConnected) {
      refMap.delete(ref);
      throw new AgentError('ref_stale', `No element found with reference: "${ref}". The element may have been removed from the page. Use read_page or find to get fresh references.`);
    }
    return el;
  }

  function isSensitive(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden') return true;
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    return SENSITIVE_AUTOCOMPLETE.some((v) => autocomplete.includes(v));
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return INPUT_ROLES[(el.getAttribute('type') || '').toLowerCase()] || 'textbox';
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    return TAG_ROLES[tag] || 'generic';
  }

  // 元素内的文字，跳过 <style>、<script> 等不显示的内容（textContent 会把它们也算进去）
  const NON_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  function textOf(el) {
    let text = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && NON_TEXT_TAGS.has(n.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) text += n.data;
      if (text.length > 2000) break;
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  function directText(el) {
    let text = '';
    for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    return text.trim();
  }

  function labelText(el) {
    if (el.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        const text = label && directText(label);
        if (text) return text;
      } catch {
        // 非法 id
      }
    }
    const wrapping = el.labels?.[0];
    return wrapping ? textOf(wrapping) : '';
  }

  function nameOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      if (isSensitive(el)) {
        return el.getAttribute('aria-label')?.trim() || el.getAttribute('title')?.trim() || labelText(el) || '[value redacted]';
      }
      // 用当前选中项（selected 属性只代表初始默认值）
      const option = el.options[el.selectedIndex] || el.querySelector('option[selected]');
      if (option?.textContent) return option.textContent.trim();
    }
    for (const attr of ['aria-label', 'placeholder', 'title', 'alt']) {
      const v = el.getAttribute(attr)?.trim();
      if (v) return v;
    }
    const label = labelText(el);
    if (label) return label;
    if (tag === 'input') {
      const type = el.getAttribute('type') || '';
      const value = el.getAttribute('value');
      if (type === 'submit' && value?.trim()) return value.trim();
      if (isSensitive(el)) return el.value ? '[value redacted]' : '';
      if (el.value && el.value.length < 50 && el.value.trim()) return el.value.trim();
    }
    if (tag === 'textarea' && isSensitive(el)) return el.value ? '[value redacted]' : '';
    if (tag === 'button' || tag === 'a' || tag === 'summary') {
      const text = directText(el) || textOf(el);
      if (text) return text.slice(0, 100);
    }
    if (/^h[1-6]$/.test(tag)) {
      const text = textOf(el);
      if (text) return text.slice(0, 100);
    }
    if (tag === 'img') return '';
    const text = directText(el);
    if (text.length >= 3) return text.length > 100 ? `${text.slice(0, 100)}...` : text;
    return '';
  }

  function isVisible(el) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (el instanceof HTMLElement) return el.offsetWidth > 0 && el.offsetHeight > 0;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0;
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    if (el.getAttribute('onclick') !== null || el.getAttribute('tabindex') !== null) return true;
    if (INTERACTIVE_ROLES.has(el.getAttribute('role'))) return true;
    return el.getAttribute('contenteditable') === 'true';
  }

  function isLandmark(el) {
    return LANDMARK_TAGS.has(el.tagName.toLowerCase()) || el.getAttribute('role') !== null;
  }

  // filter="all"：包括不可见元素；filter="interactive"：只要视口内可见的可交互元素
  function shouldInclude(el, opts) {
    if (SKIP_TAGS.has(el.tagName.toLowerCase())) return false;
    if (opts.filter !== 'all') {
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (!isVisible(el)) return false;
      if (!opts.refId && !inViewport(el)) return false;
    }
    if (opts.filter === 'interactive') return isInteractive(el);
    if (isInteractive(el) || isLandmark(el)) return true;
    if (nameOf(el).length > 0) return true;
    const role = roleOf(el);
    return role !== 'generic' && role !== 'image';
  }

  const quote = (s) => `"${s.replace(/\s+/g, ' ').slice(0, 100).replace(/"/g, '\\"')}"`;

  function describeLine(el, indent) {
    let line = `${' '.repeat(indent)}${roleOf(el)}`;
    const name = nameOf(el);
    if (name) line += ` ${quote(name)}`;
    line += ` [${refFor(el)}]`;
    for (const attr of ['href', 'type', 'placeholder']) {
      const v = el.getAttribute(attr);
      if (v) line += ` ${attr}="${v}"`;
    }
    if ((el.type === 'checkbox' || el.type === 'radio') && el.checked) line += ' checked';
    if (el.disabled) line += ' disabled';
    return line;
  }

  function childElements(el) {
    const kids = [...el.children];
    if (el.shadowRoot) kids.push(...el.shadowRoot.children);
    return kids;
  }

  function accessibilityTree({ filter, depth, maxChars, refId } = {}) {
    const opts = { filter: filter || 'all', refId: refId || null };
    const maxDepth = depth ?? DEFAULT_DEPTH;
    const limit = maxChars ?? DEFAULT_MAX_CHARS;
    const lines = [];
    let count = 0;

    const walk = (el, level) => {
      if (count >= MAX_NODES || level > maxDepth || !el?.tagName) return;
      const include = shouldInclude(el, opts) || (opts.refId !== null && level === 0);
      const tag = el.tagName.toLowerCase();
      if (include) {
        count++;
        lines.push(describeLine(el, level));
        if (tag === 'select' && !isSensitive(el)) {
          for (const opt of el.options) {
            let line = `${' '.repeat(level + 1)}option`;
            const text = opt.textContent?.trim() || '';
            if (text) line += ` ${quote(text)}`;
            if (opt.selected) line += ' (selected)';
            if (opt.value && opt.value !== text) line += ` value="${opt.value.replace(/"/g, '\\"')}"`;
            lines.push(line);
          }
        }
      }
      if (tag === 'select' && isSensitive(el)) return;
      if (level < maxDepth) for (const child of childElements(el)) walk(child, include ? level + 1 : level);
    };

    walk(opts.refId ? getElement(opts.refId) : document.body, 0);
    for (const [ref, weak] of refMap) if (!weak.deref()) refMap.delete(ref);

    const focusHint = opts.refId ? 'use a smaller depth or focus on a more specific child element' : 'use ref_id or a smaller depth to focus';
    let content = lines.join('\n');
    if (count >= MAX_NODES) content += `\n[truncated at ${MAX_NODES} elements — page is very large; ${focusHint}]`;
    if (content.length > limit) {
      const total = content.length;
      let cut = content.lastIndexOf('\n', limit);
      if (cut <= 0) cut = limit;
      content = `${content.slice(0, cut)}\n[output truncated at ${limit} of ${total} characters. Pass a larger max_chars (default ${DEFAULT_MAX_CHARS}) to see more, or ${focusHint}.]`;
    }
    return { pageContent: content, viewport: { width: innerWidth, height: innerHeight } };
  }

  // 本地关键词匹配（匹配不上时 tools.js 会把可交互元素交给调用方 agent 自己挑）
  // 描述里常见的元素类型词：命中时按元素类型匹配，其余文字再按内容匹配（例如“提交按钮” = 文字含“提交”的按钮）
  const ROLE_WORDS = [
    [/搜索框|搜索栏|搜索输入框|search ?(?:box|bar|field|input)/, ['searchbox', 'textbox']],
    [/输入框|文本框|输入栏|文本输入|编辑框|text ?(?:box|field|input)|input ?(?:box|field)/, ['textbox', 'searchbox', 'combobox']],
    [/下拉框|下拉菜单|下拉列表|选择框|dropdown|select ?box/, ['combobox', 'listbox']],
    [/复选框|勾选框|checkbox/, ['checkbox']],
    [/单选框|单选按钮|radio/, ['radio']],
    [/按钮|button/, ['button']],
    [/链接|超链接|link/, ['link']],
    [/图片|图像|image|picture/, ['img']],
    [/选项卡|标签页|\btab\b/, ['tab']],
    [/开关|switch|toggle/, ['switch', 'checkbox']],
    [/滑块|slider/, ['slider']],
  ];

  function find({ query, limit = 20 }) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) throw new AgentError('input_invalid', 'Query parameter is required');
    const wantedRoles = new Set();
    let rest = q;
    for (const [re, roles] of ROLE_WORDS) {
      if (!re.test(rest)) continue;
      roles.forEach((r) => wantedRoles.add(r));
      rest = rest.replace(re, ' ');
    }
    rest = rest.replace(/[的个那这一]+$|^[那这一个的]+/g, '').trim();
    const tokens = rest ? rest.split(/\s+/).filter(Boolean) : [];
    const matches = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot);
        if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
        const interactive = isInteractive(el);
        const name = nameOf(el);
        if (!interactive && !name && !isLandmark(el)) continue;
        const role = roleOf(el);
        const fields = [
          role, name, labelText(el), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'),
          el.id, el.getAttribute('name'), el.getAttribute('type'), el.getAttribute('href'), el.getAttribute('data-testid'),
          interactive ? textOf(el).slice(0, 200) : '',
        ].filter(Boolean).join(' ').toLowerCase();
        let score = 0;
        for (const t of tokens) if (fields.includes(t)) score += 1;
        const roleHit = wantedRoles.has(role);
        // 只写了类型（如“搜索框”）时按类型找；类型和文字都写了时，类型对上加分，只对上类型的排在后面
        if (roleHit) score += tokens.length ? (score ? 2 : 0.5) : 1;
        if (!score) continue;
        const lowerName = name.toLowerCase();
        const text = (rest || q).trim();
        if (text && lowerName === text) score += 3;
        else if (text && lowerName.includes(text)) score += 2;
        if (interactive) score += 1;
        const visible = isVisible(el);
        if (visible) score += 0.5;
        if (visible && inViewport(el)) score += 0.25;
        matches.push({ el, role, name, score, visible, interactive });
      }
    };
    visit(document);
    matches.sort((a, b) => b.score - a.score);
    // 子元素与祖先元素同名时只保留得分更高的那个
    const picked = [];
    for (const m of matches) {
      if (picked.some((p) => p.name === m.name && (p.el.contains(m.el) || m.el.contains(p.el)))) continue;
      picked.push(m);
    }
    return {
      total: picked.length,
      items: picked.slice(0, limit).map((m) => ({
        ref: refFor(m.el),
        role: m.role,
        name: m.name,
        type: m.el.getAttribute('type') || '',
        hidden: !m.visible,
        interactive: m.interactive,
      })),
    };
  }

  // 滚动到元素并返回其中心点的视口坐标（CSS 像素）；中心点被其他元素（如弹窗、横幅）挡住时一并返回遮挡者
  function scrollToRef({ ref }) {
    const el = getElement(ref);
    el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    let covered = null;
    const hit = document.elementFromPoint(x, y);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el) && !hit.hasAttribute('data-bb-indicator')) {
      // label 与它关联的输入框互相点击等效，不算遮挡
      const label = hit.closest('label');
      if (!(label && (label.control === el || label.contains(el)))) {
        const name = nameOf(hit);
        covered = `${roleOf(hit)}${name ? ` "${name.slice(0, 60)}"` : ''} <${hit.tagName.toLowerCase()}>`;
      }
    }
    return { x, y, covered };
  }

  function fire(el) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function formInput({ ref, value }) {
    const el = getElement(ref);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const sensitive = isSensitive(el);
    const show = (v) => (sensitive ? '[redacted]' : String(v));

    if (el instanceof HTMLSelectElement) {
      const previous = el.value;
      const wanted = String(value);
      const options = [...el.options];
      const index = options.findIndex((o) => o.value === wanted || o.text === wanted);
      if (index < 0) {
        const available = sensitive ? '[redacted]' : options.map((o) => `"${o.text}" (value: "${o.value}")`).join(', ');
        throw new AgentError('input_invalid', `Option "${show(wanted)}" not found. Available options: ${available}`);
      }
      el.selectedIndex = index;
      el.focus();
      fire(el);
      return `Selected option "${show(wanted)}" in dropdown (previous: "${show(previous)}")`;
    }
    if (el instanceof HTMLInputElement) {
      const type = el.type;
      const previous = el.value;
      // 复选框/单选框优先用 click() 切换：React 等框架监听的是 click 事件，直接改 checked 不会触发 onChange
      if (type === 'checkbox') {
        const checked = typeof value === 'boolean' ? value : { true: true, false: false }[String(value).toLowerCase()];
        if (checked === undefined) throw new AgentError('input_invalid', 'Checkbox requires a boolean value (true/false)');
        const before = el.checked;
        el.focus();
        if (el.checked !== checked) el.click();
        if (el.checked !== checked) {
          el.checked = checked;
          fire(el);
        }
        return `Checkbox ${el.checked ? 'checked' : 'unchecked'} (previous: ${before})`;
      }
      if (type === 'radio') {
        el.focus();
        if (!el.checked) el.click();
        if (!el.checked) {
          el.checked = true;
          fire(el);
        }
        return `Radio button selected${el.name ? ` in group "${el.name}"` : ''}`;
      }
      if (type === 'file') throw new AgentError('element_unsupported', 'Use the file_upload tool for file inputs.');
      if (type === 'range' || type === 'number') {
        const n = Number(value);
        if (Number.isNaN(n) && !(type === 'number' && value === '')) {
          throw new AgentError('input_invalid', `${type === 'range' ? 'Range' : 'Number'} input requires a numeric value`);
        }
        el.value = type === 'range' ? String(n) : String(value);
        el.focus();
        fire(el);
        return type === 'range'
          ? `Set range to ${show(el.value)} (min: ${el.min}, max: ${el.max})`
          : `Set number input to ${show(el.value)} (previous: ${show(previous)})`;
      }
      el.value = String(value);
      el.focus();
      if (['text', 'search', 'url', 'tel', 'password'].includes(type)) el.setSelectionRange(el.value.length, el.value.length);
      fire(el);
      return `Set ${type || 'text'} value to "${show(el.value)}" (previous: "${show(previous)}")`;
    }
    if (el instanceof HTMLTextAreaElement) {
      const previous = el.value;
      el.value = String(value);
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      fire(el);
      return `Set textarea value to "${show(el.value)}" (previous: "${show(previous)}")`;
    }
    if (el.isContentEditable) {
      el.focus();
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, String(value));
      return `Set contenteditable text to "${el.textContent.slice(0, 200)}"`;
    }
    throw new AgentError('element_unsupported', `Element type "${el.tagName}" is not a supported form input`);
  }

  const ARTICLE_SELECTORS = [
    'article', 'main', '[class*="articleBody"]', '[class*="article-body"]', '[class*="post-content"]',
    '[class*="entry-content"]', '[class*="content-body"]', '[role="main"]', '.content', '#content',
  ];

  function pageText({ maxChars = DEFAULT_MAX_CHARS } = {}) {
    let root = null;
    for (const selector of ARTICLE_SELECTORS) {
      const candidates = document.querySelectorAll(selector);
      if (!candidates.length) continue;
      root = [...candidates].reduce((best, el) => ((el.innerText?.length || 0) > (best.innerText?.length || 0) ? el : best));
      break;
    }
    root ||= document.body;
    let text = (root?.innerText || '')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text.length < 10) {
      throw new AgentError('get_page_text_no_content', 'No text content found. Page may contain only images, videos, or canvas-based content.');
    }
    if (text.length > maxChars) {
      const total = text.length;
      let cut = text.lastIndexOf('\n', maxChars);
      if (cut <= 0) cut = maxChars;
      text = `${text.slice(0, cut)}\n\n[output truncated at ${maxChars} of ${total} characters. Pass a larger max_chars (default ${DEFAULT_MAX_CHARS}) to see more, or use read_page with a ref_id to focus on a smaller section.]`;
    }
    return { title: document.title, url: location.href, source: root.tagName.toLowerCase(), text };
  }

  function makeTransfer(files) {
    const transfer = new DataTransfer();
    let bytes = 0;
    for (const f of files) {
      const bin = atob(f.data);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      bytes += buf.length;
      transfer.items.add(new File([buf], f.name, { type: f.mimeType || 'application/octet-stream', lastModified: Date.now() }));
    }
    return { transfer, kb: Math.round(bytes / 1024) };
  }

  function setInputFiles(el, transfer) {
    el.files = transfer.files;
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function uploadFiles({ ref, files }) {
    const el = getElement(ref);
    if (el.tagName !== 'INPUT' || el.type !== 'file') {
      throw new AgentError('element_unsupported', `Element is not a file input. Found: <${el.tagName.toLowerCase()}${el.type ? ` type="${el.type}"` : ''}>`);
    }
    const { transfer, kb } = makeTransfer(files);
    setInputFiles(el, transfer);
    return `Uploaded ${files.length} file(s) to file input: ${files.map((f) => f.name).join(', ')} (${kb} KB total)`;
  }

  // 把文件放到 ref 指向的元素，或拖放到视口坐标 point 处（适合 Google Docs 之类的拖放区域）。
  // 文件输入框直接设置 files，其他元素依次派发 dragenter / dragover / drop
  function dropFiles({ ref, point, label, files }) {
    let el;
    if (point) {
      el = document.elementFromPoint(point[0], point[1]);
      if (!el) throw new AgentError('element_not_found', `No element found at coordinates (${label?.[0]}, ${label?.[1]})`);
      if (el.tagName === 'IFRAME') {
        try {
          const doc = el.contentDocument;
          const r = el.getBoundingClientRect();
          const inner = doc?.elementFromPoint(point[0] - r.left, point[1] - r.top);
          if (inner) el = inner;
        } catch {
          // 跨域 iframe 无法进入
        }
      }
    } else {
      el = getElement(ref);
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
    }
    const { transfer, kb } = makeTransfer(files);
    const names = files.map((f) => `"${f.name}"`).join(', ');
    if (el.tagName === 'INPUT' && el.type === 'file') {
      setInputFiles(el, transfer);
      el.dispatchEvent(new CustomEvent('filechange', { bubbles: true, detail: { files: transfer.files } }));
      return `Successfully uploaded ${names} (${kb}KB) to file input`;
    }
    el.focus?.();
    let x;
    let y;
    if (point) {
      [x, y] = point;
    } else {
      const r = el.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    for (const type of ['dragenter', 'dragover', 'drop']) {
      el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: transfer,
        clientX: x, clientY: y, screenX: x + window.screenX, screenY: y + window.screenY,
      }));
    }
    const [lx, ly] = label || [x, y];
    return `Successfully dropped ${names} (${kb}KB) onto element at (${Math.round(lx)}, ${Math.round(ly)})`;
  }

  const api = { accessibilityTree, find, scrollToRef, formInput, pageText, uploadFiles, dropFiles };

  // 统一返回 { ok, value } / { ok: false, error, code }，避免异常在跨世界传递时丢失信息
  window.__bbAgent = (method, args) => {
    try {
      return { ok: true, value: api[method](args) };
    } catch (e) {
      return { ok: false, error: e?.message || String(e), code: e?.code };
    }
  };
})();
