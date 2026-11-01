import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (does not override variables already set in the environment).
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

const env = (k, d = '') => (process.env[k] ?? '') !== '' ? process.env[k] : d;

export function buildConfig() {
  const dataDir = path.resolve(ROOT, env('DATA_DIR', './data'));
  fs.mkdirSync(dataDir, { recursive: true });
  let secret = env('RECAST_SECRET');
  if (!secret) {
    const f = path.join(dataDir, '.secret');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    secret = fs.readFileSync(f, 'utf8').trim();
  }
  const port = Number(env('PORT', '4000'));
  const cfg = {
    port,
    publicBaseUrl: env('PUBLIC_BASE_URL', `http://localhost:${port}`).replace(/\/$/, ''),
    dataDir,
    mediaDir: path.join(dataDir, 'media'),
    rendersDir: path.join(dataDir, 'renders'),
    tmpDir: path.join(dataDir, 'tmp'),
    folderRoot: path.resolve(env('FOLDER_ROOT', path.join(dataDir, 'folders'))),
    secret,
    workerConcurrency: Number(env('WORKER_CONCURRENCY', '2')),
    pollIntervalMinutes: Number(env('POLL_INTERVAL_MINUTES', '10')),
    ffmpeg: env('FFMPEG_PATH', 'ffmpeg'),
    ffprobe: env('FFPROBE_PATH', 'ffprobe'),
    ytdlp: env('YTDLP_PATH', 'yt-dlp'),
    allowDemo: env('ALLOW_DEMO_CONNECTIONS', 'true') !== 'false',
    maxUploadBytes: Number(env('MAX_UPLOAD_MB', '2048')) * 1024 * 1024,
    secureCookies: env('PUBLIC_BASE_URL', '').startsWith('https://'),
    oauth: {
      youtube: { clientId: env('YOUTUBE_CLIENT_ID'), clientSecret: env('YOUTUBE_CLIENT_SECRET') },
      tiktok: { clientId: env('TIKTOK_CLIENT_KEY'), clientSecret: env('TIKTOK_CLIENT_SECRET') },
      instagram: { clientId: env('INSTAGRAM_CLIENT_ID'), clientSecret: env('INSTAGRAM_CLIENT_SECRET') },
      facebook: { clientId: env('FACEBOOK_CLIENT_ID'), clientSecret: env('FACEBOOK_CLIENT_SECRET') },
      linkedin: { clientId: env('LINKEDIN_CLIENT_ID'), clientSecret: env('LINKEDIN_CLIENT_SECRET') },
      x: { clientId: env('X_CLIENT_ID'), clientSecret: env('X_CLIENT_SECRET') },
    },
  };
  for (const d of [cfg.mediaDir, cfg.rendersDir, cfg.tmpDir, cfg.folderRoot]) fs.mkdirSync(d, { recursive: true });
  return cfg;
}

export const config = buildConfig();
