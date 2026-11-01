import fs from 'node:fs';
import { http, ConnectorError, ytdlpDownload } from './helpers.js';
import { parseFeed } from '../lib/feed.js';

export default {
  id: 'youtube',
  name: 'YouTube',
  color: '#ff0033',
  description: 'Pull new uploads from your channel, or publish Shorts and long-form videos.',
  roles: { source: true, destination: true },
  auth: 'oauth2',
  oauth: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'],
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  limits: { titleMax: 100, captionMax: 5000, maxDuration: 180 },
  defaultTransform: { aspect: '9:16', fit: 'blur', maxDuration: 180 },
  defaultTemplates: { title: '{{title}}', caption: '{{description}}\n\n{{hashtags}} #Shorts' },
  destinationOptions: [
    { key: 'privacy', label: 'Visibility', type: 'select', options: ['public', 'unlisted', 'private'], default: 'public' },
    { key: 'categoryId', label: 'Category ID', type: 'text', default: '22', help: '22 = People & Blogs, 24 = Entertainment, 28 = Science & Tech' },
  ],
  sourceNote: 'New uploads are detected through your channel feed; downloading requires yt-dlp on the server.',

  async profile(ctx, tokens) {
    const r = await http('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { token: tokens.access_token });
    const ch = r.items?.[0];
    if (!ch) throw new ConnectorError('This Google account has no YouTube channel', { retryable: false });
    return { account_id: ch.id, account_name: ch.snippet.title, avatar_url: ch.snippet.thumbnails?.default?.url || '' };
  },

  async poll(ctx) {
    const xml = await (await http(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(ctx.conn.account_id)}`, { raw: true })).text();
    return parseFeed(xml).items.map((i) => ({ ref: i.videoId || i.ref, title: i.title, description: i.description, url: i.url, publishedAt: i.publishedAt, thumbUrl: i.image }));
  },

  async download(ctx, media, dest) {
    return ytdlpDownload(media.source_url || `https://www.youtube.com/watch?v=${media.source_ref}`, dest);
  },

  async publish(ctx, post) {
    const token = await ctx.getToken();
    const size = fs.statSync(ctx.filePath).size;
    const opts = post.options || {};
    const meta = {
      snippet: { title: post.title || 'Untitled', description: post.caption, categoryId: String(opts.categoryId || '22'), tags: (post.caption.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.slice(1)).slice(0, 15) },
      status: { privacyStatus: opts.privacy || 'public', selfDeclaredMadeForKids: false },
    };
    const init = await http('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST', token, raw: true, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' }, body: JSON.stringify(meta),
    });
    if (!init.ok) throw new ConnectorError(`YouTube upload init failed (${init.status}): ${(await init.text()).slice(0, 300)}`, { retryable: init.status >= 500, reauth: init.status === 401 });
    const location = init.headers.get('location');
    const up = await fetch(location, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: fs.createReadStream(ctx.filePath), duplex: 'half', signal: AbortSignal.timeout(60 * 60 * 1000) });
    const data = await up.json().catch(() => ({}));
    if (!up.ok) throw new ConnectorError(`YouTube upload failed (${up.status}): ${data?.error?.message || ''}`, { retryable: up.status >= 500 });
    const isShort = post.output_meta?.height > post.output_meta?.width && post.output_meta?.duration <= 180;
    return { externalId: data.id, url: isShort ? `https://youtube.com/shorts/${data.id}` : `https://www.youtube.com/watch?v=${data.id}` };
  },
};
