import fs from 'node:fs';
import path from 'node:path';
import { get, all, insert, update, run, now, parseJson, logActivity } from '../db.js';
import { readJson, readBody, sendJson, sendFile, streamToFile, bad, notFound, HttpError } from '../lib/http.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { mediaDirFor, finalizeMedia, queueDownload, createPost, loadMedia, loadBrand, dispatchMedia, schedulePost } from '../pipeline.js';
import { enqueue } from '../jobs.js';
import { parseCaptions, serializeSrt } from '../media/captions.js';
import { render } from '../media/ffmpeg.js';
import { getConnector } from '../connectors/index.js';
import { ownedConnection } from './connections.js';
import { randomToken } from '../lib/security.js';

const MEDIA_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|aac|ogg)$/i;

export function publicMedia(m) {
  const meta = parseJson(m.meta);
  return {
    id: m.id, title: m.title, description: m.description, source_url: m.source_url, kind: m.kind, status: m.status, error: m.error,
    duration: m.duration, width: m.width, height: m.height, size: m.size, has_audio: !!m.has_audio, has_captions: !!m.captions_path,
    connection_id: m.connection_id, source_published_at: m.source_published_at, created_at: m.created_at,
    thumb_url: m.thumb_path ? `/files/media/${m.id}/thumb?v=${m.created_at}` : meta.thumbUrl || '',
    file_url: m.file_path ? `/files/media/${m.id}/source` : '',
  };
}

export const ownedMedia = (userId, id) => {
  const m = get('SELECT * FROM media WHERE id = ? AND user_id = ?', Number(id), userId);
  if (!m) throw notFound('Media not found');
  return m;
};

const uploadConnection = (userId) => get(`SELECT * FROM connections WHERE user_id = ? AND platform = 'upload'`, userId);

/** Once an upload/import is ready, hand it to workflows that use the library as their source. */
function dispatchLibraryItem(mediaId) {
  const m = loadMedia(mediaId);
  const wfs = all('SELECT * FROM workflows WHERE source_connection_id = ? AND enabled = 1', m.connection_id);
  if (wfs.length) dispatchMedia(m, wfs);
}

const previews = new Map(); // token -> {file, userId, expires}

export default function register(r) {
  r.get('/api/media', async (req, res) => {
    const u = requireUser(req);
    const q = req.query;
    const where = ['user_id = ?'];
    const params = [u.id];
    if (q.get('status')) { where.push('status = ?'); params.push(q.get('status')); }
    if (q.get('connection')) { where.push('connection_id = ?'); params.push(Number(q.get('connection'))); }
    if (q.get('kind')) { where.push('kind = ?'); params.push(q.get('kind')); }
    if (q.get('q')) { where.push('(title LIKE ? OR description LIKE ?)'); params.push(`%${q.get('q')}%`, `%${q.get('q')}%`); }
    const limit = Math.min(200, Number(q.get('limit')) || 60);
    const offset = Math.max(0, Number(q.get('offset')) || 0);
    const rows = all(`SELECT * FROM media WHERE ${where.join(' AND ')} ORDER BY COALESCE(source_published_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = get(`SELECT COUNT(*) n FROM media WHERE ${where.join(' AND ')}`, ...params).n;
    sendJson(res, 200, { media: rows.map(publicMedia), total });
  });

  r.get('/api/media/:id', async (req, res) => {
    const u = requireUser(req);
    const m = ownedMedia(u.id, req.params.id);
    const posts = all('SELECT id, platform, status, scheduled_at, published_at, external_url, connection_id, error FROM posts WHERE media_id = ? ORDER BY id DESC', m.id);
    sendJson(res, 200, { media: publicMedia(m), posts });
  });

  // Raw-body upload: PUT with X-Filename header (works with fetch/XHR progress, no multipart parsing).
  r.put('/api/media/upload', async (req, res) => {
    const u = requireUser(req);
    const filename = decodeURIComponent(String(req.headers['x-filename'] || 'upload.mp4'));
    if (!MEDIA_EXT.test(filename)) throw bad('Unsupported file type. Upload a video (mp4, mov, webm, mkv) or audio (mp3, m4a, wav).');
    const lib = uploadConnection(u.id);
    const title = decodeURIComponent(String(req.headers['x-title'] || '')) || path.parse(filename).name.replace(/[_-]+/g, ' ');
    const purpose = String(req.headers['x-purpose'] || '');
    const id = insert('media', {
      user_id: u.id, connection_id: lib.id, title: title.slice(0, 500), status: 'uploading', created_at: now(), source_published_at: now(),
      meta: { originalName: filename, purpose },
    });
    const dest = path.join(mediaDirFor(id), `source${path.extname(filename).toLowerCase()}`);
    try {
      await streamToFile(req, dest, config.maxUploadBytes);
      await finalizeMedia(id, dest);
    } catch (e) {
      run('DELETE FROM media WHERE id = ?', id);
      fs.rmSync(mediaDirFor(id), { recursive: true, force: true });
      throw e instanceof HttpError ? e : bad(`Could not read that file: ${e.message}`);
    }
    logActivity(u.id, `Uploaded “${title}”`, { refType: 'media', refId: id });
    if (purpose !== 'brand') dispatchLibraryItem(id);
    sendJson(res, 201, { media: publicMedia(get('SELECT * FROM media WHERE id = ?', id)) });
  });

  r.post('/api/media/import', async (req, res) => {
    const u = requireUser(req);
    const { url, title = '' } = await readJson(req);
    let parsed;
    try { parsed = new URL(url); } catch { throw bad('Enter a valid URL'); }
    if (!/^https?:$/.test(parsed.protocol)) throw bad('Only http(s) URLs can be imported');
    const lib = uploadConnection(u.id);
    const id = insert('media', {
      user_id: u.id, connection_id: lib.id, source_ref: `url:${url}:${now()}`, title: title || url, source_url: url, download_url: url,
      kind: /\.(mp3|m4a|wav|aac|ogg)(\?|$)/i.test(parsed.pathname) ? 'audio' : 'video', status: 'remote', created_at: now(), source_published_at: now(), meta: {},
    });
    // Workflows on the library source get the item once it is ready.
    const wfs = all('SELECT * FROM workflows WHERE source_connection_id = ? AND enabled = 1', lib.id);
    if (wfs.length) dispatchMedia(loadMedia(id), wfs);
    queueDownload(id);
    sendJson(res, 202, { media: publicMedia(get('SELECT * FROM media WHERE id = ?', id)) });
  });

  r.patch('/api/media/:id', async (req, res) => {
    const u = requireUser(req);
    const m = ownedMedia(u.id, req.params.id);
    const { title, description } = await readJson(req);
    const patch = {};
    if (title !== undefined) patch.title = String(title).slice(0, 500);
    if (description !== undefined) patch.description = String(description).slice(0, 20000);
    update('media', m.id, patch);
    sendJson(res, 200, { media: publicMedia(get('SELECT * FROM media WHERE id = ?', m.id)) });
  });

  r.delete('/api/media/:id', async (req, res) => {
    const u = requireUser(req);
    const m = ownedMedia(u.id, req.params.id);
    for (const p of all('SELECT output_path FROM posts WHERE media_id = ?', m.id)) if (p.output_path) fs.rmSync(p.output_path, { force: true });
    run('DELETE FROM media WHERE id = ?', m.id);
    fs.rmSync(mediaDirFor(m.id), { recursive: true, force: true });
    sendJson(res, 200, { ok: true });
  });

  r.post('/api/media/:id/download', async (req, res) => {
    const u = requireUser(req);
    const m = ownedMedia(u.id, req.params.id);
    queueDownload(m.id);
    sendJson(res, 202, { ok: true });
  });

  // Captions (SRT or VTT)
  r.put('/api/media/:id/captions', async (req, res) => {
    const u = requireUser(req);
    const m = ownedMedia(u.id, req.params.id);
    const text = (await readBody(req, 5 * 1024 * 1024)).toString('utf8');
    const cues = parseCaptions(text);
    if (!cues.length) throw bad('No caption cues found — upload an .srt or .vtt file');
    const file = path.join(mediaDirFor(m.id), 'captions.srt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeSrt(cues));
    update('media', m.id, { captions_path: file });
    sendJson(res, 200, { cues: cues.length });
  });
  r.get('/api/media/:id/captions', async (req, res) => {
    const u = requireUser(req);
    const m = ownedMedia(u.id, req.params.id);
    const cues = m.captions_path && fs.existsSync(m.captions_path) ? parseCaptions(fs.readFileSync(m.captions_path, 'utf8')) : [];
    sendJson(res, 200, { cues });
  });
  r.delete('/api/media/:id/captions', async (req, res) => {
    const u = requireUser(req);
    const m = ownedMedia(u.id, req.params.id);
    if (m.captions_path) fs.rmSync(m.captions_path, { force: true });
    update('media', m.id, { captions_path: null });
    sendJson(res, 200, { ok: true });
  });

  // Manually publish a library item to one or more destinations.
  r.post('/api/media/:id/publish', async (req, res) => {
    const u = requireUser(req);
    const m = ownedMedia(u.id, req.params.id);
    const { destinations = [] } = await readJson(req);
    if (!destinations.length) throw bad('Pick at least one destination');
    const media = loadMedia(m.id);
    const ids = [];
    for (const d of destinations) {
      const conn = ownedConnection(u.id, d.connectionId);
      const meta = getConnector(conn.platform);
      if (!meta.roles.destination) throw bad(`${meta.name} cannot be published to`);
      if (d.brandKitId && !get('SELECT id FROM brand_kits WHERE id = ? AND user_id = ?', d.brandKitId, u.id)) throw bad('Unknown brand kit');
      const locked = d.title != null || d.caption != null;
      const postId = createPost({
        userId: u.id, media, conn, transform: { ...(meta.defaultTransform || {}), ...(d.transform || {}) }, brandKitId: d.brandKitId || null,
        schedule: d.schedule || { mode: 'immediate' },
        options: { ...(d.options || {}), textLocked: locked, titleTemplate: meta.defaultTemplates?.title, captionTemplate: meta.defaultTemplates?.caption },
        title: d.title || '', caption: d.caption || '',
      });
      ids.push(postId);
    }
    if (media.status === 'remote' || media.status === 'error') queueDownload(media.id);
    logActivity(u.id, `Queued “${m.title}” for ${ids.length} destination${ids.length > 1 ? 's' : ''}`, { refType: 'media', refId: m.id });
    sendJson(res, 201, { posts: ids });
  });

  // Quick low-res preview render (first ~6 seconds) for the transform editor.
  r.post('/api/media/:id/preview', async (req, res) => {
    const u = requireUser(req);
    const m = ownedMedia(u.id, req.params.id);
    if (m.status !== 'ready') throw bad('Media is not downloaded yet');
    const { transform = {}, brandKitId } = await readJson(req);
    const brand = brandKitId ? loadBrand(get('SELECT id FROM brand_kits WHERE id = ? AND user_id = ?', brandKitId, u.id)?.id) : null;
    const token = randomToken(12);
    const file = path.join(config.tmpDir, `preview-${token}.mp4`);
    await render({ media: loadMedia(m.id), transform, brand, outPath: file, preview: true });
    previews.set(token, { file, userId: u.id, expires: now() + 15 * 60_000 });
    for (const [k, v] of previews) if (v.expires < now()) { fs.rm(v.file, { force: true }, () => {}); previews.delete(k); }
    sendJson(res, 200, { url: `/files/preview/${token}` });
  });

  r.get('/files/preview/:token', async (req, res) => {
    const u = requireUser(req);
    const p = previews.get(req.params.token);
    if (!p || p.userId !== u.id) throw notFound();
    sendFile(req, res, p.file, { cache: 'no-store' });
  });

  r.get('/files/media/:id/:kind', async (req, res) => {
    const u = requireUser(req);
    const m = ownedMedia(u.id, req.params.id);
    const file = req.params.kind === 'thumb' ? m.thumb_path : req.params.kind === 'source' ? m.file_path : null;
    if (!file) throw notFound();
    sendFile(req, res, file, { downloadName: req.query.get('download') ? `${m.title || 'media'}${path.extname(file)}` : undefined });
  });
}
