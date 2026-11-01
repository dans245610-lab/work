import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { run } from '../media/ffmpeg.js';

export class ConnectorError extends Error {
  constructor(message, { retryable = true, reauth = false } = {}) { super(message); this.retryable = retryable; this.reauth = reauth; }
}

const UA = 'Recast/1.0 (+self-hosted content repurposing)';

/** fetch + JSON with good error messages. */
export async function http(url, { method = 'GET', headers = {}, body, json, form, token, raw = false, timeoutMs = 120000 } = {}) {
  const h = { 'User-Agent': UA, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form !== undefined) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  const res = await fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(timeoutMs), duplex: body && typeof body.pipe === 'function' ? 'half' : undefined });
  if (raw) return res;
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error_description || data?.message || data?.detail || data?.error?.code || (typeof data?.error === 'string' ? data.error : '') || text.slice(0, 300);
    throw new ConnectorError(`${method} ${new URL(url).host}${new URL(url).pathname} → ${res.status}: ${msg}`, {
      retryable: res.status >= 500 || res.status === 429,
      reauth: res.status === 401,
    });
  }
  return data;
}

/** Download URL to a file with a size limit. */
export async function downloadToFile(url, dest, { headers = {}, limit = config.maxUploadBytes } = {}) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!res.ok || !res.body) throw new ConnectorError(`Download failed (${res.status}) from ${new URL(url).host}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > limit) throw new ConnectorError('Remote file is larger than the upload limit', { retryable: false });
  let size = 0;
  const counter = new TransformStream({ transform(chunk, ctrl) { size += chunk.length; if (size > limit) ctrl.error(new Error('Remote file too large')); else ctrl.enqueue(chunk); } });
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), fs.createWriteStream(dest));
  return { contentType: res.headers.get('content-type') || '', size };
}

export async function ytdlpAvailable() {
  try { await run(config.ytdlp, ['--version'], { timeoutMs: 10000 }); return true; } catch { return false; }
}

/** List recent items of a profile/channel/playlist URL with yt-dlp. */
export async function ytdlpList(url, limit = 15) {
  const out = await run(config.ytdlp, ['--flat-playlist', '-J', '--playlist-end', String(limit), '--no-warnings', url], { timeoutMs: 180000 });
  const j = JSON.parse(out);
  return (j.entries || [j]).filter(Boolean).map((e) => ({
    ref: String(e.id),
    title: e.title || '',
    description: e.description || '',
    url: e.url?.startsWith('http') ? e.url : e.webpage_url || e.original_url || url,
    publishedAt: e.timestamp ? e.timestamp * 1000 : e.upload_date ? Date.parse(`${e.upload_date.slice(0, 4)}-${e.upload_date.slice(4, 6)}-${e.upload_date.slice(6, 8)}`) : null,
  }));
}

/** Download a single video with yt-dlp; returns metadata. */
export async function ytdlpDownload(url, dest) {
  const base = dest.replace(/\.[^.]+$/, '');
  const out = await run(config.ytdlp, ['--no-playlist', '--no-warnings', '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b', '--merge-output-format', 'mp4',
    '-o', `${base}.%(ext)s`, '--print-json', '--no-simulate', url], { timeoutMs: 60 * 60 * 1000 });
  const info = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop() || '{}');
  const file = [`${base}.mp4`, `${base}.mkv`, `${base}.webm`].find((f) => fs.existsSync(f));
  if (!file) throw new ConnectorError('yt-dlp finished but no file was produced');
  if (file !== dest) fs.renameSync(file, dest);
  return { title: info.title || '', description: info.description || '', publishedAt: info.timestamp ? info.timestamp * 1000 : null, ref: info.id ? String(info.id) : null };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read a file in chunks (for chunked uploads). */
export async function* fileChunks(file, chunkSize) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    for (let offset = 0; offset < size; offset += chunkSize) {
      const len = Math.min(chunkSize, size - offset);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      yield { buf, offset, size, index: Math.floor(offset / chunkSize) };
    }
  } finally { await fh.close(); }
}

/** Resolve a user-provided folder path safely inside FOLDER_ROOT. */
export function safeFolder(p) {
  const resolved = path.resolve(config.folderRoot, p || '.');
  if (resolved !== config.folderRoot && !resolved.startsWith(config.folderRoot + path.sep)) {
    throw new ConnectorError(`Folder must be inside ${config.folderRoot}`, { retryable: false });
  }
  return resolved;
}
