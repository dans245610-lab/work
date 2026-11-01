import fs from 'node:fs';
import { http, ConnectorError, downloadToFile } from './helpers.js';
import { assertPublicUrl } from './instagram.js';

const G = 'https://graph.facebook.com/v21.0';

export default {
  id: 'facebook',
  name: 'Facebook Page',
  color: '#1877f2',
  description: 'Publish Reels or videos to Facebook Pages you manage. Each Page becomes its own connection.',
  roles: { source: true, destination: true },
  auth: 'oauth2',
  oauth: {
    authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
    tokenUrl: `${G}/oauth/access_token`,
    scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'publish_video'],
    scopeSeparator: ',',
  },
  limits: { titleMax: 255, captionMax: 5000, maxDuration: 90 },
  defaultTransform: { aspect: '9:16', fit: 'blur', maxDuration: 90 },
  defaultTemplates: { title: '{{title}}', caption: '{{description}}\n\n{{hashtags}}' },
  destinationOptions: [
    { key: 'fbFormat', label: 'Post as', type: 'select', options: ['reel', 'video'], default: 'reel', help: 'Reels must be vertical and 3–90 seconds. Use "video" for landscape or longer content.' },
  ],

  async exchangeCode(ctx, { code, redirectUri }) {
    const q = (o) => new URLSearchParams(o).toString();
    const t = await http(`${G}/oauth/access_token?${q({ client_id: ctx.app.clientId, client_secret: ctx.app.clientSecret, redirect_uri: redirectUri, code })}`);
    const long = await http(`${G}/oauth/access_token?${q({ grant_type: 'fb_exchange_token', client_id: ctx.app.clientId, client_secret: ctx.app.clientSecret, fb_exchange_token: t.access_token })}`);
    return { access_token: long.access_token, expires_in: long.expires_in };
  },

  /** Returns one connection per Page (Page tokens from a long-lived user token do not expire). */
  async profile(ctx, tokens) {
    const r = await http(`${G}/me/accounts?fields=id,name,access_token,picture{url}&limit=100&access_token=${encodeURIComponent(tokens.access_token)}`);
    if (!r.data?.length) throw new ConnectorError('No Facebook Pages found for this account', { retryable: false });
    return r.data.map((p) => ({ account_id: p.id, account_name: p.name, avatar_url: p.picture?.data?.url || '', credentials: { access_token: p.access_token } }));
  },

  async poll(ctx) {
    const token = await ctx.getToken();
    const r = await http(`${G}/${ctx.conn.account_id}/videos?fields=id,title,description,permalink_url,created_time,picture&limit=25&access_token=${encodeURIComponent(token)}`);
    return (r.data || []).map((v) => ({ ref: v.id, title: v.title || (v.description || '').split('\n')[0].slice(0, 90), description: v.description || '', url: v.permalink_url ? `https://www.facebook.com${v.permalink_url}` : '', publishedAt: Date.parse(v.created_time), thumbUrl: v.picture }));
  },

  async download(ctx, media, dest) {
    const token = await ctx.getToken();
    const r = await http(`${G}/${media.source_ref}?fields=source&access_token=${encodeURIComponent(token)}`);
    if (!r.source) throw new ConnectorError('Facebook did not return a downloadable source URL');
    await downloadToFile(r.source, dest);
    return {};
  },

  async publish(ctx, post) {
    const token = await ctx.getToken();
    const pageId = ctx.conn.account_id;
    if ((post.options?.fbFormat || 'reel') === 'video') {
      assertPublicUrl('Facebook');
      const r = await http(`https://graph-video.facebook.com/v21.0/${pageId}/videos`, { method: 'POST', form: { file_url: ctx.publicUrl(), title: post.title, description: post.caption, access_token: token } });
      return { externalId: r.id, url: `https://www.facebook.com/${pageId}/videos/${r.id}` };
    }
    const start = await http(`${G}/${pageId}/video_reels`, { method: 'POST', json: { upload_phase: 'start', access_token: token } });
    const size = fs.statSync(ctx.filePath).size;
    const up = await fetch(`https://rupload.facebook.com/video-upload/v21.0/${start.video_id}`, {
      method: 'POST', headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(size), 'Content-Length': String(size) }, body: fs.createReadStream(ctx.filePath), duplex: 'half',
    });
    if (!up.ok) throw new ConnectorError(`Facebook upload failed (${up.status}): ${(await up.text()).slice(0, 200)}`);
    await http(`${G}/${pageId}/video_reels`, { method: 'POST', form: { upload_phase: 'finish', video_id: start.video_id, video_state: 'PUBLISHED', description: post.caption, access_token: token } });
    return { externalId: start.video_id, url: `https://www.facebook.com/reel/${start.video_id}` };
  },
};
