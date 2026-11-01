import fs from 'node:fs';
import path from 'node:path';
import { get, all, insert, update, run, now, parseJson } from '../db.js';
import { readJson, sendJson, sendFile, streamToFile, bad, notFound } from '../lib/http.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { probe } from '../media/ffmpeg.js';

const owned = (userId, id) => {
  const b = get('SELECT * FROM brand_kits WHERE id = ? AND user_id = ?', Number(id), userId);
  if (!b) throw notFound('Brand kit not found');
  return b;
};

const pub = (b) => {
  const media = (id) => id && get('SELECT id, title, duration, thumb_path, created_at FROM media WHERE id = ?', id);
  const toM = (m) => m && { id: m.id, title: m.title, duration: m.duration, thumb_url: m.thumb_path ? `/files/media/${m.id}/thumb?v=${m.created_at}` : '' };
  return {
    id: b.id, name: b.name, logo_url: b.logo_path ? `/files/brand/${b.id}/logo?v=${fs.existsSync(b.logo_path) ? fs.statSync(b.logo_path).mtimeMs : 0}` : '',
    logo_position: b.logo_position, logo_scale: b.logo_scale, logo_opacity: b.logo_opacity, watermark_text: b.watermark_text,
    caption_style: parseJson(b.caption_style), accent_color: b.accent_color, intro: toM(media(b.intro_media_id)), outro: toM(media(b.outro_media_id)),
    intro_media_id: b.intro_media_id, outro_media_id: b.outro_media_id,
  };
};

const POS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];

function patchFrom(userId, body) {
  const p = {};
  if (body.name !== undefined) { if (!String(body.name).trim()) throw bad('Name is required'); p.name = String(body.name).trim().slice(0, 80); }
  if (body.logo_position !== undefined) { if (!POS.includes(body.logo_position)) throw bad('Invalid logo position'); p.logo_position = body.logo_position; }
  if (body.logo_scale !== undefined) p.logo_scale = Math.min(0.8, Math.max(0.03, Number(body.logo_scale) || 0.18));
  if (body.logo_opacity !== undefined) p.logo_opacity = Math.min(1, Math.max(0.05, Number(body.logo_opacity) || 0.9));
  if (body.watermark_text !== undefined) p.watermark_text = String(body.watermark_text).slice(0, 80);
  if (body.accent_color !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(body.accent_color)) throw bad('Accent color must be a hex color'); p.accent_color = body.accent_color; }
  if (body.caption_style !== undefined) {
    const cs = body.caption_style || {};
    p.caption_style = {
      size: ['s', 'm', 'l', 'xl'].includes(cs.size) ? cs.size : 'm',
      color: /^#[0-9a-f]{6}$/i.test(cs.color) ? cs.color : '#ffffff',
      outline: /^#[0-9a-f]{6}$/i.test(cs.outline) ? cs.outline : '#000000',
      position: ['top', 'middle', 'bottom'].includes(cs.position) ? cs.position : 'bottom',
      box: !!cs.box,
    };
  }
  for (const k of ['intro_media_id', 'outro_media_id']) {
    if (body[k] === undefined) continue;
    if (body[k] === null || body[k] === '') { p[k] = null; continue; }
    const m = get(`SELECT id, kind, status FROM media WHERE id = ? AND user_id = ?`, Number(body[k]), userId);
    if (!m || m.kind !== 'video' || m.status !== 'ready') throw bad('Intro/outro must be a ready video from your library');
    p[k] = m.id;
  }
  return p;
}

export default function register(r) {
  r.get('/api/brand-kits', async (req, res) => {
    const u = requireUser(req);
    sendJson(res, 200, { brandKits: all('SELECT * FROM brand_kits WHERE user_id = ? ORDER BY id', u.id).map(pub) });
  });
  r.post('/api/brand-kits', async (req, res) => {
    const u = requireUser(req);
    const body = await readJson(req);
    const id = insert('brand_kits', { user_id: u.id, name: 'New brand kit', created_at: now(), caption_style: {}, ...patchFrom(u.id, { name: body.name || 'New brand kit', ...body }) });
    sendJson(res, 201, { brandKit: pub(get('SELECT * FROM brand_kits WHERE id = ?', id)) });
  });
  r.patch('/api/brand-kits/:id', async (req, res) => {
    const u = requireUser(req);
    const b = owned(u.id, req.params.id);
    update('brand_kits', b.id, patchFrom(u.id, await readJson(req)));
    sendJson(res, 200, { brandKit: pub(get('SELECT * FROM brand_kits WHERE id = ?', b.id)) });
  });
  r.delete('/api/brand-kits/:id', async (req, res) => {
    const u = requireUser(req);
    const b = owned(u.id, req.params.id);
    if (b.logo_path) fs.rmSync(b.logo_path, { force: true });
    run('DELETE FROM brand_kits WHERE id = ?', b.id);
    sendJson(res, 200, { ok: true });
  });
  r.put('/api/brand-kits/:id/logo', async (req, res) => {
    const u = requireUser(req);
    const b = owned(u.id, req.params.id);
    const name = String(req.headers['x-filename'] || 'logo.png');
    const ext = path.extname(name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw bad('Logo must be a PNG, JPG or WebP image (PNG with transparency works best)');
    const file = path.join(config.dataDir, 'brand', `${b.id}-${Date.now()}${ext}`);
    await streamToFile(req, file, 10 * 1024 * 1024);
    try { const p = await probe(file); if (!p.width) throw new Error('not an image'); } catch { fs.rmSync(file, { force: true }); throw bad('That file is not a readable image'); }
    if (b.logo_path) fs.rmSync(b.logo_path, { force: true });
    update('brand_kits', b.id, { logo_path: file });
    sendJson(res, 200, { brandKit: pub(get('SELECT * FROM brand_kits WHERE id = ?', b.id)) });
  });
  r.delete('/api/brand-kits/:id/logo', async (req, res) => {
    const u = requireUser(req);
    const b = owned(u.id, req.params.id);
    if (b.logo_path) fs.rmSync(b.logo_path, { force: true });
    update('brand_kits', b.id, { logo_path: null });
    sendJson(res, 200, { brandKit: pub(get('SELECT * FROM brand_kits WHERE id = ?', b.id)) });
  });
  r.get('/files/brand/:id/logo', async (req, res) => {
    const u = requireUser(req);
    const b = owned(u.id, req.params.id);
    if (!b.logo_path) throw notFound();
    sendFile(req, res, b.logo_path);
  });
}
