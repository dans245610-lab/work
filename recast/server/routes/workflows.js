import { get, all, insert, update, run, now, parseJson, tx, logActivity } from '../db.js';
import { readJson, sendJson, bad, notFound } from '../lib/http.js';
import { requireUser } from '../auth.js';
import { getConnector } from '../connectors/index.js';
import { ownedConnection } from './connections.js';
import { enqueue } from '../jobs.js';
import { dispatchMedia, loadMedia, queueDownload } from '../pipeline.js';
import { ASPECTS } from '../media/ffmpeg.js';

const ownedWorkflow = (userId, id) => {
  const w = get('SELECT * FROM workflows WHERE id = ? AND user_id = ?', Number(id), userId);
  if (!w) throw notFound('Workflow not found');
  return w;
};

function serialize(w) {
  const src = get('SELECT * FROM connections WHERE id = ?', w.source_connection_id);
  const dests = all('SELECT * FROM destinations WHERE workflow_id = ? ORDER BY position, id', w.id).map((d) => {
    const c = get('SELECT id, platform, account_name, label, demo, status FROM connections WHERE id = ?', d.connection_id);
    return {
      id: d.id, connectionId: d.connection_id, connection: c, brandKitId: d.brand_kit_id, transform: parseJson(d.transform), titleTemplate: d.title_template,
      captionTemplate: d.caption_template, schedule: parseJson(d.schedule), options: parseJson(d.options),
    };
  });
  const stats = get(`SELECT COUNT(*) total, SUM(status='published') published, SUM(status='failed') failed,
    SUM(status IN ('waiting_media','rendering','scheduled','publishing')) pending, SUM(status='needs_approval') review, MAX(published_at) last_published
    FROM posts WHERE workflow_id = ?`, w.id);
  return {
    id: w.id, name: w.name, enabled: !!w.enabled, filters: parseJson(w.filters), cutoffAt: w.cutoff_at, createdAt: w.created_at, updatedAt: w.updated_at,
    sourceConnectionId: w.source_connection_id,
    source: src && { id: src.id, platform: src.platform, account_name: src.account_name, label: src.label, demo: !!src.demo, last_polled_at: src.last_polled_at, status: src.status, status_message: src.status_message },
    destinations: dests,
    stats: { total: stats.total || 0, published: stats.published || 0, failed: stats.failed || 0, pending: stats.pending || 0, review: stats.review || 0, lastPublished: stats.last_published },
  };
}

function validateDestination(userId, d) {
  const conn = ownedConnection(userId, d.connectionId);
  const meta = getConnector(conn.platform);
  if (!meta.roles.destination) throw bad(`${meta.name} cannot be used as a destination`);
  if (d.brandKitId && !get('SELECT id FROM brand_kits WHERE id = ? AND user_id = ?', Number(d.brandKitId), userId)) throw bad('Unknown brand kit');
  const t = { ...(meta.defaultTransform || {}), ...(d.transform || {}) };
  if (t.aspect && t.aspect !== 'original' && !ASPECTS[t.aspect]) throw bad(`Unknown aspect ratio ${t.aspect}`);
  if (t.fit && !['blur', 'crop', 'pad'].includes(t.fit)) throw bad('Fit must be blur, crop or pad');
  for (const k of ['trimStart', 'trimEnd', 'cutEnd', 'maxDuration']) if (t[k] != null && (Number.isNaN(Number(t[k])) || Number(t[k]) < 0)) throw bad(`${k} must be a positive number`);
  if (t.speed != null && (Number(t.speed) < 0.25 || Number(t.speed) > 4)) throw bad('Speed must be between 0.25 and 4');
  const s = d.schedule || { mode: 'immediate' };
  if (!['immediate', 'delay', 'slots'].includes(s.mode)) throw bad('Unknown schedule mode');
  if (s.mode === 'slots' && !(s.times || []).every((x) => /^\d{1,2}:\d{2}$/.test(x))) throw bad('Slot times must look like 09:30');
  if (s.mode === 'slots' && !(s.times || []).length) throw bad('Add at least one time slot');
  return {
    connection_id: conn.id, brand_kit_id: d.brandKitId ? Number(d.brandKitId) : null, transform: t,
    title_template: d.titleTemplate ?? meta.defaultTemplates?.title ?? '{{title}}',
    caption_template: d.captionTemplate ?? meta.defaultTemplates?.caption ?? '{{description}}',
    schedule: s, options: d.options || {},
  };
}

function validateWorkflow(userId, body) {
  if (!String(body.name || '').trim()) throw bad('Give the workflow a name');
  const src = ownedConnection(userId, body.sourceConnectionId);
  if (!getConnector(src.platform).roles.source) throw bad(`${getConnector(src.platform).name} cannot be used as a source`);
  if (!Array.isArray(body.destinations) || !body.destinations.length) throw bad('Add at least one destination');
  const dests = body.destinations.map((d) => ({ id: d.id, ...validateDestination(userId, d) }));
  if (dests.some((d) => d.connection_id === src.id)) throw bad('A destination cannot be the same account as the source');
  return { name: String(body.name).trim().slice(0, 120), source: src, filters: body.filters || {}, dests };
}

export default function register(r) {
  r.get('/api/workflows', async (req, res) => {
    const u = requireUser(req);
    sendJson(res, 200, { workflows: all('SELECT * FROM workflows WHERE user_id = ? ORDER BY created_at DESC', u.id).map(serialize) });
  });

  r.get('/api/workflows/:id', async (req, res) => {
    const u = requireUser(req);
    sendJson(res, 200, { workflow: serialize(ownedWorkflow(u.id, req.params.id)) });
  });

  r.post('/api/workflows', async (req, res) => {
    const u = requireUser(req);
    const body = await readJson(req);
    const v = validateWorkflow(u.id, body);
    const id = tx(() => {
      const wid = insert('workflows', { user_id: u.id, name: v.name, enabled: body.enabled !== false, source_connection_id: v.source.id, filters: v.filters, cutoff_at: now(), created_at: now(), updated_at: now() });
      v.dests.forEach(({ id: _ignored, ...d }, i) => insert('destinations', { workflow_id: wid, ...d, position: i }));
      return wid;
    });
    logActivity(u.id, `Created workflow “${v.name}”`, { refType: 'workflow', refId: id });
    if (body.enabled !== false && v.source.platform !== 'upload') enqueue('poll_source', { connectionId: v.source.id }, { dedupeKey: `poll:${v.source.id}`, maxAttempts: 1 });
    sendJson(res, 201, { workflow: serialize(get('SELECT * FROM workflows WHERE id = ?', id)) });
  });

  r.put('/api/workflows/:id', async (req, res) => {
    const u = requireUser(req);
    const w = ownedWorkflow(u.id, req.params.id);
    const body = await readJson(req);
    const v = validateWorkflow(u.id, body);
    tx(() => {
      update('workflows', w.id, { name: v.name, source_connection_id: v.source.id, filters: v.filters, enabled: body.enabled !== false, updated_at: now() });
      const keep = new Set();
      v.dests.forEach(({ id: destId, ...d }, i) => {
        const existing = destId && get('SELECT id FROM destinations WHERE id = ? AND workflow_id = ?', Number(destId), w.id);
        if (existing) { update('destinations', existing.id, { ...d, position: i }); keep.add(existing.id); }
        else keep.add(insert('destinations', { workflow_id: w.id, ...d, position: i }));
      });
      for (const d of all('SELECT id FROM destinations WHERE workflow_id = ?', w.id)) if (!keep.has(d.id)) run('DELETE FROM destinations WHERE id = ?', d.id);
    });
    sendJson(res, 200, { workflow: serialize(get('SELECT * FROM workflows WHERE id = ?', w.id)) });
  });

  r.patch('/api/workflows/:id', async (req, res) => {
    const u = requireUser(req);
    const w = ownedWorkflow(u.id, req.params.id);
    const { enabled, name } = await readJson(req);
    const patch = { updated_at: now() };
    if (enabled !== undefined) patch.enabled = !!enabled;
    if (name !== undefined && String(name).trim()) patch.name = String(name).trim().slice(0, 120);
    update('workflows', w.id, patch);
    sendJson(res, 200, { workflow: serialize(get('SELECT * FROM workflows WHERE id = ?', w.id)) });
  });

  r.delete('/api/workflows/:id', async (req, res) => {
    const u = requireUser(req);
    const w = ownedWorkflow(u.id, req.params.id);
    run(`UPDATE posts SET status = 'canceled', updated_at = ? WHERE workflow_id = ? AND status IN ('waiting_media','rendering','scheduled','needs_approval')`, now(), w.id);
    run('DELETE FROM workflows WHERE id = ?', w.id);
    sendJson(res, 200, { ok: true });
  });

  r.post('/api/workflows/:id/run', async (req, res) => {
    const u = requireUser(req);
    const w = ownedWorkflow(u.id, req.params.id);
    const src = get('SELECT * FROM connections WHERE id = ?', w.source_connection_id);
    if (src.platform === 'upload') return sendJson(res, 200, { ok: true, message: 'This workflow runs automatically whenever you upload or import to the Library.' });
    enqueue('poll_source', { connectionId: src.id }, { dedupeKey: `poll:${src.id}`, maxAttempts: 1 });
    sendJson(res, 202, { ok: true, message: 'Checking the source for new content…' });
  });

  // Repurpose existing content: the N most recent items from the source that this workflow has not handled yet.
  r.post('/api/workflows/:id/backfill', async (req, res) => {
    const u = requireUser(req);
    const w = ownedWorkflow(u.id, req.params.id);
    const { count = 5, mediaIds } = await readJson(req);
    const rows = Array.isArray(mediaIds) && mediaIds.length
      ? mediaIds.map((id) => get('SELECT id FROM media WHERE id = ? AND user_id = ? AND connection_id = ?', Number(id), u.id, w.source_connection_id)).filter(Boolean)
      : all(`SELECT id FROM media WHERE connection_id = ? AND user_id = ? AND id NOT IN (SELECT media_id FROM posts WHERE workflow_id = ?)
          AND COALESCE(json_extract(meta, '$.purpose'), '') != 'brand' ORDER BY COALESCE(source_published_at, created_at) DESC LIMIT ?`, w.source_connection_id, u.id, w.id, Math.min(50, Number(count) || 5));
    let created = 0;
    for (const { id } of rows) {
      const m = loadMedia(id);
      const n = dispatchMedia(m, [w]);
      if (n && m.status !== 'ready') queueDownload(id);
      created += n;
    }
    sendJson(res, 200, { items: rows.length, posts: created });
  });
}
