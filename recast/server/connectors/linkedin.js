import fs from 'node:fs';
import { http, ConnectorError, sleep } from './helpers.js';

const API = 'https://api.linkedin.com/rest';

/** LinkedIn versions are YYYYMM and each is supported for ~1 year; default to ~3 months ago. */
export function linkedinVersion(d = new Date()) {
  if (process.env.LINKEDIN_API_VERSION) return process.env.LINKEDIN_API_VERSION;
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, 1));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Escape LinkedIn "little text" reserved characters in post commentary. */
export const escapeLittleText = (s) => String(s).replace(/[\\|{}@[\]()<>#*_~]/g, (c) => '\\' + c);

export default {
  id: 'linkedin',
  name: 'LinkedIn',
  color: '#0a66c2',
  description: 'Publish native video posts to your LinkedIn profile.',
  roles: { source: false, destination: true },
  auth: 'oauth2',
  oauth: {
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['openid', 'profile', 'w_member_social'],
  },
  limits: { titleMax: 200, captionMax: 3000, maxDuration: 600 },
  defaultTransform: { aspect: 'original', fit: 'blur' },
  defaultTemplates: { title: '{{title}}', caption: '{{description}}\n\n{{hashtags}}' },
  destinationOptions: [],

  async profile(ctx, tokens) {
    const me = await http('https://api.linkedin.com/v2/userinfo', { token: tokens.access_token });
    return { account_id: me.sub, account_name: me.name, avatar_url: me.picture || '' };
  },

  async publish(ctx, post) {
    const token = await ctx.getToken();
    const headers = { 'LinkedIn-Version': linkedinVersion(), 'X-Restli-Protocol-Version': '2.0.0' };
    const owner = `urn:li:person:${ctx.conn.account_id}`;
    const size = fs.statSync(ctx.filePath).size;
    const init = await http(`${API}/videos?action=initializeUpload`, { method: 'POST', token, headers, json: { initializeUploadRequest: { owner, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } } });
    const { uploadInstructions, video, uploadToken } = init.value;
    const fh = await fs.promises.open(ctx.filePath, 'r');
    const etags = [];
    try {
      for (const ins of uploadInstructions) {
        const len = ins.lastByte - ins.firstByte + 1;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, ins.firstByte);
        const r = await fetch(ins.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
        if (!r.ok) throw new ConnectorError(`LinkedIn part upload failed (${r.status})`);
        etags.push(r.headers.get('etag'));
      }
    } finally { await fh.close(); }
    await http(`${API}/videos?action=finalizeUpload`, { method: 'POST', token, headers, json: { finalizeUploadRequest: { video, uploadToken: uploadToken || '', uploadedPartIds: etags } } });
    for (let i = 0; i < 60; i++) {
      const s = await http(`${API}/videos/${encodeURIComponent(video)}`, { token, headers });
      if (s.status === 'AVAILABLE') break;
      if (s.status === 'PROCESSING_FAILED') throw new ConnectorError('LinkedIn failed to process the video', { retryable: false });
      await sleep(5000);
    }
    const res = await http(`${API}/posts`, {
      method: 'POST', token, headers, raw: true,
      json: {
        author: owner, commentary: escapeLittleText(post.caption), visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        content: { media: { title: post.title, id: video } }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
      },
    });
    if (!res.ok) throw new ConnectorError(`LinkedIn post failed (${res.status}): ${(await res.text()).slice(0, 300)}`, { retryable: res.status >= 500 });
    const id = res.headers.get('x-restli-id') || '';
    return { externalId: id, url: id ? `https://www.linkedin.com/feed/update/${id}` : '' };
  },
};
