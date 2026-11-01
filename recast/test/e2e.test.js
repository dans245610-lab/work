import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, startServer } from './helpers.js';

const { api, close, base } = await startServer();
const { drain } = await import('../server/worker.js');
const { generateSample, probe } = await import('../server/media/ffmpeg.js');
const { config } = await import('../server/config.js');
after(close);

test('auth: signup, me, logout, login, CSRF', async () => {
  let r = await api('POST', '/api/auth/signup', { email: 'a@example.com', password: 'short' });
  assert.equal(r.status, 400);
  r = await api('POST', '/api/auth/signup', { email: 'a@example.com', password: 'password123', name: 'Ann', timezone: 'America/New_York' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.timezone, 'America/New_York');
  r = await api('GET', '/api/auth/me');
  assert.equal(r.data.user.email, 'a@example.com');
  r = await fetch(base + '/api/auth/logout', { method: 'POST' });
  assert.equal(r.status, 403, 'POST without X-Requested-With is rejected');
  await api('POST', '/api/auth/logout');
  r = await api('GET', '/api/connections');
  assert.equal(r.status, 401);
  r = await api('POST', '/api/auth/login', { email: 'a@example.com', password: 'wrongpass' });
  assert.equal(r.status, 401);
  r = await api('POST', '/api/auth/login', { email: 'A@example.com', password: 'password123' });
  assert.equal(r.status, 200);
});

let libraryId, folderId, demoTikTok, demoYouTube, brandId;

test('connections: defaults, folder, demo, oauth not configured', async () => {
  let r = await api('GET', '/api/connections');
  libraryId = r.data.connections.find((c) => c.platform === 'upload').id;
  r = await api('POST', '/api/connections', { platform: 'folder', config: { path: '../../etc' } });
  assert.equal(r.status, 400, 'folder outside root rejected');
  r = await api('POST', '/api/connections', { platform: 'folder', config: { path: 'exports' } });
  assert.equal(r.status, 201);
  folderId = r.data.connection.id;
  r = await api('POST', '/api/connections', { platform: 'tiktok', demo: true });
  demoTikTok = r.data.connection.id;
  r = await api('POST', '/api/connections', { platform: 'youtube', demo: true });
  demoYouTube = r.data.connection.id;
  r = await api('GET', '/api/oauth/youtube/start');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /not configured/);
  r = await api('GET', '/api/connectors');
  assert.ok(r.data.connectors.length >= 10);
});

test('brand kit + logo upload', async () => {
  let r = await api('GET', '/api/brand-kits');
  brandId = r.data.brandKits[0].id;
  const logo = path.join(DATA_DIR, 'logo.png');
  const { run } = await import('../server/media/ffmpeg.js');
  await run(config.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red@0.8:s=200x80,format=rgba', '-frames:v', '1', logo]);
  r = await api('PUT', `/api/brand-kits/${brandId}/logo`, fs.readFileSync(logo), { 'X-Filename': 'logo.png' });
  assert.equal(r.status, 200);
  assert.ok(r.data.brandKit.logo_url);
  r = await api('PATCH', `/api/brand-kits/${brandId}`, { watermark_text: '@ann', logo_position: 'bottom-right', caption_style: { size: 'l', color: '#ffff00', position: 'bottom' } });
  assert.equal(r.data.brandKit.caption_style.color, '#ffff00');
});

test('library workflow: upload → 9:16 render with brand → folder export + demo YouTube', async () => {
  let r = await api('POST', '/api/workflows', {
    name: 'Uploads everywhere', sourceConnectionId: libraryId,
    destinations: [
      { connectionId: folderId, brandKitId: brandId, transform: { aspect: '9:16', fit: 'blur', burnCaptions: true, headline: 'Big news' }, captionTemplate: '{{title}} — {{hashtags}}', options: { addHashtags: 'recast' } },
      { connectionId: demoYouTube, transform: { aspect: '1:1', fit: 'crop', maxDuration: 3 }, schedule: { mode: 'immediate' } },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const wf = r.data.workflow;

  const sample = path.join(DATA_DIR, 'sample.mp4');
  await generateSample(sample, { seconds: 4, label: 'Upload' });
  r = await api('PUT', '/api/media/upload', fs.readFileSync(sample), { 'X-Filename': 'my_first_clip.mp4', 'X-Title': encodeURIComponent('My first clip #launch') });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const media = r.data.media;
  assert.equal(media.status, 'ready');
  assert.equal(media.width, 1280);

  r = await api('PUT', `/api/media/${media.id}/captions`, '1\n00:00:00,000 --> 00:00:02,000\nHello captions\n');
  assert.equal(r.data.cues, 1);

  await drain({ horizonMs: 60_000 });
  r = await api('GET', `/api/posts?workflow=${wf.id}`);
  assert.equal(r.data.posts.length, 2);
  for (const p of r.data.posts) assert.equal(p.status, 'published', `${p.platform}: ${p.error}`);
  const folderPost = r.data.posts.find((p) => p.platform === 'folder');
  assert.deepEqual([folderPost.output_meta.width, folderPost.output_meta.height], [1080, 1920]);
  assert.match(folderPost.caption, /#launch/);
  assert.match(folderPost.caption, /#recast/);
  const yt = r.data.posts.find((p) => p.platform === 'youtube');
  assert.deepEqual([yt.output_meta.width, yt.output_meta.height], [1080, 1080]);
  assert.ok(yt.output_meta.duration <= 3.2);
  const exported = fs.readdirSync(path.join(config.folderRoot, 'exports'));
  assert.ok(exported.some((f) => f.endsWith('.mp4')));
  assert.ok(exported.some((f) => f.endsWith('.txt')));

  // Output file is downloadable with range support
  const out = await api('GET', `/files/posts/${folderPost.id}/output`, null, { Range: 'bytes=0-99' });
  assert.equal(out.status, 206);
  assert.equal(out.data.byteLength, 100);
});

test('polled source workflow with approval + slots schedule', async () => {
  let r = await api('POST', '/api/workflows', {
    name: 'TikTok → YouTube', sourceConnectionId: demoTikTok,
    filters: { excludeKeywords: 'nope' },
    destinations: [{ connectionId: demoYouTube, transform: { aspect: '9:16' }, options: { requireApproval: true }, schedule: { mode: 'slots', days: [0, 1, 2, 3, 4, 5, 6], times: ['09:00', '18:00'] } }],
  });
  assert.equal(r.status, 201);
  const wf = r.data.workflow;
  await drain();
  r = await api('GET', `/api/posts?workflow=${wf.id}`);
  assert.equal(r.data.posts.length, 1);
  const post = r.data.posts[0];
  assert.equal(post.status, 'needs_approval', post.error);
  r = await api('PATCH', `/api/posts/${post.id}`, { caption: 'Edited caption' });
  assert.equal(r.data.post.caption, 'Edited caption');
  r = await api('POST', `/api/posts/${post.id}/approve`, {});
  assert.equal(r.data.post.status, 'scheduled');
  assert.ok(r.data.post.scheduled_at > Date.now());
  r = await api('POST', `/api/posts/${post.id}/publish-now`);
  await drain();
  r = await api('GET', `/api/posts/${post.id}`);
  assert.equal(r.data.post.status, 'published');
  assert.equal(r.data.post.caption, 'Edited caption');

  // backfill / run now
  r = await api('POST', `/api/workflows/${wf.id}/run`);
  assert.equal(r.status, 202);
  await drain();
  r = await api('GET', `/api/media?connection=${demoTikTok}`);
  assert.equal(r.data.total, 2);
});

test('dashboard, activity, meta, public signed URL', async () => {
  let r = await api('GET', '/api/dashboard');
  assert.ok(r.data.counts.published_total >= 3);
  r = await api('GET', '/api/activity');
  assert.ok(r.data.activity.length > 3);
  r = await api('GET', '/api/meta');
  assert.ok(r.data.system.ffmpeg);
  const { publicRenderUrl } = await import('../server/lib/security.js');
  const posts = (await api('GET', '/api/posts?status=published')).data.posts;
  const withOut = posts.find((p) => p.has_output);
  const u = new URL(publicRenderUrl(withOut.id));
  const ok = await fetch(base + u.pathname, { method: 'HEAD' });
  assert.equal(ok.status, 200);
  const bad = await fetch(base + u.pathname.replace(/\/[^/]+\.mp4$/, '/AAAA.mp4'), { method: 'HEAD' });
  assert.equal(bad.status, 404);
});

test('isolation: another user cannot see data', async () => {
  const other = await startServer();
  await other.api('POST', '/api/auth/signup', { email: 'b@example.com', password: 'password123' });
  const r = await other.api('GET', `/api/workflows`);
  assert.equal(r.data.workflows.length, 0);
  const p = await other.api('GET', `/api/posts/1`);
  assert.equal(p.status, 404);
  await other.close();
});
