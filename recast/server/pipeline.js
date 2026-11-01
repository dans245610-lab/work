import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { get, all, insert, update, run, now, parseJson, logActivity } from './db.js';
import { enqueue, cancelJobs } from './jobs.js';
import { getConnector, pollConnection, downloadMedia, publishPost, ConnectorError } from './connectors/index.js';
import { downloadToFile } from './connectors/helpers.js';
import { probe, makeThumbnail, render } from './media/ffmpeg.js';
import { checkTextFilters, checkMediaFilters } from './lib/filters.js';
import { buildPostText } from './lib/templates.js';
import { computeScheduledAt } from './lib/schedule.js';

export const renderProgress = new Map(); // postId -> 0..1

export const mediaDirFor = (id) => path.join(config.mediaDir, String(id));

export function loadMedia(id) {
  const m = get('SELECT * FROM media WHERE id = ?', id);
  if (m) {
    m.meta = parseJson(m.meta);
    m.cover_path = m.meta.cover_path || null;
  }
  return m;
}

export function loadBrand(id) {
  if (!id) return null;
  const b = get('SELECT * FROM brand_kits WHERE id = ?', id);
  if (b) b.caption_style = parseJson(b.caption_style);
  return b;
}

export function loadPost(id) {
  const p = get('SELECT * FROM posts WHERE id = ?', id);
  if (p) for (const k of ['transform', 'schedule', 'options', 'output_meta']) p[k] = parseJson(p[k]);
  return p;
}

// ---------------- Discovery ----------------

/** Insert a discovered item as a library media row (status "remote"). Returns id or null if already known. */
export function createMediaFromItem(conn, item) {
  const exists = get('SELECT id FROM media WHERE connection_id = ? AND source_ref = ?', conn.id, String(item.ref));
  if (exists) return null;
  return insert('media', {
    user_id: conn.user_id, connection_id: conn.id, source_ref: String(item.ref), title: (item.title || '').slice(0, 500), description: item.description || '',
    source_url: item.url || '', download_url: item.mediaUrl || '', kind: /^audio\//.test(item.mediaType || '') ? 'audio' : 'video', status: 'remote',
    meta: { file: item.file, demo: !!item.demo, coverUrl: item.coverUrl || item.image || '', thumbUrl: item.thumbUrl || '' },
    source_published_at: item.publishedAt || now(), created_at: now(),
  });
}

export async function pollSource(connectionId) {
  const conn = get('SELECT * FROM connections WHERE id = ?', connectionId);
  if (!conn) return;
  let items;
  try {
    items = await pollConnection(conn);
    update('connections', conn.id, { last_polled_at: now(), ...(conn.status === 'error' ? {} : { status_message: '' }) });
  } catch (e) {
    update('connections', conn.id, { last_polled_at: now(), status_message: `Last check failed: ${e.message}`.slice(0, 500), ...(e.reauth ? { status: 'error' } : {}) });
    throw e;
  }
  const workflows = all('SELECT * FROM workflows WHERE source_connection_id = ? AND enabled = 1', conn.id);
  let found = 0;
  for (const item of items) {
    const mediaId = createMediaFromItem(conn, item);
    if (!mediaId) continue;
    found++;
    const media = loadMedia(mediaId);
    const due = workflows.filter((w) => (media.source_published_at || media.created_at) >= w.cutoff_at);
    if (due.length && dispatchMedia(media, due)) queueDownload(mediaId);
  }
  if (found) logActivity(conn.user_id, `Found ${found} new item${found > 1 ? 's' : ''} on ${conn.account_name || getConnector(conn.platform).name}`, { refType: 'connection', refId: conn.id });
  return found;
}

export function queueDownload(mediaId) {
  const m = get('SELECT status FROM media WHERE id = ?', mediaId);
  if (!m || !['remote', 'error'].includes(m.status)) return;
  update('media', mediaId, { status: 'queued', error: '' });
  enqueue('download_media', { mediaId }, { dedupeKey: `download:${mediaId}` });
}

export async function downloadMediaJob(mediaId) {
  const media = loadMedia(mediaId);
  if (!media || media.status === 'ready') return;
  const conn = media.connection_id ? get('SELECT * FROM connections WHERE id = ?', media.connection_id) : null;
  update('media', mediaId, { status: 'downloading' });
  const dir = mediaDirFor(mediaId);
  fs.mkdirSync(dir, { recursive: true });
  const ext = media.kind === 'audio' ? (path.extname(new URL(media.download_url || 'http://x/a.mp3').pathname) || '.mp3') : '.mp4';
  const dest = path.join(dir, `source${ext}`);
  const info = await downloadMedia(conn || { platform: 'upload' }, media, dest);
  const patch = {};
  if (info?.title && (!media.title || media.title === media.source_url)) patch.title = info.title.slice(0, 500);
  if (info?.description && !media.description) patch.description = info.description;
  if (Object.keys(patch).length) update('media', mediaId, patch);
  if (media.meta.coverUrl) {
    try {
      await downloadToFile(media.meta.coverUrl, path.join(dir, 'cover.jpg'), { limit: 15 * 1024 * 1024 });
      update('media', mediaId, { meta: { ...media.meta, cover_path: path.join(dir, 'cover.jpg') } });
    } catch { /* cover is optional */ }
  }
  await finalizeMedia(mediaId, dest);
}

export function onDownloadFailed(mediaId, err) {
  update('media', mediaId, { status: 'error', error: String(err.message).slice(0, 1000) });
  const posts = all(`SELECT id, user_id FROM posts WHERE media_id = ? AND status = 'waiting_media'`, mediaId);
  for (const p of posts) update('posts', p.id, { status: 'failed', error: `Source download failed: ${err.message}`.slice(0, 1000), updated_at: now() });
  const m = get('SELECT user_id, title FROM media WHERE id = ?', mediaId);
  if (m) logActivity(m.user_id, `Download failed for “${m.title || 'media #' + mediaId}”: ${err.message}`, { level: 'error', refType: 'media', refId: mediaId });
}

/** Probe a file now on disk, generate thumbnail, mark ready, and release waiting posts. */
export async function finalizeMedia(mediaId, file) {
  const media = loadMedia(mediaId);
  const p = await probe(file);
  if (p.kind === 'unknown') throw new ConnectorError('File has no audio or video streams', { retryable: false });
  const dir = mediaDirFor(mediaId);
  let thumb = null;
  if (p.kind === 'video') thumb = await makeThumbnail(file, path.join(dir, 'thumb.jpg'), { at: Math.min(1, p.duration / 3) }).catch(() => null);
  else if (media.meta.cover_path) thumb = media.meta.cover_path;
  update('media', mediaId, {
    file_path: file, kind: p.kind, duration: p.duration, width: p.width, height: p.height, has_audio: p.hasAudio, size: fs.statSync(file).size,
    thumb_path: thumb, status: 'ready', error: '', mime: p.kind === 'audio' ? 'audio/*' : 'video/mp4',
  });
  for (const post of all(`SELECT id FROM posts WHERE media_id = ? AND status = 'waiting_media'`, mediaId)) queueRender(post.id);
  return loadMedia(mediaId);
}

// ---------------- Dispatch ----------------

/** Create posts for each destination of each workflow. Returns number of posts created. */
export function dispatchMedia(media, workflows) {
  let created = 0;
  for (const w of workflows) {
    const filters = parseJson(w.filters);
    const reason = checkTextFilters(filters, media);
    if (reason) {
      logActivity(w.user_id, `Workflow “${w.name}” skipped “${media.title}”: ${reason}`, { refType: 'workflow', refId: w.id });
      continue;
    }
    for (const d of all('SELECT * FROM destinations WHERE workflow_id = ? ORDER BY position', w.id)) {
      const conn = get('SELECT * FROM connections WHERE id = ?', d.connection_id);
      if (!conn) continue;
      const opts = parseJson(d.options);
      const postId = createPost({
        userId: w.user_id, workflowId: w.id, destinationId: d.id, media, conn,
        transform: parseJson(d.transform), brandKitId: d.brand_kit_id, schedule: parseJson(d.schedule),
        options: { ...opts, titleTemplate: d.title_template, captionTemplate: d.caption_template, mediaFilters: filters },
      });
      if (postId) created++;
    }
  }
  return created;
}

export function createPost({ userId, workflowId = null, destinationId = null, media, conn, transform = {}, brandKitId = null, schedule = { mode: 'immediate' }, options = {}, title = '', caption = '' }) {
  const status = media.status === 'ready' ? 'rendering' : 'waiting_media';
  let id;
  try {
    id = insert('posts', {
      user_id: userId, workflow_id: workflowId, destination_id: destinationId, media_id: media.id, connection_id: conn.id, platform: conn.platform,
      status, title, caption, transform, brand_kit_id: brandKitId, schedule, options, created_at: now(), updated_at: now(),
    });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return null; // already dispatched to this destination
    throw e;
  }
  if (status === 'rendering') queueRender(id);
  return id;
}

export function queueRender(postId) {
  update('posts', postId, { status: 'rendering', error: '', updated_at: now() });
  enqueue('render_post', { postId }, { dedupeKey: `render:${postId}`, maxAttempts: 2 });
}

// ---------------- Render ----------------

export async function renderPostJob(postId) {
  const post = loadPost(postId);
  if (!post || post.status !== 'rendering') return;
  const media = loadMedia(post.media_id);
  if (!media || media.status !== 'ready') { update('posts', postId, { status: 'waiting_media', updated_at: now() }); return; }
  const conn = get('SELECT * FROM connections WHERE id = ?', post.connection_id);
  const connector = getConnector(post.platform);

  const reason = checkMediaFilters(post.options.mediaFilters || {}, media);
  if (reason) {
    update('posts', postId, { status: 'skipped', error: `Filtered out: ${reason}`, updated_at: now() });
    return;
  }

  // Text (unless the user wrote it explicitly)
  {
    const { title, caption } = buildPostText(media, {
      title_template: post.options.titleTemplate ?? connector.defaultTemplates?.title,
      caption_template: post.options.captionTemplate ?? connector.defaultTemplates?.caption,
      options: post.options,
    }, { platform: connector.name, account: conn?.account_name || '' }, connector.limits || {});
    // Text the user wrote explicitly wins; anything left empty comes from the templates.
    const locked = post.options.textLocked;
    update('posts', postId, { title: locked && post.title ? post.title : title, caption: locked && post.caption ? post.caption : caption });
  }

  const transform = { ...post.transform };
  const platformMax = connector.limits?.maxDuration;
  if (platformMax && (!transform.maxDuration || transform.maxDuration > platformMax)) transform.maxDuration = platformMax;

  const brand = loadBrand(post.brand_kit_id);
  const intro = brand?.intro_media_id ? loadMedia(brand.intro_media_id) : null;
  const outro = brand?.outro_media_id ? loadMedia(brand.outro_media_id) : null;
  const outPath = path.join(config.rendersDir, `post-${postId}.mp4`);
  renderProgress.set(postId, 0);
  try {
    await render({
      media, transform, brand, outPath,
      intro: intro?.status === 'ready' ? intro : null,
      outro: outro?.status === 'ready' ? outro : null,
      onProgress: (p) => renderProgress.set(postId, p),
    });
  } finally { renderProgress.delete(postId); }
  const out = await probe(outPath);
  update('posts', postId, { output_path: outPath, output_meta: { width: out.width, height: out.height, duration: out.duration, size: out.size }, updated_at: now() });

  if (post.options.requireApproval) {
    update('posts', postId, { status: 'needs_approval', updated_at: now() });
    logActivity(post.user_id, `“${media.title}” is ready for review (${connector.name})`, { refType: 'post', refId: postId });
  } else {
    schedulePost(postId);
  }
}

export function onRenderFailed(postId, err) {
  update('posts', postId, { status: 'failed', error: `Render failed: ${err.message}`.slice(0, 1500), updated_at: now() });
  const p = get('SELECT user_id FROM posts WHERE id = ?', postId);
  if (p) logActivity(p.user_id, `Render failed for post #${postId}: ${err.message}`.slice(0, 500), { level: 'error', refType: 'post', refId: postId });
}

// ---------------- Schedule & publish ----------------

export function schedulePost(postId, { at } = {}) {
  const post = loadPost(postId);
  const user = get('SELECT timezone FROM users WHERE id = ?', post.user_id);
  const taken = new Set(all(`SELECT scheduled_at FROM posts WHERE connection_id = ? AND id != ? AND status IN ('scheduled','publishing','published') AND scheduled_at > ?`,
    post.connection_id, postId, now() - 86400_000).map((r) => r.scheduled_at));
  const scheduledAt = at ?? computeScheduledAt(post.schedule, { tz: user?.timezone || 'UTC', taken });
  update('posts', postId, { status: 'scheduled', scheduled_at: scheduledAt, error: '', updated_at: now() });
  cancelJobs(`publish:${postId}`);
  enqueue('publish_post', { postId }, { runAt: scheduledAt, dedupeKey: `publish:${postId}`, maxAttempts: 4 });
  return scheduledAt;
}

export async function publishPostJob(postId) {
  const post = loadPost(postId);
  if (!post || !['scheduled', 'publishing'].includes(post.status)) return;
  if (post.scheduled_at && post.scheduled_at > now() + 1000) return; // rescheduled later; another job exists
  const conn = get('SELECT * FROM connections WHERE id = ?', post.connection_id);
  if (!conn) throw new ConnectorError('Destination connection was removed', { retryable: false });
  if (!post.output_path || !fs.existsSync(post.output_path)) throw new ConnectorError('Rendered file is missing — re-render the post', { retryable: false });
  update('posts', postId, { status: 'publishing', attempts: post.attempts + 1, updated_at: now() });
  post.media = loadMedia(post.media_id);
  const r = await publishPost(conn, post, post.output_path);
  update('posts', postId, { status: 'published', published_at: now(), external_id: String(r.externalId || ''), external_url: r.url || '', error: r.note || '', updated_at: now() });
  logActivity(post.user_id, `Published “${post.title || post.media?.title || 'video'}” to ${getConnector(conn.platform).name}${conn.account_name ? ` (${conn.account_name})` : ''}${conn.demo ? ' [demo]' : ''}`, { level: 'success', refType: 'post', refId: postId });
}

export function onPublishFailed(postId, err, willRetry) {
  const post = get('SELECT user_id, connection_id FROM posts WHERE id = ?', postId);
  if (!post) return;
  if (willRetry) {
    update('posts', postId, { status: 'scheduled', error: `Retrying: ${err.message}`.slice(0, 1500), updated_at: now() });
    return;
  }
  update('posts', postId, { status: 'failed', error: String(err.message).slice(0, 1500), updated_at: now() });
  if (err.reauth) update('connections', post.connection_id, { status: 'error', status_message: 'Authorization expired — reconnect this account' });
  logActivity(post.user_id, `Publishing post #${postId} failed: ${err.message}`.slice(0, 500), { level: 'error', refType: 'post', refId: postId });
}

/** Delete rendered files for long-published posts to save disk. */
export function pruneRenders(days = Number(process.env.RENDER_RETENTION_DAYS || 14)) {
  const old = all(`SELECT id, output_path FROM posts WHERE status = 'published' AND output_path IS NOT NULL AND published_at < ?`, now() - days * 86400_000);
  for (const p of old) { fs.rm(p.output_path, { force: true }, () => {}); run('UPDATE posts SET output_path = NULL WHERE id = ?', p.id); }
}
