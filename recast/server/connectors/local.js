import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { http, ConnectorError, downloadToFile, safeFolder, ytdlpDownload, ytdlpList } from './helpers.js';
import { parseFeed } from '../lib/feed.js';

const MEDIA_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|aac|ogg)$/i;

export const upload = {
  id: 'upload',
  name: 'Library uploads',
  color: '#7c5cff',
  description: 'Files you upload or import by URL in the Library. Use it as a workflow source to auto-publish every new upload.',
  roles: { source: true, destination: false },
  auth: 'none',
  system: true,
  async poll() { return []; },
  async download(ctx, media, dest) {
    if (!media.download_url) throw new ConnectorError('Nothing to download', { retryable: false });
    const isDirect = /\.(mp4|mov|m4v|webm|mkv|mp3|m4a|wav|aac|ogg)(\?|$)/i.test(media.download_url);
    if (isDirect) { await downloadToFile(media.download_url, dest); return {}; }
    const head = await fetch(media.download_url, { method: 'HEAD', redirect: 'follow' }).catch(() => null);
    const type = head?.headers.get('content-type') || '';
    if (/^(video|audio)\//.test(type)) { await downloadToFile(media.download_url, dest); return {}; }
    return ytdlpDownload(media.download_url, dest);
  },
};

export const folder = {
  id: 'folder',
  name: 'Server folder',
  color: '#2f855a',
  description: 'Watch a folder on the server for new videos, or export finished renders (plus caption .txt files) to a folder.',
  roles: { source: true, destination: true },
  auth: 'fields',
  fields: [{ key: 'path', label: 'Folder (relative to the server folder root)', placeholder: 'inbox', required: true }],
  limits: { titleMax: 200, captionMax: 100000 },
  defaultTransform: { aspect: 'original', fit: 'blur' },
  defaultTemplates: { title: '{{title}}', caption: '{{description}}\n\n{{hashtags}}' },
  destinationOptions: [],
  async validate(cfg) {
    const dir = safeFolder(cfg.path);
    fs.mkdirSync(dir, { recursive: true });
    return { account_name: path.relative(safeFolder('.'), dir) || '/', account_id: dir };
  },
  async poll(ctx) {
    const dir = safeFolder(ctx.conn.config.path);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => MEDIA_EXT.test(f)).map((f) => {
      const st = fs.statSync(path.join(dir, f));
      // Skip files still being written (modified in the last 15s).
      if (Date.now() - st.mtimeMs < 15000) return null;
      return { ref: crypto.createHash('sha1').update(`${f}:${st.size}:${st.mtimeMs}`).digest('hex'), title: path.parse(f).name.replace(/[_-]+/g, ' '), description: '', url: '', publishedAt: st.mtimeMs, file: f };
    }).filter(Boolean);
  },
  async download(ctx, media, dest) {
    const src = path.join(safeFolder(ctx.conn.config.path), media.meta?.file || '');
    if (!fs.existsSync(src)) throw new ConnectorError('File no longer exists in the folder', { retryable: false });
    await fs.promises.copyFile(src, dest);
    return {};
  },
  async publish(ctx, post) {
    const dir = safeFolder(ctx.conn.config.path);
    fs.mkdirSync(dir, { recursive: true });
    const base = `${new Date().toISOString().slice(0, 10)}_${(post.title || 'video').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'video'}_${post.id}`;
    await fs.promises.copyFile(ctx.filePath, path.join(dir, `${base}.mp4`));
    await fs.promises.writeFile(path.join(dir, `${base}.txt`), `${post.title}\n\n${post.caption}\n`);
    return { externalId: base, url: '' };
  },
};

export const rss = {
  id: 'rss',
  name: 'RSS / Podcast feed',
  color: '#f26522',
  description: 'Turn new podcast episodes into audiogram videos, or follow any RSS/Atom feed with video enclosures or a YouTube channel feed.',
  roles: { source: true, destination: false },
  auth: 'fields',
  fields: [{ key: 'feedUrl', label: 'Feed URL', placeholder: 'https://feeds.example.com/podcast.xml', required: true, type: 'url' }],
  async validate(cfg) {
    const res = await http(cfg.feedUrl, { raw: true });
    if (!res.ok) throw new ConnectorError(`Feed returned ${res.status}`, { retryable: false });
    const feed = parseFeed(await res.text());
    if (!feed.items.length && !feed.title) throw new ConnectorError('That URL does not look like an RSS or Atom feed', { retryable: false });
    return { account_name: feed.title || new URL(cfg.feedUrl).host, account_id: cfg.feedUrl };
  },
  async poll(ctx) {
    const res = await http(ctx.conn.config.feedUrl, { raw: true });
    if (!res.ok) throw new ConnectorError(`Feed returned ${res.status}`);
    const feed = parseFeed(await res.text());
    return feed.items.filter((i) => i.ref).map((i) => ({ ...i, coverUrl: i.image }));
  },
  async download(ctx, media, dest) {
    if (media.download_url) { await downloadToFile(media.download_url, dest); return {}; }
    if (media.source_url) return ytdlpDownload(media.source_url, dest);
    throw new ConnectorError('Feed item has no media', { retryable: false });
  },
};

export const profile = {
  id: 'profile',
  name: 'Public profile (yt-dlp)',
  color: '#4a5568',
  description: 'Follow any public TikTok, Instagram, YouTube or other profile/playlist URL without an API app. Requires yt-dlp on the server.',
  roles: { source: true, destination: false },
  auth: 'fields',
  fields: [{ key: 'profileUrl', label: 'Profile, channel or playlist URL', placeholder: 'https://www.tiktok.com/@yourname', required: true, type: 'url' }],
  async validate(cfg) {
    const u = new URL(cfg.profileUrl);
    return { account_name: `${u.host.replace(/^www\./, '')}${u.pathname}`.replace(/\/$/, ''), account_id: cfg.profileUrl };
  },
  async poll(ctx) { return ytdlpList(ctx.conn.config.profileUrl, 15); },
  async download(ctx, media, dest) { return ytdlpDownload(media.source_url, dest); },
};

export const webhook = {
  id: 'webhook',
  name: 'Webhook',
  color: '#d53f8c',
  description: 'POST every finished video (signed URL + caption) to Zapier, Make, n8n or your own endpoint.',
  roles: { source: false, destination: true },
  auth: 'fields',
  fields: [
    { key: 'url', label: 'Endpoint URL', placeholder: 'https://hooks.zapier.com/…', required: true, type: 'url' },
    { key: 'secret', label: 'Signing secret (optional)', placeholder: 'used for X-Recast-Signature', type: 'password' },
  ],
  limits: { titleMax: 500, captionMax: 100000 },
  defaultTransform: { aspect: 'original', fit: 'blur' },
  defaultTemplates: { title: '{{title}}', caption: '{{description}}\n\n{{hashtags}}' },
  destinationOptions: [],
  async validate(cfg) {
    const u = new URL(cfg.url);
    if (!/^https?:$/.test(u.protocol)) throw new ConnectorError('Webhook URL must be http(s)', { retryable: false });
    return { account_name: u.host, account_id: cfg.url };
  },
  async publish(ctx, post) {
    const body = JSON.stringify({
      event: 'post.ready', post_id: post.id, title: post.title, caption: post.caption, video_url: ctx.publicUrl(24 * 3600),
      width: post.output_meta?.width, height: post.output_meta?.height, duration: post.output_meta?.duration, source_url: post.media?.source_url || '', created_at: new Date().toISOString(),
    });
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Recast-Webhook/1.0' };
    if (ctx.conn.config.secret) headers['X-Recast-Signature'] = 'sha256=' + crypto.createHmac('sha256', ctx.conn.config.secret).update(body).digest('hex');
    const res = await fetch(ctx.conn.config.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new ConnectorError(`Webhook responded ${res.status}`, { retryable: res.status >= 500 || res.status === 429 });
    let id = '';
    try { const j = await res.json(); id = String(j.id || j.request_id || ''); } catch { /* not JSON */ }
    return { externalId: id || `webhook-${post.id}`, url: '' };
  },
};
