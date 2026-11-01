// In-browser stand-in for the Recast server, used only by the static demo build.
// Intercepts fetch/XHR calls to /api/* and simulates the job pipeline
// (download → render → review → schedule → publish) with sample data.
import CONNECTORS from './connectors.json';
import { SAMPLES } from './samples.js';
import { buildPostText } from '../server/lib/templates.js';
import { computeScheduledAt } from '../server/lib/schedule.js';
import { checkTextFilters } from '../server/lib/filters.js';
import { parseCaptions } from '../server/media/captions.js';

const KEY = 'recast-demo-state-v1';
const DAY = 86400_000;
const now = () => Date.now();
const meta = (id) => CONNECTORS.find((c) => c.id === id);
const clone = (o) => JSON.parse(JSON.stringify(o));
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const nf = (m = 'Not found') => new HttpError(404, m);

// ---------------------------------------------------------------- seed data
function seed() {
  const t = now();
  const s = { nextId: 1000, signedIn: true, user: { id: 1, email: 'maya@fieldnoteskitchen.example', name: 'Maya Ortiz', timezone: TZ, created_at: t - 40 * DAY }, connections: [], media: [], workflows: [], posts: [], brandKits: [], activity: [], pollCursor: 0 };
  const conn = (id, platform, account_name, extra = {}) => s.connections.push({ id, platform, label: '', account_name, account_id: String(id), avatar_url: '', config: {}, demo: false, status: 'active', status_message: '', last_polled_at: t - 4 * 60_000, created_at: t - 30 * DAY, ...extra });
  conn(1, 'upload', 'Uploads & URL imports', { label: 'Library uploads', last_polled_at: null });
  conn(2, 'tiktok', '@fieldnoteskitchen');
  conn(3, 'youtube', 'Field Notes Kitchen');
  conn(4, 'instagram', '@fieldnoteskitchen');
  conn(5, 'facebook', 'Field Notes Kitchen');
  conn(6, 'linkedin', 'Maya Ortiz');
  conn(7, 'rss', 'Field Notes Kitchen Podcast', { config: { feedUrl: 'https://feeds.example.com/fieldnotes.xml' } });
  conn(8, 'x', '@fieldnotesktchn');
  conn(9, 'folder', 'archive', { config: { path: 'archive' } });

  s.brandKits.push({ id: 1, name: 'Field Notes', logo_url: 'media/logo.png', logo_position: 'top-right', logo_scale: 0.26, logo_opacity: 0.95, watermark_text: '@fieldnoteskitchen', caption_style: { size: 'l', color: '#ffffff', outline: '#000000', position: 'bottom', box: false }, accent_color: '#d9542b', intro_media_id: null, outro_media_id: null });

  const dest = (id, connectionId, transform, schedule, options = {}) => {
    const m = meta(s.connections.find((c) => c.id === connectionId).platform);
    return { id, connectionId, brandKitId: 1, transform: { normalizeAudio: true, ...m.defaultTransform, ...transform }, titleTemplate: m.defaultTemplates.title, captionTemplate: m.defaultTemplates.caption, schedule, options };
  };
  s.workflows.push(
    { id: 1, name: 'TikTok → Shorts, Reels & Facebook', enabled: true, sourceConnectionId: 2, filters: { excludeKeywords: 'sponsored' }, cutoffAt: t - 20 * DAY, createdAt: t - 20 * DAY, updatedAt: t - 20 * DAY,
      destinations: [dest(11, 3, { aspect: '9:16', cutEnd: 3 }, { mode: 'slots', days: [1, 2, 3, 4, 5], times: ['09:00', '17:30'] }, { addHashtags: '#shorts' }), dest(12, 4, { aspect: '9:16', cutEnd: 3 }, { mode: 'immediate' }), dest(13, 5, { aspect: '9:16', cutEnd: 3 }, { mode: 'delay', minutes: 30 })] },
    { id: 2, name: 'Podcast episodes → audiograms', enabled: true, sourceConnectionId: 7, filters: {}, cutoffAt: t - 20 * DAY, createdAt: t - 20 * DAY, updatedAt: t - 20 * DAY,
      destinations: [dest(21, 3, { aspect: '9:16' }, { mode: 'immediate' }), dest(22, 6, { aspect: '1:1' }, { mode: 'immediate' }, { requireApproval: true }), dest(23, 8, { aspect: '1:1' }, { mode: 'immediate' })] },
    { id: 3, name: 'Library uploads → LinkedIn & X', enabled: true, sourceConnectionId: 1, filters: {}, cutoffAt: t - 20 * DAY, createdAt: t - 15 * DAY, updatedAt: t - 15 * DAY,
      destinations: [dest(31, 6, { aspect: 'original' }, { mode: 'immediate' }), dest(32, 8, { aspect: 'original' }, { mode: 'immediate' })] },
  );

  const srcConn = { tiktok: 2, youtube: 1, rss: 7 };
  let pid = 100;
  for (const [i, x] of SAMPLES.entries()) {
    const created = t - x.ago * DAY;
    s.media.push(sampleMedia(i + 1, x, srcConn[x.source], created));
  }
  // Post outcomes per sample, so the dashboard/queue/calendar start with realistic history.
  const plan = {
    focaccia: { 11: 'published', 12: 'published', 13: 'published' },
    pan: { 11: 'published', 12: 'published', 13: 'published' },
    onion: { 11: 'published', 12: 'published', 13: 'failed' },
    prep: { 31: 'published', 32: 'published' },
    podcast: { 21: 'published', 22: 'needs_approval', 23: 'published' },
    chickpeas: { 11: 'scheduled', 12: 'rendering', 13: 'scheduled' },
  };
  for (const m of s.media) {
    const wf = s.workflows.find((w) => w.sourceConnectionId === m.connection_id);
    for (const d of wf.destinations) {
      const status = plan[m.key]?.[d.id];
      if (!status) continue;
      const p = makePost(s, pid++, m, wf, d);
      p.created_at = m.created_at + 60_000;
      p.status = status;
      if (status !== 'rendering') finishRender(p, m, s);
      if (status === 'published') { p.published_at = m.created_at + (d.schedule.mode === 'delay' ? 31 : d.schedule.mode === 'slots' ? 300 : 3) * 60_000; p.scheduled_at = p.published_at; p.external_id = `sim_${p.id}`; }
      if (status === 'scheduled') p.scheduled_at = d.schedule.mode === 'delay' ? t + 22 * 60_000 : computeScheduledAt(d.schedule, { tz: TZ });
      if (status === 'scheduled' || status === 'needs_approval') p.published_at = null;
      if (status === 'failed') { p.error = 'Facebook: (#100) The Page access token has expired. Reconnect this account and retry.'; p.attempts = 4; }
      if (status === 'rendering') p.progress = 0.15;
      s.posts.push(p);
    }
  }
  const act = (msg, ago, level = 'info') => s.activity.push({ id: s.activity.length + 1, level, message: msg, created_at: t - ago });
  act('Connected TikTok: @fieldnoteskitchen', 30 * DAY); act('Connected YouTube: Field Notes Kitchen', 30 * DAY); act('Created workflow “TikTok → Shorts, Reels & Facebook”', 20 * DAY);
  for (const p of [...s.posts].sort((a, b) => (a.published_at || a.created_at) - (b.published_at || b.created_at))) {
    const m = s.media.find((x) => x.id === p.media_id);
    const c = s.connections.find((x) => x.id === p.connection_id);
    if (p.status === 'published') act(`Published “${m.title}” to ${meta(c.platform).name} (${c.account_name})`, t - p.published_at, 'success');
    if (p.status === 'failed') act(`Publishing post #${p.id} failed: ${p.error}`, t - p.created_at - 90_000, 'error');
    if (p.status === 'needs_approval') act(`“${m.title}” is ready for review (LinkedIn)`, t - p.created_at - 60_000);
  }
  act('Found 1 new item on @fieldnoteskitchen', 0.3 * DAY);
  s.activity.sort((a, b) => a.created_at - b.created_at).forEach((a, i) => { a.id = i + 1; });
  s.nextId = 2000;
  return s;
}

function sampleMedia(id, x, connectionId, created) {
  const audio = x.kind === 'audio';
  return {
    id, key: x.key, user_id: 1, connection_id: connectionId, source_ref: `${x.key}-${id}`, title: x.title, description: x.description,
    source_url: '', kind: audio ? 'audio' : 'video', status: 'ready', error: '', duration: audio ? 2712 : x.key === 'prep' ? 612 : 38 + id * 7,
    width: audio ? 0 : x.portrait ? 1080 : 1920, height: audio ? 0 : x.portrait ? 1920 : 1080, size: audio ? 43_900_000 : 18_000_000 + id * 2_100_000, has_audio: true,
    has_captions: !audio, file_url: `media/${x.key}-src.${audio ? 'mp3' : 'mp4'}`, thumb_url: audio ? '' : `media/${x.key}-thumb.jpg`,
    renders: x.renders, portrait: !!x.portrait, source_published_at: created, created_at: created,
  };
}

function makePost(s, id, m, wf, d) {
  const c = s.connections.find((x) => x.id === d.connectionId);
  return {
    id, user_id: 1, workflow_id: wf ? wf.id : null, destination_id: d.id ?? null, media_id: m.id, connection_id: c.id, platform: c.platform,
    status: m.status === 'ready' ? 'rendering' : 'waiting_media', title: '', caption: '', transform: clone(d.transform), brand_kit_id: d.brandKitId,
    schedule: clone(d.schedule), options: { ...clone(d.options || {}), titleTemplate: d.titleTemplate, captionTemplate: d.captionTemplate, mediaFilters: wf?.filters },
    output_url: '', output_meta: {}, scheduled_at: null, published_at: null, external_id: '', external_url: '', error: '', attempts: 0, progress: null, created_at: now(), updated_at: now(),
  };
}

function outputFor(m, transform) {
  const dims = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] };
  let aspect = transform.aspect;
  if (!dims[aspect]) aspect = m.kind === 'audio' ? '1:1' : m.portrait || m.height > m.width ? '9:16' : '16:9';
  const [w, h] = dims[aspect];
  if (m.file_url?.startsWith('blob:')) return { url: m.file_url, meta: { width: w, height: h, duration: Math.min(m.duration || 30, transform.maxDuration || Infinity) } };
  const have = m.renders || [];
  const pick = have.includes(aspect) ? aspect : aspect === '4:5' && have.includes('1:1') ? '1:1' : aspect === '16:9' && !have.includes('16:9') ? '1:1' : have[0];
  return { url: `media/${m.key}-${pick.replace(':', 'x')}.mp4`, meta: { width: w, height: h, duration: Math.min(m.duration, transform.maxDuration || Infinity) } };
}

function finishRender(p, m, s = state) {
  const c = s.connections.find((x) => x.id === p.connection_id);
  const cm = meta(p.platform);
  const transform = { ...p.transform };
  if (cm.limits?.maxDuration && (!transform.maxDuration || transform.maxDuration > cm.limits.maxDuration)) transform.maxDuration = cm.limits.maxDuration;
  const out = outputFor(m, transform);
  p.output_url = out.url;
  p.output_meta = { ...out.meta, duration: Math.max(1, out.meta.duration - (Number(transform.cutEnd) || 0)) };
  const gen = buildPostText(m, { title_template: p.options.titleTemplate ?? cm.defaultTemplates?.title, caption_template: p.options.captionTemplate ?? cm.defaultTemplates?.caption, options: p.options }, { platform: cm.name, account: c?.account_name || '' }, cm.limits || {});
  const locked = p.options.textLocked;
  p.title = locked && p.title ? p.title : gen.title;
  p.caption = locked && p.caption ? p.caption : gen.caption;
  p.progress = null;
}

// ---------------------------------------------------------------- state
let state;
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // Files uploaded in a previous visit lived in browser memory and are gone now.
      const dead = new Set(s.media.filter((m) => m.file_url?.startsWith('blob:')).map((m) => m.id));
      s.media = s.media.filter((m) => !dead.has(m.id));
      s.posts = s.posts.filter((p) => !dead.has(p.media_id));
      for (const b of s.brandKits) if (b.logo_url?.startsWith('blob:')) b.logo_url = '';
      return s;
    }
  } catch { /* storage unavailable */ }
  return null;
}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ } }, 200);
}
state = load() || seed();
export function resetDemo() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } state = seed(); save(); }

const id = () => ++state.nextId;
const log = (message, level = 'info') => { state.activity.push({ id: (state.activity.at(-1)?.id || 0) + 1, level, message, created_at: now() }); };
const connOf = (cid) => { const c = state.connections.find((x) => x.id === Number(cid)); if (!c) throw nf('Connection not found'); return c; };
const mediaOf = (mid) => { const m = state.media.find((x) => x.id === Number(mid)); if (!m) throw nf('Media not found'); return m; };
const postOf = (pid) => { const p = state.posts.find((x) => x.id === Number(pid)); if (!p) throw nf('Post not found'); return p; };
const wfOf = (wid) => { const w = state.workflows.find((x) => x.id === Number(wid)); if (!w) throw nf('Workflow not found'); return w; };
const kitOf = (kid) => { const k = state.brandKits.find((x) => x.id === Number(kid)); if (!k) throw nf('Brand kit not found'); return k; };

// ---------------------------------------------------------------- serializers (same shapes as the real API)
function pubConnection(c) {
  const m = meta(c.platform);
  return { ...clone(c), platform_name: m.name, color: m.color, roles: m.roles, system: !!m.system,
    workflow_count: state.workflows.filter((w) => w.sourceConnectionId === c.id || w.destinations.some((d) => d.connectionId === c.id)).length };
}
function pubMedia(m) { return { ...clone(m) }; }
function pubPost(p) {
  const m = state.media.find((x) => x.id === p.media_id);
  const c = state.connections.find((x) => x.id === p.connection_id);
  const w = state.workflows.find((x) => x.id === p.workflow_id);
  const cm = meta(p.platform);
  return { ...clone(p), platform_name: cm.name, color: cm.color, has_output: !!p.output_url, limits: cm.limits || {},
    media: m && { id: m.id, title: m.title, kind: m.kind, thumb_url: m.thumb_url }, connection: c && { id: c.id, account_name: c.account_name, label: c.label, demo: false },
    workflow: w ? { id: w.id, name: w.name } : null };
}
function pubWorkflow(w) {
  const src = state.connections.find((c) => c.id === w.sourceConnectionId);
  const posts = state.posts.filter((p) => p.workflow_id === w.id);
  const cnt = (f) => posts.filter(f).length;
  return { ...clone(w),
    source: src && { id: src.id, platform: src.platform, account_name: src.account_name, label: src.label, demo: false, last_polled_at: src.last_polled_at, status: src.status, status_message: src.status_message },
    destinations: w.destinations.map((d) => { const c = state.connections.find((x) => x.id === d.connectionId); return { ...clone(d), connection: c && { id: c.id, platform: c.platform, account_name: c.account_name, label: c.label, demo: false, status: c.status } }; }),
    stats: { total: posts.length, published: cnt((p) => p.status === 'published'), failed: cnt((p) => p.status === 'failed'), pending: cnt((p) => ['waiting_media', 'rendering', 'scheduled', 'publishing'].includes(p.status)), review: cnt((p) => p.status === 'needs_approval'), lastPublished: Math.max(0, ...posts.map((p) => p.published_at || 0)) || null } };
}
function pubKit(k) {
  const mm = (mid) => { const m = state.media.find((x) => x.id === mid); return m && { id: m.id, title: m.title, duration: m.duration, thumb_url: m.thumb_url }; };
  return { ...clone(k), intro: mm(k.intro_media_id), outro: mm(k.outro_media_id) };
}

// ---------------------------------------------------------------- pipeline simulation
function dispatch(m, workflows) {
  let n = 0;
  for (const w of workflows) {
    const reason = checkTextFilters(w.filters || {}, m);
    if (reason) { log(`Workflow “${w.name}” skipped “${m.title}”: ${reason}`); continue; }
    for (const d of w.destinations) {
      if (state.posts.some((p) => p.destination_id === d.id && p.media_id === m.id)) continue;
      state.posts.push(makePost(state, id(), m, w, d)); n++;
    }
  }
  return n;
}

function schedule(p, at) {
  const taken = new Set(state.posts.filter((x) => x.connection_id === p.connection_id && x.id !== p.id && ['scheduled', 'publishing', 'published'].includes(x.status)).map((x) => x.scheduled_at));
  p.scheduled_at = at ?? computeScheduledAt(p.schedule, { tz: state.user.timezone, taken });
  p.status = 'scheduled'; p.error = ''; p.updated_at = now();
}

function discoverNewItem(c) {
  // Demo sources "find" another sample each time they are checked.
  const pool = SAMPLES.filter((x) => (c.platform === 'rss' ? x.kind === 'audio' : x.kind !== 'audio'));
  const x = pool[state.pollCursor++ % pool.length];
  const m = sampleMedia(id(), x, c.id, now());
  m.title = x.kind === 'audio' ? `Ep. ${42 + state.pollCursor}: ${['Salt, fat, acid at home', 'Stocking a small pantry', 'Cooking for one without waste'][state.pollCursor % 3]}` : `${x.title.split('#')[0].trim()} (part ${state.pollCursor + 1}) #${x.key}`;
  m.status = 'downloading';
  m._readyAt = now() + 2500;
  state.media.push(m);
  log(`Found 1 new item on ${c.account_name}`);
  dispatch(m, state.workflows.filter((w) => w.enabled && w.sourceConnectionId === c.id));
}

function tick() {
  const t = now();
  let changed = false;
  for (const c of state.connections) if (c._pollAt && c._pollAt <= t) { delete c._pollAt; c.last_polled_at = t; discoverNewItem(c); changed = true; }
  for (const m of state.media) {
    if (['queued', 'downloading', 'uploading'].includes(m.status) && m._readyAt && m._readyAt <= t) { m.status = 'ready'; delete m._readyAt; changed = true; }
  }
  for (const p of state.posts) {
    const m = state.media.find((x) => x.id === p.media_id);
    if (p.status === 'waiting_media' && m?.status === 'ready') { p.status = 'rendering'; p.progress = 0; changed = true; }
    else if (p.status === 'rendering') {
      p.progress = Math.min(1, (p.progress || 0) + 0.2 + Math.random() * 0.1); changed = true;
      if (p.progress >= 1) {
        finishRender(p, m);
        if (p.options.requireApproval) { p.status = 'needs_approval'; log(`“${m.title}” is ready for review (${meta(p.platform).name})`); }
        else schedule(p);
      }
    } else if (p.status === 'scheduled' && p.scheduled_at <= t) { p.status = 'publishing'; p._doneAt = t + 1500; changed = true; }
    else if (p.status === 'publishing' && p._doneAt <= t) {
      delete p._doneAt; p.status = 'published'; p.published_at = t; p.external_id = `sim_${p.id}`; p.attempts++; p.error = ''; changed = true;
      const c = state.connections.find((x) => x.id === p.connection_id);
      log(`Published “${p.title || m?.title}” to ${meta(p.platform).name} (${c?.account_name})`, 'success');
    }
  }
  if (changed) save();
}
setInterval(tick, 1000);

// ---------------------------------------------------------------- routes
const routes = [];
const on = (method, pattern, fn) => routes.push([method, new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn]);
const auth = () => { if (!state.signedIn) throw new HttpError(401, 'Please sign in'); };

on('GET', '/api/auth/me', () => ({ user: state.signedIn ? state.user : null }));
on('POST', '/api/auth/login', ({ body }) => { if (!body.email || !body.password) throw new HttpError(401, 'Incorrect email or password'); state.signedIn = true; return { user: state.user }; });
on('POST', '/api/auth/signup', ({ body }) => {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email || '')) throw bad('Enter a valid email address');
  if ((body.password || '').length < 8) throw bad('Password must be at least 8 characters');
  state.signedIn = true; if (body.name) state.user.name = body.name; state.user.email = body.email; return { user: state.user };
});
on('POST', '/api/auth/logout', () => { state.signedIn = false; return { ok: true }; });
on('PATCH', '/api/auth/me', ({ body }) => { auth(); if (body.name !== undefined) state.user.name = body.name; if (body.timezone) state.user.timezone = body.timezone; return { user: state.user }; });
on('POST', '/api/auth/password', ({ body }) => { auth(); if ((body.next || '').length < 8) throw bad('New password must be at least 8 characters'); return { ok: true }; });
on('DELETE', '/api/auth/me', () => { resetDemo(); state.signedIn = false; return { ok: true }; });

on('GET', '/api/connectors', () => ({ connectors: CONNECTORS }));
on('GET', '/api/connections', () => { auth(); return { connections: state.connections.map(pubConnection) }; });
on('POST', '/api/connections', ({ body }) => {
  auth();
  const m = meta(body.platform);
  if (!m || m.system) throw bad('Unknown platform');
  let account = `Demo ${m.name}`;
  if (!body.demo) {
    for (const f of m.fields || []) if (f.required && !String(body.config?.[f.key] || '').trim()) throw bad(`${f.label} is required`);
    const v = body.config?.path || body.config?.feedUrl || body.config?.profileUrl || body.config?.url || m.name;
    try { account = /^https?:/.test(v) ? new URL(v).host + new URL(v).pathname.replace(/\/$/, '') : v; } catch { throw bad('Enter a valid URL'); }
  }
  const c = { id: id(), platform: m.id, label: body.label || '', account_name: account, account_id: '', avatar_url: '', config: body.config || {}, demo: false, status: 'active', status_message: '', last_polled_at: null, created_at: now() };
  state.connections.push(c); log(`Connected ${m.name}: ${account}`);
  return { connection: pubConnection(c) };
});
on('PATCH', '/api/connections/:id', ({ p, body }) => { auth(); const c = connOf(p.id); if (body.label !== undefined) c.label = body.label; if (body.status) c.status = body.status; if (body.config) Object.assign(c.config, body.config); return { connection: pubConnection(c) }; });
on('DELETE', '/api/connections/:id', ({ p }) => {
  auth(); const c = connOf(p.id); if (c.platform === 'upload') throw bad('The library connection cannot be removed');
  state.connections = state.connections.filter((x) => x !== c);
  state.workflows = state.workflows.filter((w) => w.sourceConnectionId !== c.id);
  for (const w of state.workflows) w.destinations = w.destinations.filter((d) => d.connectionId !== c.id);
  state.posts = state.posts.filter((x) => x.connection_id !== c.id);
  return { ok: true };
});
on('POST', '/api/connections/:id/test', ({ p }) => { auth(); const c = connOf(p.id); const m = meta(c.platform); return { ok: true, message: `Connection works.${m.roles.source && !m.system ? ' Found 12 items at the source.' : ''} (simulated)` }; });
on('POST', '/api/connections/:id/poll', ({ p }) => { auth(); connOf(p.id)._pollAt = now() + 1500; return { ok: true }; });
on('GET', '/api/oauth/:platform/start', ({ p }) => { throw bad(`Signing in to ${meta(p.platform)?.name || p.platform} isn't available in this demo. Use “Add demo” instead; on your own Recast server this opens the platform's sign-in page.`); });

on('GET', '/api/media', ({ q }) => {
  auth();
  let list = state.media.filter((m) => (!q.get('status') || m.status === q.get('status')) && (!q.get('connection') || m.connection_id === Number(q.get('connection'))) && (!q.get('kind') || m.kind === q.get('kind')));
  if (q.get('q')) { const s = q.get('q').toLowerCase(); list = list.filter((m) => `${m.title} ${m.description}`.toLowerCase().includes(s)); }
  list.sort((a, b) => (b.source_published_at || b.created_at) - (a.source_published_at || a.created_at));
  return { media: list.slice(0, Number(q.get('limit')) || 60).map(pubMedia), total: list.length };
});
on('GET', '/api/media/:id', ({ p }) => {
  auth(); const m = mediaOf(p.id);
  return { media: pubMedia(m), posts: state.posts.filter((x) => x.media_id === m.id).sort((a, b) => b.id - a.id).map((x) => ({ id: x.id, platform: x.platform, status: x.status, scheduled_at: x.scheduled_at, published_at: x.published_at, external_url: '', connection_id: x.connection_id, error: x.error })) };
});
on('POST', '/api/media/import', ({ body }) => {
  auth();
  try { new URL(body.url); } catch { throw bad('Enter a valid URL'); }
  const x = SAMPLES[3];
  const m = sampleMedia(id(), x, 1, now());
  Object.assign(m, { title: body.title || body.url, source_url: body.url, status: 'downloading', _readyAt: now() + 3000 });
  state.media.push(m);
  dispatch(m, state.workflows.filter((w) => w.enabled && w.sourceConnectionId === 1));
  return { media: pubMedia(m) };
});
on('PATCH', '/api/media/:id', ({ p, body }) => { auth(); const m = mediaOf(p.id); if (body.title !== undefined) m.title = body.title; if (body.description !== undefined) m.description = body.description; return { media: pubMedia(m) }; });
on('DELETE', '/api/media/:id', ({ p }) => { auth(); const m = mediaOf(p.id); state.media = state.media.filter((x) => x !== m); state.posts = state.posts.filter((x) => x.media_id !== m.id); return { ok: true }; });
on('POST', '/api/media/:id/download', ({ p }) => { auth(); const m = mediaOf(p.id); m.status = 'downloading'; m._readyAt = now() + 2500; return { ok: true }; });
on('PUT', '/api/media/:id/captions', ({ p, raw }) => { auth(); const m = mediaOf(p.id); const cues = parseCaptions(String(raw || '')); if (!cues.length) throw bad('No caption cues found — upload an .srt or .vtt file'); m.has_captions = true; m._cues = cues; return { cues: cues.length }; });
on('GET', '/api/media/:id/captions', ({ p }) => { auth(); const m = mediaOf(p.id); return { cues: m._cues || (m.has_captions ? [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}] : []) }; });
on('DELETE', '/api/media/:id/captions', ({ p }) => { auth(); const m = mediaOf(p.id); m.has_captions = false; delete m._cues; return { ok: true }; });
on('POST', '/api/media/:id/publish', ({ p, body }) => {
  auth(); const m = mediaOf(p.id);
  if (!body.destinations?.length) throw bad('Pick at least one destination');
  const ids = body.destinations.map((d) => {
    const c = connOf(d.connectionId); const cm = meta(c.platform);
    const post = makePost(state, id(), m, null, { connectionId: c.id, brandKitId: d.brandKitId, transform: { ...cm.defaultTransform, ...d.transform }, schedule: d.schedule || { mode: 'immediate' }, options: { textLocked: d.title != null || d.caption != null }, titleTemplate: cm.defaultTemplates.title, captionTemplate: cm.defaultTemplates.caption });
    post.title = d.title || ''; post.caption = d.caption || '';
    state.posts.push(post); return post.id;
  });
  log(`Queued “${m.title}” for ${ids.length} destination${ids.length > 1 ? 's' : ''}`);
  return { posts: ids };
});
on('POST', '/api/media/:id/preview', async ({ p, body }) => { auth(); const m = mediaOf(p.id); await new Promise((r) => setTimeout(r, 1200)); return { url: outputFor(m, body.transform || {}).url }; });

on('GET', '/api/workflows', () => { auth(); return { workflows: [...state.workflows].sort((a, b) => b.createdAt - a.createdAt).map(pubWorkflow) }; });
on('GET', '/api/workflows/:id', ({ p }) => { auth(); return { workflow: pubWorkflow(wfOf(p.id)) }; });
function validateWf(body) {
  if (!String(body.name || '').trim()) throw bad('Give the workflow a name');
  const src = connOf(body.sourceConnectionId);
  if (!meta(src.platform).roles.source) throw bad(`${meta(src.platform).name} cannot be used as a source`);
  if (!body.destinations?.length) throw bad('Add at least one destination');
  for (const d of body.destinations) {
    connOf(d.connectionId);
    if (d.connectionId === src.id) throw bad('A destination cannot be the same account as the source');
    if (d.schedule?.mode === 'slots' && !(d.schedule.times || []).length) throw bad('Add at least one time slot');
  }
}
on('POST', '/api/workflows', ({ body }) => {
  auth(); validateWf(body);
  const w = { id: id(), name: body.name.trim(), enabled: body.enabled !== false, sourceConnectionId: Number(body.sourceConnectionId), filters: body.filters || {}, cutoffAt: now(), createdAt: now(), updatedAt: now(),
    destinations: body.destinations.map((d) => ({ ...d, id: id() })) };
  state.workflows.push(w); log(`Created workflow “${w.name}”`);
  return { workflow: pubWorkflow(w) };
});
on('PUT', '/api/workflows/:id', ({ p, body }) => {
  auth(); const w = wfOf(p.id); validateWf(body);
  Object.assign(w, { name: body.name.trim(), enabled: body.enabled !== false, sourceConnectionId: Number(body.sourceConnectionId), filters: body.filters || {}, updatedAt: now(),
    destinations: body.destinations.map((d) => ({ ...d, id: d.id || id() })) });
  return { workflow: pubWorkflow(w) };
});
on('PATCH', '/api/workflows/:id', ({ p, body }) => { auth(); const w = wfOf(p.id); if (body.enabled !== undefined) w.enabled = !!body.enabled; if (body.name) w.name = body.name; return { workflow: pubWorkflow(w) }; });
on('DELETE', '/api/workflows/:id', ({ p }) => {
  auth(); const w = wfOf(p.id);
  for (const x of state.posts) if (x.workflow_id === w.id && ['waiting_media', 'rendering', 'scheduled', 'needs_approval'].includes(x.status)) x.status = 'canceled';
  state.workflows = state.workflows.filter((x) => x !== w); return { ok: true };
});
on('POST', '/api/workflows/:id/run', ({ p }) => {
  auth(); const w = wfOf(p.id); const c = connOf(w.sourceConnectionId);
  if (c.platform === 'upload') return { ok: true, message: 'This workflow runs automatically whenever you upload or import to the Library.' };
  c._pollAt = now() + 1500; return { ok: true, message: 'Checking the source for new content…' };
});
on('POST', '/api/workflows/:id/backfill', ({ p, body }) => {
  auth(); const w = wfOf(p.id);
  const done = new Set(state.posts.filter((x) => x.workflow_id === w.id).map((x) => x.media_id));
  const items = state.media.filter((m) => m.connection_id === w.sourceConnectionId && !done.has(m.id)).sort((a, b) => b.created_at - a.created_at).slice(0, Math.min(50, Number(body.count) || 5));
  let posts = 0;
  for (const m of items) posts += dispatch(m, [w]);
  return { items: items.length, posts };
});

on('GET', '/api/posts', ({ q }) => {
  auth();
  let list = state.posts;
  if (q.get('status')) { const s = q.get('status').split(','); list = list.filter((x) => s.includes(x.status)); }
  for (const [k, f] of [['workflow', 'workflow_id'], ['media', 'media_id']]) if (q.get(k)) list = list.filter((x) => x[f] === Number(q.get(k)));
  if (q.get('platform')) list = list.filter((x) => x.platform === q.get('platform'));
  const ts = (x) => x.published_at || x.scheduled_at || x.created_at;
  if (q.get('from')) list = list.filter((x) => ts(x) >= Number(q.get('from')));
  if (q.get('to')) list = list.filter((x) => ts(x) < Number(q.get('to')));
  const dir = q.get('order') === 'asc' ? 1 : -1;
  list = [...list].sort((a, b) => dir * (ts(a) - ts(b) || a.id - b.id));
  const counts = {};
  for (const x of state.posts) counts[x.status] = (counts[x.status] || 0) + 1;
  return { posts: list.slice(0, Number(q.get('limit')) || 100).map(pubPost), counts };
});
on('GET', '/api/posts/:id', ({ p }) => { auth(); return { post: pubPost(postOf(p.id)) }; });
on('PATCH', '/api/posts/:id', ({ p, body }) => {
  auth(); const x = postOf(p.id);
  if (['published', 'publishing'].includes(x.status)) throw bad('This post has already been published');
  const lim = meta(x.platform).limits || {};
  if (body.title !== undefined) { x.title = body.title; x.options.textLocked = true; }
  if (body.caption !== undefined) { if (lim.captionMax && [...body.caption].length > lim.captionMax) throw bad(`Caption is longer than ${lim.captionMax} characters`); x.caption = body.caption; x.options.textLocked = true; }
  if (body.scheduledAt !== undefined && x.status === 'scheduled') x.scheduled_at = Math.max(now(), Number(body.scheduledAt));
  x.updated_at = now(); return { post: pubPost(x) };
});
on('POST', '/api/posts/:id/approve', ({ p, body }) => { auth(); const x = postOf(p.id); if (x.status !== 'needs_approval') throw bad('Post is not waiting for approval'); schedule(x, body.publishNow ? now() : undefined); log(`Approved post #${x.id}`); return { post: pubPost(x) }; });
on('POST', '/api/posts/:id/publish-now', ({ p }) => { auth(); const x = postOf(p.id); if (!['scheduled', 'needs_approval'].includes(x.status)) throw bad('Only scheduled or pending-approval posts can be published now'); schedule(x, now()); return { post: pubPost(x) }; });
on('POST', '/api/posts/:id/retry', ({ p }) => {
  auth(); const x = postOf(p.id);
  if (!['failed', 'canceled', 'skipped'].includes(x.status)) throw bad('Only failed, skipped or canceled posts can be retried');
  if (x.platform === 'facebook') { const c = connOf(x.connection_id); c.status = 'active'; c.status_message = ''; }
  if (x.output_url) schedule(x, now()); else { x.status = 'rendering'; x.progress = 0; }
  return { post: pubPost(x) };
});
on('POST', '/api/posts/:id/rerender', ({ p, body }) => { auth(); const x = postOf(p.id); if (body.transform) Object.assign(x.transform, body.transform); x.status = 'rendering'; x.progress = 0; return { post: pubPost(x) }; });
on('POST', '/api/posts/:id/cancel', ({ p }) => { auth(); const x = postOf(p.id); if (['published', 'publishing'].includes(x.status)) throw bad('Already published'); x.status = 'canceled'; return { post: pubPost(x) }; });
on('DELETE', '/api/posts/:id', ({ p }) => { auth(); const x = postOf(p.id); state.posts = state.posts.filter((y) => y !== x); return { ok: true }; });

on('GET', '/api/brand-kits', () => { auth(); return { brandKits: state.brandKits.map(pubKit) }; });
on('POST', '/api/brand-kits', ({ body }) => { auth(); const k = { id: id(), name: body.name || 'New brand kit', logo_url: '', logo_position: 'top-right', logo_scale: 0.18, logo_opacity: 0.9, watermark_text: '', caption_style: { size: 'm', color: '#ffffff', outline: '#000000', position: 'bottom', box: false }, accent_color: '#7c5cff', intro_media_id: null, outro_media_id: null }; state.brandKits.push(k); return { brandKit: pubKit(k) }; });
on('PATCH', '/api/brand-kits/:id', ({ p, body }) => {
  auth(); const k = kitOf(p.id);
  if (body.name !== undefined && !String(body.name).trim()) throw bad('Name is required');
  if (body.accent_color && !/^#[0-9a-f]{6}$/i.test(body.accent_color)) throw bad('Accent color must be a hex color');
  for (const f of ['name', 'logo_position', 'logo_scale', 'logo_opacity', 'watermark_text', 'accent_color', 'caption_style', 'intro_media_id', 'outro_media_id']) if (body[f] !== undefined) k[f] = body[f];
  return { brandKit: pubKit(k) };
});
on('DELETE', '/api/brand-kits/:id', ({ p }) => { auth(); state.brandKits = state.brandKits.filter((k) => k.id !== Number(p.id)); return { ok: true }; });
on('DELETE', '/api/brand-kits/:id/logo', ({ p }) => { auth(); kitOf(p.id).logo_url = ''; return { brandKit: pubKit(kitOf(p.id)) }; });

on('GET', '/api/meta', () => ({
  system: { ffmpeg: 'ffmpeg version 6.1.1', ytdlp: '2025.09.26', font: 'Inter-Bold.otf', publicBaseUrl: 'https://recast.fieldnoteskitchen.example', publicUrlIsPublic: true, allowDemo: true, pollIntervalMinutes: 10, folderRoot: '/data/folders', maxUploadMb: 2048 },
  templateVars: ['title', 'description', 'hashtags', 'source_url', 'date', 'platform', 'account', 'first_line'], aspects: ['original', '9:16', '1:1', '4:5', '16:9'],
  queue: { pending: state.posts.filter((x) => ['rendering', 'scheduled'].includes(x.status)).length, running: state.posts.filter((x) => x.status === 'rendering').length, failed: 0 },
}));
on('GET', '/api/dashboard', () => {
  auth();
  const P = state.posts; const t = now();
  const c = (f) => P.filter(f).length;
  const counts = {
    published_week: c((x) => x.status === 'published' && x.published_at >= t - 7 * DAY), published_total: c((x) => x.status === 'published'),
    scheduled: c((x) => ['scheduled', 'publishing'].includes(x.status)), processing: c((x) => ['waiting_media', 'rendering'].includes(x.status)),
    review: c((x) => x.status === 'needs_approval'), failed: c((x) => x.status === 'failed'),
  };
  const start = new Date(); start.setUTCHours(0, 0, 0, 0); const st = start.getTime() - 13 * DAY;
  const series = Array.from({ length: 14 }, (_, i) => ({ day: new Date(st + i * DAY).toISOString().slice(0, 10), count: 0 }));
  for (const x of P) if (x.status === 'published' && x.published_at >= st) { const s = series[Math.floor((x.published_at - st) / DAY)]; if (s) s.count++; }
  const by = {};
  for (const x of P) if (x.status === 'published' && x.published_at >= t - 30 * DAY) by[x.platform] = (by[x.platform] || 0) + 1;
  const ord = (x) => x.scheduled_at || x.created_at;
  return {
    counts, series, byPlatform: Object.entries(by).map(([platform, n]) => ({ platform, n })).sort((a, b) => b.n - a.n),
    upcoming: P.filter((x) => ['scheduled', 'needs_approval', 'rendering', 'waiting_media', 'publishing'].includes(x.status)).sort((a, b) => ord(a) - ord(b)).slice(0, 8).map(pubPost),
    recent: P.filter((x) => ['published', 'failed'].includes(x.status)).sort((a, b) => (b.published_at || b.updated_at) - (a.published_at || a.updated_at)).slice(0, 8).map(pubPost),
    activity: [...state.activity].reverse().slice(0, 12),
    setup: { connections: state.connections.length - 1, workflows: state.workflows.length, media: state.media.length, brandLogo: state.brandKits.some((k) => k.logo_url) },
  };
});
on('GET', '/api/activity', ({ q }) => {
  auth();
  const before = Number(q.get('before')) || Infinity;
  return { activity: [...state.activity].reverse().filter((a) => a.id < before && (!q.get('level') || a.level === q.get('level'))).slice(0, 100) };
});

async function handle(method, url, raw) {
  const u = new URL(url, location.href);
  for (const [m, re, fn] of routes) {
    if (m !== method) continue;
    const match = u.pathname.match(re);
    if (!match) continue;
    let body = {};
    if (typeof raw === 'string' && raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
    const data = await fn({ p: match.groups || {}, q: u.searchParams, body, raw });
    save();
    return { status: method === 'POST' && /\/(connections|workflows|brand-kits)$/.test(u.pathname) ? 201 : 200, data };
  }
  throw nf(`No demo handler for ${method} ${u.pathname}`);
}

async function respond(method, url, raw) {
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 90)); // feel like a network call
  try { return await handle(method, url, raw); } catch (e) { return { status: e.status || 500, data: { error: e.message } }; }
}

// ---------------------------------------------------------------- fetch / XHR interception
const isApi = (url) => { try { return new URL(url, location.href).pathname.startsWith('/api/'); } catch { return false; } };
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!isApi(url)) return realFetch(input, init);
  const r = await respond((init.method || 'GET').toUpperCase(), url, init.body);
  return new Response(JSON.stringify(r.data), { status: r.status, headers: { 'Content-Type': 'application/json' } });
};

// Uploads go through XHR (for progress). Files stay in this browser as object URLs.
const RealXHR = window.XMLHttpRequest;
class DemoXHR {
  constructor() { this.upload = {}; this.headers = {}; this.status = 0; this.responseText = ''; }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  async send(file) {
    const total = file?.size || 1;
    for (let i = 1; i <= 10; i++) { await new Promise((r) => setTimeout(r, 120)); this.upload.onprogress?.({ lengthComputable: true, loaded: (total * i) / 10, total }); }
    let r;
    try { r = { status: 200, data: await this.handleUpload(file) }; } catch (e) { r = { status: e.status || 500, data: { error: e.message } }; }
    save();
    this.status = r.status; this.responseText = JSON.stringify(r.data); this.onload?.();
  }
  async handleUpload(file) {
    auth();
    const path = new URL(this.url, location.href).pathname;
    const logo = path.match(/^\/api\/brand-kits\/(\d+)\/logo$/);
    if (logo) {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw bad('Logo must be a PNG, JPG or WebP image');
      const k = kitOf(logo[1]); k.logo_url = URL.createObjectURL(file); return { brandKit: pubKit(k) };
    }
    if (path !== '/api/media/upload') throw nf();
    const name = decodeURIComponent(this.headers['x-filename'] || file.name || 'upload');
    if (!/\.(mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|aac|ogg)$/i.test(name)) throw bad('Unsupported file type. Upload a video (mp4, mov, webm, mkv) or audio (mp3, m4a, wav).');
    const audio = /^audio\//.test(file.type) || /\.(mp3|m4a|wav|aac|ogg)$/i.test(name);
    const url = URL.createObjectURL(file);
    const info = await probeInBrowser(url, audio);
    const m = { id: id(), key: 'upload', user_id: 1, connection_id: 1, source_ref: null, title: name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), description: '', source_url: '', kind: audio ? 'audio' : 'video', status: 'ready', error: '',
      duration: info.duration, width: info.width, height: info.height, size: file.size, has_audio: true, has_captions: false, file_url: url, thumb_url: info.thumb, renders: [], portrait: info.height > info.width, source_published_at: now(), created_at: now() };
    state.media.push(m);
    log(`Uploaded “${m.title}”`);
    if (this.headers['x-purpose'] !== 'brand') dispatch(m, state.workflows.filter((w) => w.enabled && w.sourceConnectionId === 1));
    return { media: pubMedia(m) };
  }
}
function probeInBrowser(url, audio) {
  return new Promise((resolve) => {
    const el = document.createElement(audio ? 'audio' : 'video');
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => done({ duration: 0, width: 0, height: 0, thumb: '' }), 5000);
    el.muted = true; el.preload = 'auto'; el.src = url;
    el.onloadedmetadata = () => {
      if (audio) return done({ duration: el.duration || 0, width: 0, height: 0, thumb: '' });
      el.currentTime = Math.min(1, (el.duration || 2) / 3);
    };
    el.onseeked = () => {
      let thumb = '';
      try { const c = document.createElement('canvas'); c.width = 480; c.height = Math.round((480 * el.videoHeight) / el.videoWidth) || 270; c.getContext('2d').drawImage(el, 0, 0, c.width, c.height); thumb = c.toDataURL('image/jpeg', 0.7); } catch { /* ignore */ }
      done({ duration: el.duration || 0, width: el.videoWidth, height: el.videoHeight, thumb });
    };
    el.onerror = () => done({ duration: 0, width: 0, height: 0, thumb: '' });
  });
}
window.XMLHttpRequest = function XHR() {
  const d = new DemoXHR();
  const real = new RealXHR();
  return new Proxy(d, {
    get(target, prop) {
      if (target.url === undefined && prop === 'open') return (m, u, ...rest) => { if (isApi(u)) return target.open(m, u); target.__real = true; return real.open(m, u, ...rest); };
      if (target.__real) { const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; }
      return target[prop];
    },
    set(target, prop, value) { if (target.__real) real[prop] = value; else target[prop] = value; return true; },
  });
};

// ---------------------------------------------------------------- demo banner
function banner() {
  const bar = document.createElement('div');
  bar.className = 'demo-banner';
  const text = document.createElement('span');
  text.textContent = 'Demo with sample data. Nothing is uploaded or posted, and changes are saved only in this browser.';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.textContent = 'Reset demo';
  btn.onclick = () => { resetDemo(); location.hash = '#/'; window.dispatchEvent(new HashChangeEvent('hashchange')); };
  bar.append(text, btn);
  document.body.prepend(bar);
}
if (document.body) banner(); else document.addEventListener('DOMContentLoaded', banner);
