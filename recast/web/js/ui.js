// DOM helpers. h() builds elements safely (text is never parsed as HTML).
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v; // only used with static, trusted markup (icons)
    else if (k in el && !['list', 'form', 'type'].includes(k) && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
export const mount = (el, ...children) => { clear(el); append(el, children); return el; };

// ---------- Icons (static SVG) ----------
const I = {
  dashboard: '<path d="M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z"/>',
  workflows: '<path d="M7 3a3 3 0 0 0-1 5.83V15a4 4 0 0 0 4 4h4.17A3 3 0 1 0 14.17 17H10a2 2 0 0 1-2-2v-1.17A3 3 0 0 0 9 14h6.17a3 3 0 1 0 0-2H9a1 1 0 0 1-1-1V8.83A3 3 0 0 0 7 3z"/>',
  library: '<path d="M4 6h16v12H4zm2 2v8h12V8zm3 1.5 5 2.5-5 2.5z"/>',
  queue: '<path d="M7 2v2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zm-2 7h14v10H5zm2 2v2h2v-2zm4 0v2h2v-2zm4 0v2h2v-2zm-8 4v2h2v-2zm4 0v2h2v-2z"/>',
  connections: '<path d="M10.6 13.4a1 1 0 0 1 0-1.4l3.5-3.5a3 3 0 0 1 4.24 4.24l-2.12 2.12-1.41-1.41 2.12-2.12a1 1 0 0 0-1.42-1.42L12 13.4a1 1 0 0 1-1.4 0zm2.8-2.8a1 1 0 0 1 0 1.4l-3.5 3.5a3 3 0 0 1-4.24-4.24l2.12-2.12 1.41 1.41-2.12 2.12a1 1 0 0 0 1.42 1.42L12 10.6a1 1 0 0 1 1.4 0z"/>',
  brand: '<path d="M12 3a9 9 0 0 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1.1.9-2 2-2h2.4A4.6 4.6 0 0 0 22 9.9C22 6.1 17.5 3 12 3zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4v2h-2.6L14 22 10 6l-1.6 6H3z"/>',
  settings: '<path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L11 21h4l.4-2.9c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>',
  plus: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>',
  upload: '<path d="M11 16V7.8l-3.3 3.3-1.4-1.4L12 4l5.7 5.7-1.4 1.4L13 7.8V16zm-6 2h14v2H5z"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  link: '<path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14zM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/>',
  audio: '<path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/>',
  arrow: '<path d="M4 11h12.2l-5.6-5.6L12 4l8 8-8 8-1.4-1.4 5.6-5.6H4z"/>',
  refresh: '<path d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"/>',
  trash: '<path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/>',
};
export const icon = (name, cls = '') => h('span', { class: `ic ${cls}`, style: { display: 'inline-flex' }, html: `<svg viewBox="0 0 24 24" fill="currentColor">${I[name] || ''}</svg>` });

// ---------- Platform badges ----------
const GLYPH = { upload: '⇪', tiktok: '♪', youtube: '▶', instagram: '◎', facebook: 'f', linkedin: 'in', x: '𝕏', rss: '◉', profile: '@', folder: '▤', webhook: '⚡' };
export function pf(platform, color, size = '') {
  return h(`span.pf${size ? '.' + size : ''}`, { style: { background: color || '#666' }, title: platform }, GLYPH[platform] || platform.slice(0, 2).toUpperCase());
}

// ---------- Formatting ----------
export const fmtDuration = (s) => {
  s = Math.round(Number(s) || 0);
  const m = Math.floor(s / 60), r = s % 60;
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
export const fmtBytes = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
export function fmtDate(ts, opts = {}) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...opts });
}
export function timeAgo(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  const fut = s < 0; const a = Math.abs(s);
  const v = a < 60 ? 'just now' : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
  return v === 'just now' ? v : fut ? `in ${v}` : `${v} ago`;
}
export const toLocalInput = (ts) => { const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export const STATUS = {
  waiting_media: ['Downloading', 'info'], rendering: ['Rendering', 'info'], needs_approval: ['Needs review', 'warn'], scheduled: ['Scheduled', 'accent'],
  publishing: ['Publishing', 'info'], published: ['Published', 'ok'], failed: ['Failed', 'err'], skipped: ['Skipped', ''], canceled: ['Canceled', ''],
  ready: ['Ready', 'ok'], remote: ['Not imported', ''], queued: ['Queued', 'info'], downloading: ['Downloading', 'info'], uploading: ['Uploading', 'info'], error: ['Error', 'err'],
  active: ['Active', 'ok'], disabled: ['Paused', ''],
};
export const statusChip = (s) => { const [label, cls] = STATUS[s] || [s, '']; return h(`span.chip${cls ? '.' + cls : ''}`, label); };

// ---------- Toasts ----------
export function toast(msg, kind = '') {
  const el = h(`div.toast${kind ? '.' + kind : ''}`, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6500 : 3500);
}
export const toastErr = (e) => toast(e?.message || String(e), 'err');

// ---------- Modal ----------
export function modal({ title, body, foot, wide = false, onClose }) {
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const back = h('div.modal-back', { onmousedown: (e) => { if (e.target === back) close(); } },
    h(`div.modal${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true' },
      h('div.modal-head', h('h2', title), h('button.x', { onclick: close, 'aria-label': 'Close' }, '×')),
      h('div.modal-body', body),
      foot ? h('div.modal-foot', typeof foot === 'function' ? foot(close) : foot) : null));
  document.body.append(back);
  document.addEventListener('keydown', onKey);
  back.querySelector('input, textarea, select')?.focus();
  return { close, el: back };
}

export function confirmDialog(title, message, { danger = false, okLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, body: h('p', message),
      foot: (close) => [h('button.btn', { onclick: close }, 'Cancel'), h(`button.btn.${danger ? 'danger' : 'primary'}`, { onclick: () => { done = true; close(); } }, okLabel)],
      onClose: () => resolve(done),
    });
    return m;
  });
}

/** Wrap an async button handler: disables the button while running and toasts errors. */
export function busy(fn) {
  return async (e) => {
    const btn = e?.currentTarget;
    if (btn) btn.disabled = true;
    try { await fn(e); } catch (err) { toastErr(err); } finally { if (btn) btn.disabled = false; }
  };
}

export const field = (label, input, help) => h('label.field', h('span', label), input, help ? h('span.help', help) : null);
export function toggle(checked, onchange) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) });
  return h('label.toggle', input, h('span'));
}
export function seg(options, value, onchange) {
  const wrap = h('div.seg');
  const render = (v) => mount(wrap, options.map(([val, label]) => h(`button${val === v ? '.on' : ''}`, { type: 'button', onclick: () => { render(val); onchange(val); } }, label)));
  render(value);
  return wrap;
}
export function select(options, value, onchange, attrs = {}) {
  return h('select', { ...attrs, onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
}
export function emptyState(title, text, action) {
  return h('div.empty', h('h3', title), h('p', text), action || null);
}
