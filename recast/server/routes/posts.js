import fs from 'node:fs';
import { get, all, update, run, now, parseJson, logActivity } from '../db.js';
import { readJson, sendJson, sendFile, bad, notFound } from '../lib/http.js';
import { requireUser } from '../auth.js';
import { schedulePost, queueRender, renderProgress } from '../pipeline.js';
import { cancelJobs, enqueue } from '../jobs.js';
import { getConnector } from '../connectors/index.js';
import { truncate } from '../lib/templates.js';

const ownedPost = (userId, id) => {
  const p = get('SELECT * FROM posts WHERE id = ? AND user_id = ?', Number(id), userId);
  if (!p) throw notFound('Post not found');
  return p;
};

export function publicPost(p) {
  const m = get('SELECT id, title, thumb_path, created_at, kind FROM media WHERE id = ?', p.media_id);
  const c = get('SELECT id, account_name, label, demo FROM connections WHERE id = ?', p.connection_id);
  const w = p.workflow_id ? get('SELECT id, name FROM workflows WHERE id = ?', p.workflow_id) : null;
  const meta = getConnector(p.platform);
  return {
    id: p.id, status: p.status, platform: p.platform, platform_name: meta.name, color: meta.color, title: p.title, caption: p.caption,
    scheduled_at: p.scheduled_at, published_at: p.published_at, external_url: p.external_url, external_id: p.external_id, error: p.error,
    attempts: p.attempts, created_at: p.created_at, updated_at: p.updated_at, transform: parseJson(p.transform), schedule: parseJson(p.schedule),
    output_meta: parseJson(p.output_meta), has_output: !!(p.output_path && fs.existsSync(p.output_path)), progress: renderProgress.get(p.id) ?? null,
    output_url: p.output_path ? `/files/posts/${p.id}/output?v=${p.updated_at}` : '',
    media: m && { id: m.id, title: m.title, kind: m.kind, thumb_url: m.thumb_path ? `/files/media/${m.id}/thumb?v=${m.created_at}` : '' },
    connection: c && { id: c.id, account_name: c.account_name, label: c.label, demo: !!c.demo },
    workflow: w, limits: meta.limits || {},
  };
}

export default function register(r) {
  r.get('/api/posts', async (req, res) => {
    const u = requireUser(req);
    const q = req.query;
    const where = ['user_id = ?'];
    const params = [u.id];
    const status = q.get('status');
    if (status) { const s = status.split(','); where.push(`status IN (${s.map(() => '?').join(',')})`); params.push(...s); }
    if (q.get('workflow')) { where.push('workflow_id = ?'); params.push(Number(q.get('workflow'))); }
    if (q.get('media')) { where.push('media_id = ?'); params.push(Number(q.get('media'))); }
    if (q.get('platform')) { where.push('platform = ?'); params.push(q.get('platform')); }
    if (q.get('from')) { where.push('COALESCE(published_at, scheduled_at, created_at) >= ?'); params.push(Number(q.get('from'))); }
    if (q.get('to')) { where.push('COALESCE(published_at, scheduled_at, created_at) < ?'); params.push(Number(q.get('to'))); }
    const order = q.get('order') === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(500, Number(q.get('limit')) || 100);
    const rows = all(`SELECT * FROM posts WHERE ${where.join(' AND ')} ORDER BY COALESCE(published_at, scheduled_at, created_at) ${order}, id ${order} LIMIT ?`, ...params, limit);
    const counts = Object.fromEntries(all('SELECT status, COUNT(*) n FROM posts WHERE user_id = ? GROUP BY status', u.id).map((x) => [x.status, x.n]));
    sendJson(res, 200, { posts: rows.map(publicPost), counts });
  });

  r.get('/api/posts/:id', async (req, res) => {
    const u = requireUser(req);
    sendJson(res, 200, { post: publicPost(ownedPost(u.id, req.params.id)) });
  });

  r.patch('/api/posts/:id', async (req, res) => {
    const u = requireUser(req);
    const p = ownedPost(u.id, req.params.id);
    if (['published', 'publishing'].includes(p.status)) throw bad('This post has already been published');
    const { title, caption, scheduledAt } = await readJson(req);
    const limits = getConnector(p.platform).limits || {};
    const patch = { updated_at: now() };
    const opts = parseJson(p.options);
    if (title !== undefined) { patch.title = truncate(String(title), limits.titleMax); opts.textLocked = true; }
    if (caption !== undefined) {
      if (limits.captionMax && [...String(caption)].length > limits.captionMax) throw bad(`Caption is longer than ${limits.captionMax} characters`);
      patch.caption = String(caption); opts.textLocked = true;
    }
    patch.options = opts;
    update('posts', p.id, patch);
    if (scheduledAt !== undefined) {
      const at = Number(scheduledAt);
      if (!at || Number.isNaN(at)) throw bad('Invalid schedule time');
      if (p.status === 'scheduled') schedulePost(p.id, { at: Math.max(now(), at) });
      else update('posts', p.id, { schedule: { mode: 'at', at } });
    }
    sendJson(res, 200, { post: publicPost(ownedPost(u.id, p.id)) });
  });

  r.post('/api/posts/:id/approve', async (req, res) => {
    const u = requireUser(req);
    const p = ownedPost(u.id, req.params.id);
    if (p.status !== 'needs_approval') throw bad('Post is not waiting for approval');
    const { publishNow } = await readJson(req);
    schedulePost(p.id, publishNow ? { at: now() } : {});
    logActivity(u.id, `Approved post #${p.id}`, { refType: 'post', refId: p.id });
    sendJson(res, 200, { post: publicPost(ownedPost(u.id, p.id)) });
  });

  r.post('/api/posts/:id/publish-now', async (req, res) => {
    const u = requireUser(req);
    const p = ownedPost(u.id, req.params.id);
    if (!['scheduled', 'needs_approval'].includes(p.status)) throw bad('Only scheduled or pending-approval posts can be published now');
    schedulePost(p.id, { at: now() });
    sendJson(res, 200, { post: publicPost(ownedPost(u.id, p.id)) });
  });

  r.post('/api/posts/:id/retry', async (req, res) => {
    const u = requireUser(req);
    const p = ownedPost(u.id, req.params.id);
    if (!['failed', 'canceled', 'skipped'].includes(p.status)) throw bad('Only failed, skipped or canceled posts can be retried');
    const media = get('SELECT status FROM media WHERE id = ?', p.media_id);
    if (p.output_path && fs.existsSync(p.output_path) && p.status !== 'skipped') schedulePost(p.id, { at: now() });
    else if (media?.status === 'ready') {
      if (p.status === 'skipped') { const o = parseJson(p.options); delete o.mediaFilters; update('posts', p.id, { options: o }); }
      queueRender(p.id);
    } else {
      update('posts', p.id, { status: 'waiting_media', error: '', updated_at: now() });
      run(`UPDATE media SET status = 'remote' WHERE id = ? AND status = 'error'`, p.media_id);
      enqueue('download_media', { mediaId: p.media_id }, { dedupeKey: `download:${p.media_id}` });
    }
    sendJson(res, 200, { post: publicPost(ownedPost(u.id, p.id)) });
  });

  r.post('/api/posts/:id/rerender', async (req, res) => {
    const u = requireUser(req);
    const p = ownedPost(u.id, req.params.id);
    if (['publishing', 'published'].includes(p.status)) throw bad('Already published');
    const { transform } = await readJson(req);
    if (transform) update('posts', p.id, { transform: { ...parseJson(p.transform), ...transform } });
    cancelJobs(`publish:${p.id}`);
    queueRender(p.id);
    sendJson(res, 200, { post: publicPost(ownedPost(u.id, p.id)) });
  });

  r.post('/api/posts/:id/cancel', async (req, res) => {
    const u = requireUser(req);
    const p = ownedPost(u.id, req.params.id);
    if (['published', 'publishing'].includes(p.status)) throw bad('Already published');
    cancelJobs(`publish:${p.id}`);
    cancelJobs(`render:${p.id}`);
    update('posts', p.id, { status: 'canceled', updated_at: now() });
    sendJson(res, 200, { post: publicPost(ownedPost(u.id, p.id)) });
  });

  r.delete('/api/posts/:id', async (req, res) => {
    const u = requireUser(req);
    const p = ownedPost(u.id, req.params.id);
    if (p.status === 'publishing') throw bad('Post is publishing right now');
    cancelJobs(`publish:${p.id}`);
    cancelJobs(`render:${p.id}`);
    if (p.output_path) fs.rmSync(p.output_path, { force: true });
    run('DELETE FROM posts WHERE id = ?', p.id);
    sendJson(res, 200, { ok: true });
  });

  r.get('/files/posts/:id/output', async (req, res) => {
    const u = requireUser(req);
    const p = ownedPost(u.id, req.params.id);
    if (!p.output_path) throw notFound('No rendered file');
    sendFile(req, res, p.output_path, { downloadName: req.query.get('download') ? `${(p.title || 'video').slice(0, 60)}-${p.platform}.mp4` : undefined });
  });
}
