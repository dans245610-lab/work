import { http, ConnectorError, sleep, downloadToFile } from './helpers.js';
import { config } from '../config.js';

const G = 'https://graph.instagram.com/v21.0';

export function assertPublicUrl(platform) {
  if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.)/.test(config.publicBaseUrl)) {
    throw new ConnectorError(`${platform} downloads the video from your server, so PUBLIC_BASE_URL must be a public https URL (currently ${config.publicBaseUrl}).`, { retryable: false });
  }
}

export default {
  id: 'instagram',
  name: 'Instagram',
  color: '#e1306c',
  description: 'Publish Reels to an Instagram professional account, or repurpose your existing Reels.',
  roles: { source: true, destination: true },
  auth: 'oauth2',
  oauth: {
    authorizeUrl: 'https://www.instagram.com/oauth/authorize',
    tokenUrl: 'https://api.instagram.com/oauth/access_token',
    scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
    scopeSeparator: ',',
  },
  limits: { titleMax: 0, captionMax: 2200, maxDuration: 900 },
  defaultTransform: { aspect: '9:16', fit: 'blur' },
  defaultTemplates: { title: '{{title}}', caption: '{{description}}\n\n{{hashtags}}' },
  destinationOptions: [
    { key: 'shareToFeed', label: 'Also show in main feed', type: 'checkbox', default: true },
  ],

  async exchangeCode(ctx, { code, redirectUri }) {
    const short = await http('https://api.instagram.com/oauth/access_token', { method: 'POST', form: { client_id: ctx.app.clientId, client_secret: ctx.app.clientSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code } });
    const long = await http(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(ctx.app.clientSecret)}&access_token=${encodeURIComponent(short.access_token)}`);
    return { access_token: long.access_token, expires_in: long.expires_in, user_id: short.user_id, refresh_token: long.access_token };
  },
  async refresh(ctx, token) {
    const r = await http(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
    return { access_token: r.access_token, expires_in: r.expires_in, refresh_token: r.access_token };
  },

  async profile(ctx, tokens) {
    const me = await http(`${G}/me?fields=user_id,username,profile_picture_url&access_token=${encodeURIComponent(tokens.access_token)}`);
    return { account_id: String(me.user_id || me.id), account_name: `@${me.username}`, avatar_url: me.profile_picture_url || '' };
  },

  async poll(ctx) {
    const token = await ctx.getToken();
    const r = await http(`${G}/me/media?fields=id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url&limit=25&access_token=${encodeURIComponent(token)}`);
    return (r.data || []).filter((m) => m.media_type === 'VIDEO').map((m) => ({
      ref: m.id, title: (m.caption || '').split('\n')[0].slice(0, 90), description: m.caption || '', url: m.permalink, publishedAt: Date.parse(m.timestamp), thumbUrl: m.thumbnail_url,
    }));
  },

  async download(ctx, media, dest) {
    const token = await ctx.getToken();
    const r = await http(`${G}/${media.source_ref}?fields=media_url&access_token=${encodeURIComponent(token)}`);
    if (!r.media_url) throw new ConnectorError('Instagram did not return a downloadable media URL');
    await downloadToFile(r.media_url, dest);
    return {};
  },

  async publish(ctx, post) {
    assertPublicUrl('Instagram');
    const token = await ctx.getToken();
    const igId = ctx.conn.account_id;
    const c = await http(`${G}/${igId}/media`, { method: 'POST', form: { media_type: 'REELS', video_url: ctx.publicUrl(), caption: post.caption, share_to_feed: String(post.options?.shareToFeed !== false), access_token: token } });
    for (let i = 0; i < 90; i++) {
      await sleep(i < 6 ? 5000 : 10000);
      const s = await http(`${G}/${c.id}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
      if (s.status_code === 'FINISHED') break;
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new ConnectorError(`Instagram could not process the video: ${s.status || s.status_code}`, { retryable: false });
      if (i === 89) throw new ConnectorError('Instagram is taking too long to process the video');
    }
    const pub = await http(`${G}/${igId}/media_publish`, { method: 'POST', form: { creation_id: c.id, access_token: token } });
    const info = await http(`${G}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(token)}`).catch(() => ({}));
    return { externalId: pub.id, url: info.permalink || '' };
  },
};
