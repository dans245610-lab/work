import fs from 'node:fs';
import { get, all, now } from '../db.js';
import { sendJson, sendFile, notFound } from '../lib/http.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { publicPost } from './posts.js';
import { binaryVersion, FONT_FILE, ASPECTS } from '../media/ffmpeg.js';
import { ytdlpAvailable } from '../connectors/helpers.js';
import { TEMPLATE_VARS } from '../lib/templates.js';
import { verifySignature } from '../lib/security.js';
import { queueStats } from '../worker.js';

let sysCache = null;
async function systemStatus() {
  if (sysCache && sysCache.at > now() - 60_000) return sysCache.data;
  const data = {
    ffmpeg: await binaryVersion(config.ffmpeg),
    ytdlp: (await ytdlpAvailable()) ? await binaryVersion(config.ytdlp, ['--version']) : null,
    font: FONT_FILE ? FONT_FILE.split('/').pop() : null,
    publicBaseUrl: config.publicBaseUrl,
    publicUrlIsPublic: !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.)/.test(config.publicBaseUrl),
    allowDemo: config.allowDemo,
    pollIntervalMinutes: config.pollIntervalMinutes,
    folderRoot: config.folderRoot,
    maxUploadMb: Math.round(config.maxUploadBytes / 1048576),
  };
  sysCache = { at: now(), data };
  return data;
}

export default function register(r) {
  r.get('/api/meta', async (req, res) => {
    requireUser(req);
    sendJson(res, 200, { system: await systemStatus(), templateVars: TEMPLATE_VARS, aspects: ['original', ...Object.keys(ASPECTS)], queue: queueStats() });
  });

  r.get('/api/dashboard', async (req, res) => {
    const u = requireUser(req);
    const weekAgo = now() - 7 * 86400_000;
    const counts = get(`SELECT
      SUM(status='published' AND published_at >= ?) published_week,
      SUM(status='published') published_total,
      SUM(status IN ('scheduled','publishing')) scheduled,
      SUM(status IN ('waiting_media','rendering')) processing,
      SUM(status='needs_approval') review,
      SUM(status='failed') failed
      FROM posts WHERE user_id = ?`, weekAgo, u.id);
    const days = 14;
    const start = new Date(); start.setUTCHours(0, 0, 0, 0); const startTs = start.getTime() - (days - 1) * 86400_000;
    const series = Array.from({ length: days }, (_, i) => ({ day: new Date(startTs + i * 86400_000).toISOString().slice(0, 10), count: 0 }));
    for (const row of all(`SELECT published_at FROM posts WHERE user_id = ? AND status='published' AND published_at >= ?`, u.id, startTs)) {
      const idx = Math.floor((row.published_at - startTs) / 86400_000);
      if (series[idx]) series[idx].count++;
    }
    const byPlatform = all(`SELECT platform, COUNT(*) n FROM posts WHERE user_id = ? AND status='published' AND published_at >= ? GROUP BY platform ORDER BY n DESC`, u.id, now() - 30 * 86400_000);
    const upcoming = all(`SELECT * FROM posts WHERE user_id = ? AND status IN ('scheduled','needs_approval','rendering','waiting_media','publishing') ORDER BY COALESCE(scheduled_at, created_at) LIMIT 8`, u.id).map(publicPost);
    const recent = all(`SELECT * FROM posts WHERE user_id = ? AND status IN ('published','failed') ORDER BY updated_at DESC LIMIT 8`, u.id).map(publicPost);
    const activity = all('SELECT * FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT 12', u.id);
    const setup = {
      connections: get(`SELECT COUNT(*) n FROM connections WHERE user_id = ? AND platform != 'upload'`, u.id).n,
      workflows: get('SELECT COUNT(*) n FROM workflows WHERE user_id = ?', u.id).n,
      media: get('SELECT COUNT(*) n FROM media WHERE user_id = ?', u.id).n,
      brandLogo: !!get('SELECT id FROM brand_kits WHERE user_id = ? AND logo_path IS NOT NULL', u.id),
    };
    sendJson(res, 200, {
      counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v || 0])),
      series, byPlatform, upcoming, recent, activity, setup,
    });
  });

  r.get('/api/activity', async (req, res) => {
    const u = requireUser(req);
    const before = Number(req.query.get('before')) || Number.MAX_SAFE_INTEGER;
    const level = req.query.get('level');
    const rows = level
      ? all('SELECT * FROM activity WHERE user_id = ? AND id < ? AND level = ? ORDER BY id DESC LIMIT 100', u.id, before, level)
      : all('SELECT * FROM activity WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT 100', u.id, before);
    sendJson(res, 200, { activity: rows });
  });

  // Signed, expiring public URL for rendered videos (Instagram / Facebook / webhooks pull from here).
  r.get('/public/render/:postId/:exp/:sig', async (req, res) => {
    const { postId, exp } = req.params;
    const sig = req.params.sig.replace(/\.mp4$/, '');
    if (Number(exp) * 1000 < now() || !verifySignature(`render:${postId}:${exp}`, sig)) throw notFound();
    const p = get('SELECT output_path FROM posts WHERE id = ?', Number(postId));
    if (!p?.output_path || !fs.existsSync(p.output_path)) throw notFound();
    sendFile(req, res, p.output_path, { cache: 'public, max-age=600' });
  });
}
