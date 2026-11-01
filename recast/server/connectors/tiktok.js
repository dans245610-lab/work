import fs from 'node:fs';
import { http, ConnectorError, fileChunks, sleep, ytdlpDownload } from './helpers.js';

const API = 'https://open.tiktokapis.com/v2';
const MB = 1024 * 1024;

export function tiktokChunkPlan(size) {
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * MB;
  return { chunkSize, count: Math.floor(size / chunkSize) }; // last chunk absorbs the remainder
}

export default {
  id: 'tiktok',
  name: 'TikTok',
  color: '#111111',
  description: 'Use your TikToks as the source for everything else, or post to TikTok (direct post or drafts inbox).',
  roles: { source: true, destination: true },
  auth: 'oauth2',
  oauth: {
    authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: `${API}/oauth/token/`,
    scopes: ['user.info.basic', 'video.list', 'video.upload', 'video.publish'],
    scopeSeparator: ',',
    clientIdParam: 'client_key',
  },
  limits: { titleMax: 0, captionMax: 2200, maxDuration: 600 },
  defaultTransform: { aspect: '9:16', fit: 'blur' },
  defaultTemplates: { title: '{{title}}', caption: '{{description}}' },
  destinationOptions: [
    { key: 'tiktokMode', label: 'Posting mode', type: 'select', options: ['direct', 'inbox'], default: 'direct', help: 'Unaudited TikTok apps can only post privately or send to the drafts inbox.' },
    { key: 'privacy', label: 'Privacy', type: 'select', options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'], default: 'PUBLIC_TO_EVERYONE' },
  ],
  sourceNote: "TikTok's API lists your videos but does not hand out the files, so downloads use yt-dlp on the server.",

  async exchangeCode(ctx, { code, redirectUri, verifier }) {
    return http(`${API}/oauth/token/`, { method: 'POST', form: { client_key: ctx.app.clientId, client_secret: ctx.app.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri, ...(verifier ? { code_verifier: verifier } : {}) } });
  },
  async refresh(ctx, refreshToken) {
    return http(`${API}/oauth/token/`, { method: 'POST', form: { client_key: ctx.app.clientId, client_secret: ctx.app.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken } });
  },

  async profile(ctx, tokens) {
    const r = await http(`${API}/user/info/?fields=open_id,display_name,avatar_url,username`, { token: tokens.access_token });
    const u = r.data?.user || {};
    return { account_id: u.open_id || tokens.open_id, account_name: u.username ? `@${u.username}` : u.display_name, avatar_url: u.avatar_url || '' };
  },

  async poll(ctx) {
    const r = await http(`${API}/video/list/?fields=id,title,video_description,create_time,share_url,duration,cover_image_url`, { method: 'POST', token: await ctx.getToken(), json: { max_count: 20 } });
    return (r.data?.videos || []).map((v) => ({ ref: String(v.id), title: v.title || (v.video_description || '').split('\n')[0].slice(0, 90), description: v.video_description || '', url: v.share_url, publishedAt: v.create_time * 1000, thumbUrl: v.cover_image_url }));
  },

  async download(ctx, media, dest) {
    return ytdlpDownload(media.source_url, dest);
  },

  async publish(ctx, post) {
    const token = await ctx.getToken();
    const size = fs.statSync(ctx.filePath).size;
    const { chunkSize, count } = tiktokChunkPlan(size);
    const opts = post.options || {};
    const sourceInfo = { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: count };
    let init;
    if (opts.tiktokMode === 'inbox') {
      init = await http(`${API}/post/publish/inbox/video/init/`, { method: 'POST', token, json: { source_info: sourceInfo } });
    } else {
      const creator = await http(`${API}/post/publish/creator_info/query/`, { method: 'POST', token, json: {} });
      const allowed = creator.data?.privacy_level_options || [];
      const privacy = allowed.includes(opts.privacy) ? opts.privacy : allowed.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : allowed[0] || 'SELF_ONLY';
      if (creator.data?.max_video_post_duration_sec && post.output_meta?.duration > creator.data.max_video_post_duration_sec) {
        throw new ConnectorError(`Video is longer than this TikTok account allows (${creator.data.max_video_post_duration_sec}s)`, { retryable: false });
      }
      init = await http(`${API}/post/publish/video/init/`, { method: 'POST', token, json: { post_info: { title: post.caption.slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false }, source_info: sourceInfo } });
    }
    const { publish_id: publishId, upload_url: uploadUrl } = init.data || {};
    if (!uploadUrl) throw new ConnectorError('TikTok did not return an upload URL');
    let sent = 0;
    for await (const { buf, offset, index } of fileChunks(ctx.filePath, chunkSize)) {
      // The final declared chunk absorbs any remainder.
      if (index >= count) break;
      const isLast = index === count - 1;
      const data = isLast ? fs.readFileSync(ctx.filePath).subarray(offset) : buf;
      const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(data.length), 'Content-Range': `bytes ${offset}-${offset + data.length - 1}/${size}` }, body: data });
      if (![200, 201, 206].includes(res.status)) throw new ConnectorError(`TikTok chunk upload failed (${res.status})`);
      sent += data.length;
    }
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const s = await http(`${API}/post/publish/status/fetch/`, { method: 'POST', token, json: { publish_id: publishId } });
      const st = s.data?.status;
      if (st === 'PUBLISH_COMPLETE') {
        const id = s.data?.publicaly_available_post_id?.[0];
        return { externalId: String(id || publishId), url: id ? `https://www.tiktok.com/${ctx.conn.account_name || '@'}/video/${id}` : '' };
      }
      if (st === 'SEND_TO_USER_INBOX') return { externalId: publishId, url: '', note: 'Sent to TikTok drafts inbox — finish posting in the app.' };
      if (st === 'FAILED') throw new ConnectorError(`TikTok rejected the post: ${s.data?.fail_reason || 'unknown reason'}`, { retryable: false });
    }
    return { externalId: publishId, url: '', note: 'TikTok is still processing the upload.' };
  },
};
