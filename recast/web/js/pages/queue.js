import { h, mount, pf, statusChip, fmtDate, timeAgo, modal, field, toast, busy, confirmDialog, emptyState, icon, seg, toLocalInput, fmtDuration } from '../ui.js';
import { GET, POST, PATCH, DEL } from '../api.js';
import { store } from '../store.js';
import { parseHash } from '../app.js';

const TABS = [
  ['upcoming', 'Upcoming', 'waiting_media,rendering,scheduled,publishing', 'asc'],
  ['review', 'Needs review', 'needs_approval', 'asc'],
  ['published', 'Published', 'published', 'desc'],
  ['failed', 'Failed', 'failed,skipped', 'desc'],
  ['all', 'All', '', 'desc'],
];
const COUNT_KEYS = { upcoming: ['waiting_media', 'rendering', 'scheduled', 'publishing'], review: ['needs_approval'], published: ['published'], failed: ['failed', 'skipped'] };

let refreshQueue = null;

export async function queuePage(el) {
  const { params } = parseHash();
  let tab = params.get('tab') || 'upcoming';
  let view = 'list';
  let month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
  const tabsEl = h('div.tabs');
  const bodyEl = h('div');
  let timer;

  const render = async () => {
    clearTimeout(timer);
    const [, , statuses, order] = TABS.find((t) => t[0] === tab);
    let url = `/api/posts?order=${order}&limit=300${statuses ? `&status=${statuses}` : ''}`;
    if (view === 'calendar') {
      const end = new Date(month); end.setMonth(end.getMonth() + 1);
      url = `/api/posts?order=asc&limit=500&from=${month.getTime() - 7 * 86400_000}&to=${end.getTime() + 7 * 86400_000}`;
    }
    const { posts, counts } = await GET(url);
    mount(tabsEl, TABS.map(([k, label]) => {
      const n = (COUNT_KEYS[k] || []).reduce((a, s) => a + (counts[s] || 0), 0);
      return h(`button${k === tab && view === 'list' ? '.on' : ''}`, { onclick: () => { tab = k; view = 'list'; history.replaceState(null, '', `#/queue?tab=${k}`); render(); } }, label, n ? h('span.n', n) : null);
    }));
    mount(bodyEl, view === 'calendar' ? calendar(posts) : listView(posts));
    if (posts.some((p) => ['waiting_media', 'rendering', 'publishing'].includes(p.status))) timer = setTimeout(render, 3000);
  };
  refreshQueue = render;

  const listView = (posts) => {
    if (!posts.length) return h('div.card', emptyState({ upcoming: 'Nothing in the queue', review: 'Nothing to review', published: 'Nothing published yet', failed: 'No failures 🎉', all: 'No posts yet' }[tab],
      tab === 'upcoming' ? 'New content from your workflows appears here while it renders and waits for its slot.' : ''));
    const groups = new Map();
    for (const p of posts) {
      const ts = p.published_at || p.scheduled_at || p.created_at;
      const key = new Date(ts).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    return h('div.card', [...groups].map(([day, ps]) => [h('div.day-head', day), ps.map(postRow)]));
  };

  const postRow = (p) => {
    const ts = p.status === 'published' ? p.published_at : p.scheduled_at;
    const working = ['waiting_media', 'rendering', 'publishing'].includes(p.status);
    return h('div.list-item.click', { onclick: () => openPost(p.id, render) },
      h('div.thumb', p.media?.thumb_url ? h('img', { src: p.media.thumb_url, alt: '' }) : icon(p.media?.kind === 'audio' ? 'audio' : 'play')),
      h('div.grow',
        h('div.ellipsis', { style: { fontWeight: 600 } }, p.title || p.media?.title || 'Untitled'),
        h('div.row.small.muted', pf(p.platform, p.color, 'sm'), h('span.ellipsis', `${p.platform_name} · ${p.connection?.label || p.connection?.account_name || ''}`), p.connection?.demo ? h('span.chip.warn', 'demo') : null,
          p.workflow ? h('span.ellipsis.tiny', `· ${p.workflow.name}`) : null),
        working ? h('div.progress', { class: p.progress == null ? 'indet' : '', style: { marginTop: '6px', maxWidth: '300px' } }, h('div', { style: { width: `${Math.round((p.progress || 0) * 100)}%` } })) : null,
        p.status === 'failed' || p.status === 'skipped' ? h('div.tiny.ellipsis', { style: { color: 'var(--err)' } }, p.error) : null),
      h('div.col', { style: { alignItems: 'flex-end', gap: '4px' } }, statusChip(p.status), h('span.tiny.faint', ts ? fmtDate(ts, { month: undefined, day: undefined }) : '')),
      p.status === 'needs_approval' ? h('button.btn.sm.primary', { onclick: (e) => { e.stopPropagation(); busy(async () => { await POST(`/api/posts/${p.id}/approve`, {}); toast('Approved', 'ok'); render(); })(e); } }, 'Approve') : null,
      p.status === 'failed' ? h('button.btn.sm', { onclick: (e) => { e.stopPropagation(); busy(async () => { await POST(`/api/posts/${p.id}/retry`); toast('Retrying'); render(); })(e); } }, 'Retry') : null);
  };

  const calendar = (posts) => {
    const start = new Date(month); start.setDate(1 - start.getDay());
    const byDay = new Map();
    for (const p of posts) {
      const ts = p.published_at || p.scheduled_at; if (!ts) continue;
      const k = new Date(ts).toDateString();
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(p);
    }
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const ps = byDay.get(d.toDateString()) || [];
      cells.push(h(`div.day${d.getMonth() !== month.getMonth() ? '.other' : ''}${d.toDateString() === new Date().toDateString() ? '.today' : ''}`,
        h('span.num', d.getDate()),
        ps.slice(0, 4).map((p) => h('div.ev', { title: `${p.platform_name}: ${p.title}`, onclick: () => openPost(p.id, render) }, pf(p.platform, p.color, 'sm'),
          h('span.t.ellipsis', `${new Date(p.published_at || p.scheduled_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} ${p.title || ''}`))),
        ps.length > 4 ? h('span.tiny.faint', `+${ps.length - 4} more`) : null));
    }
    const nav = (delta) => () => { month.setMonth(month.getMonth() + delta); render(); };
    return h('div.card',
      h('div.card-head', h('button.btn.sm', { onclick: nav(-1) }, '‹'), h('h2', month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })), h('button.btn.sm', { onclick: nav(1) }, '›'),
        h('span.right.small.muted', 'Scheduled and published posts')),
      h('div.cal', ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => h('div.dow', d)), cells));
  };

  mount(el,
    h('div.page-head', h('div', h('h1', 'Queue'), h('div.sub', 'Every post Recast is rendering, holding for review, scheduling or has published.')),
      h('div.right', seg([['list', 'List'], ['calendar', 'Calendar']], view, (v) => { view = v; render(); }))),
    tabsEl, bodyEl);
  await render();
  return () => { clearTimeout(timer); refreshQueue = null; };
}

export async function openPost(id, onChange) {
  const { post: p } = await GET(`/api/posts/${id}`);
  const changed = () => { onChange?.(); refreshQueue?.(); };
  const editable = !['published', 'publishing'].includes(p.status);
  const title = h('input', { type: 'text', value: p.title, disabled: !editable });
  const caption = h('textarea', { rows: 7, disabled: !editable, oninput: () => updCount() });
  caption.value = p.caption;
  const counter = h('div.counter');
  const updCount = () => {
    const n = [...caption.value].length;
    counter.textContent = p.limits.captionMax && p.limits.captionMax < 50000 ? `${n} / ${p.limits.captionMax}` : `${n} characters`;
    counter.classList.toggle('over', !!p.limits.captionMax && n > p.limits.captionMax);
  };
  updCount();
  const when = h('input', { type: 'datetime-local', value: toLocalInput(p.scheduled_at || Date.now() + 3600_000), disabled: !editable });

  const act = (label, fn, cls = '') => h(`button.btn${cls}`, { onclick: busy(async () => { await fn(); changed(); md.close(); }) }, label);
  const actions = [];
  if (p.status === 'needs_approval') {
    actions.push(act('Approve & schedule', async () => { await save(); await POST(`/api/posts/${p.id}/approve`, {}); toast('Approved', 'ok'); }, '.primary'));
    actions.push(act('Approve & publish now', async () => { await save(); await POST(`/api/posts/${p.id}/approve`, { publishNow: true }); toast('Publishing…', 'ok'); }));
  }
  if (p.status === 'scheduled') actions.push(act('Publish now', async () => { await save(); await POST(`/api/posts/${p.id}/publish-now`); toast('Publishing…', 'ok'); }, '.primary'));
  if (['failed', 'skipped', 'canceled'].includes(p.status)) actions.push(act('Retry', async () => { await save(); await POST(`/api/posts/${p.id}/retry`); toast('Retrying'); }, '.primary'));
  if (editable && p.has_output) actions.push(act('Re-render', async () => { await POST(`/api/posts/${p.id}/rerender`, {}); toast('Re-rendering'); }));
  if (editable && !['canceled', 'failed', 'skipped'].includes(p.status)) actions.push(act('Cancel post', async () => { await POST(`/api/posts/${p.id}/cancel`); toast('Canceled'); }, '.danger'));
  if (p.status !== 'publishing') actions.push(h('button.btn.ghost.danger', { onclick: busy(async () => {
    if (!(await confirmDialog('Delete post?', 'This removes it from Recast only. A published post stays on the platform.', { danger: true, okLabel: 'Delete' }))) return;
    await DEL(`/api/posts/${p.id}`); toast('Deleted'); changed(); md.close();
  }) }, icon('trash')));

  async function save() {
    if (!editable) return;
    const body = {};
    if (title.value !== p.title) body.title = title.value;
    if (caption.value !== p.caption) body.caption = caption.value;
    const ts = new Date(when.value).getTime();
    if (p.status === 'scheduled' && Math.abs(ts - p.scheduled_at) > 59_000) body.scheduledAt = ts;
    if (Object.keys(body).length) await PATCH(`/api/posts/${p.id}`, body);
  }

  const md = modal({
    title: h('span.row', pf(p.platform, p.color), `${p.platform_name} post`), wide: true,
    body: h('div.grid.cols-2',
      h('div.col',
        p.has_output ? h('video.player', { src: p.output_url, controls: true, playsinline: true, preload: 'metadata' })
          : h('div.callout', p.status === 'rendering' || p.status === 'waiting_media' ? 'Rendering — the preview appears when it is done.' : 'No rendered file.'),
        h('div.chips', statusChip(p.status), p.output_meta?.width ? h('span.chip', `${p.output_meta.width}×${p.output_meta.height}`) : null,
          p.output_meta?.duration ? h('span.chip', fmtDuration(p.output_meta.duration)) : null, p.connection?.demo ? h('span.chip.warn', 'Demo connection') : null),
        p.error ? h(`div.callout${p.status === 'failed' ? '.err' : ''}.small`, p.error) : null,
        p.external_url ? h('a.btn', { href: p.external_url, target: '_blank', rel: 'noopener' }, icon('link'), `View on ${p.platform_name}`) : null,
        p.has_output ? h('a.small', { href: `${p.output_url}&download=1` }, 'Download rendered video') : null),
      h('div.col',
        h('div.small.muted', `${p.connection?.label || p.connection?.account_name || ''}${p.workflow ? ` · from “${p.workflow.name}”` : ' · manual post'}`),
        p.limits.titleMax ? field('Title', title) : null,
        field('Caption', caption), counter,
        p.status === 'scheduled' ? field('Scheduled for', when) : h('div.small.muted',
          p.published_at ? `Published ${fmtDate(p.published_at)}` : p.scheduled_at ? `Scheduled ${fmtDate(p.scheduled_at)}` : `Created ${timeAgo(p.created_at)}`),
        editable ? h('button.btn.sm', { style: { alignSelf: 'flex-start' }, onclick: busy(async () => { await save(); toast('Saved', 'ok'); changed(); }) }, 'Save changes') : null)),
    foot: actions,
  });
}
