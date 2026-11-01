import fs from 'node:fs';
import { http, ConnectorError, fileChunks, sleep } from './helpers.js';

const API = 'https://api.x.com/2';

export default {
  id: 'x',
  name: 'X (Twitter)',
  color: '#000000',
  description: 'Post videos to X with chunked media upload.',
  roles: { source: false, destination: true },
  auth: 'oauth2',
  oauth: {
    authorizeUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: `${API}/oauth2/token`,
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
    pkce: true,
    tokenAuth: 'basic',
  },
  limits: { titleMax: 0, captionMax: 280, maxDuration: 140 },
  defaultTransform: { aspect: 'original', fit: 'blur', maxDuration: 140 },
  defaultTemplates: { title: '{{title}}', caption: '{{first_line}} {{hashtags}}' },
  destinationOptions: [],

  async profile(ctx, tokens) {
    const r = await http(`${API}/users/me?user.fields=profile_image_url`, { token: tokens.access_token });
    return { account_id: r.data.id, account_name: `@${r.data.username}`, avatar_url: r.data.profile_image_url || '' };
  },

  async publish(ctx, post) {
    const token = await ctx.getToken();
    const size = fs.statSync(ctx.filePath).size;
    const init = await http(`${API}/media/upload/initialize`, { method: 'POST', token, json: { media_type: 'video/mp4', total_bytes: size, media_category: 'amplify_video' } });
    const mediaId = init.data?.id;
    if (!mediaId) throw new ConnectorError('X did not return a media id');
    for await (const { buf, index } of fileChunks(ctx.filePath, 4 * 1024 * 1024)) {
      const fd = new FormData();
      fd.append('segment_index', String(index));
      fd.append('media', new Blob([buf], { type: 'application/octet-stream' }), 'chunk');
      const r = await fetch(`${API}/media/upload/${mediaId}/append`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      if (!r.ok) throw new ConnectorError(`X media append failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    }
    let fin = await http(`${API}/media/upload/${mediaId}/finalize`, { method: 'POST', token });
    let info = fin.data?.processing_info;
    for (let i = 0; info && info.state !== 'succeeded' && i < 60; i++) {
      if (info.state === 'failed') throw new ConnectorError(`X could not process the video: ${info.error?.message || ''}`, { retryable: false });
      await sleep(Math.max(1, info.check_after_secs || 3) * 1000);
      fin = await http(`${API}/media/upload?command=STATUS&media_id=${mediaId}`, { token });
      info = fin.data?.processing_info;
    }
    const t = await http(`${API}/tweets`, { method: 'POST', token, json: { text: post.caption, media: { media_ids: [String(mediaId)] } } });
    return { externalId: t.data.id, url: `https://x.com/i/status/${t.data.id}` };
  },
};
