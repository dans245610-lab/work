import { get, insert, update, now, run } from '../db.js';
import { hashPassword, verifyPassword } from '../lib/security.js';
import { readJson, sendJson, bad, HttpError } from '../lib/http.js';
import { createSession, destroySession, requireUser, throttle, clearThrottle } from '../auth.js';
import { isValidTimeZone } from '../lib/schedule.js';

export function ensureUserDefaults(userId) {
  if (!get(`SELECT id FROM connections WHERE user_id = ? AND platform = 'upload'`, userId)) {
    insert('connections', { user_id: userId, platform: 'upload', label: 'Library uploads', account_name: 'Uploads & URL imports', created_at: now() });
  }
  if (!get('SELECT id FROM brand_kits WHERE user_id = ?', userId)) {
    insert('brand_kits', { user_id: userId, name: 'Default brand', caption_style: { size: 'm', color: '#ffffff', outline: '#000000', position: 'bottom', box: false }, created_at: now() });
  }
}

export default function register(r) {
  r.post('/api/auth/signup', async (req, res) => {
    const { email, password, name, timezone } = await readJson(req);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) throw bad('Enter a valid email address');
    if (!password || password.length < 8) throw bad('Password must be at least 8 characters');
    if (get('SELECT id FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with that email already exists');
    const id = insert('users', { email: email.trim(), name: (name || '').trim().slice(0, 100), password_hash: hashPassword(password), timezone: isValidTimeZone(timezone) ? timezone : 'UTC', created_at: now() });
    ensureUserDefaults(id);
    createSession(res, id);
    sendJson(res, 201, { user: get('SELECT id, email, name, timezone, created_at FROM users WHERE id = ?', id) });
  });

  r.post('/api/auth/login', async (req, res) => {
    const { email, password } = await readJson(req);
    const key = `${req.socket.remoteAddress}:${String(email).toLowerCase()}`;
    throttle(key);
    const u = get('SELECT * FROM users WHERE email = ?', email || '');
    if (!u || !verifyPassword(password || '', u.password_hash)) throw new HttpError(401, 'Incorrect email or password');
    clearThrottle(key);
    ensureUserDefaults(u.id);
    createSession(res, u.id);
    sendJson(res, 200, { user: { id: u.id, email: u.email, name: u.name, timezone: u.timezone, created_at: u.created_at } });
  });

  r.post('/api/auth/logout', async (req, res) => { destroySession(req, res); sendJson(res, 200, { ok: true }); });

  r.get('/api/auth/me', async (req, res) => sendJson(res, 200, { user: req.user || null }));

  r.patch('/api/auth/me', async (req, res) => {
    const u = requireUser(req);
    const { name, timezone } = await readJson(req);
    const patch = {};
    if (name !== undefined) patch.name = String(name).slice(0, 100);
    if (timezone !== undefined) { if (!isValidTimeZone(timezone)) throw bad('Unknown time zone'); patch.timezone = timezone; }
    update('users', u.id, patch);
    sendJson(res, 200, { user: get('SELECT id, email, name, timezone, created_at FROM users WHERE id = ?', u.id) });
  });

  r.post('/api/auth/password', async (req, res) => {
    const u = requireUser(req);
    const { current, next } = await readJson(req);
    const row = get('SELECT password_hash FROM users WHERE id = ?', u.id);
    if (!verifyPassword(current || '', row.password_hash)) throw new HttpError(400, 'Current password is incorrect');
    if (!next || next.length < 8) throw bad('New password must be at least 8 characters');
    update('users', u.id, { password_hash: hashPassword(next) });
    sendJson(res, 200, { ok: true });
  });

  r.delete('/api/auth/me', async (req, res) => {
    const u = requireUser(req);
    const { password } = await readJson(req);
    const row = get('SELECT password_hash FROM users WHERE id = ?', u.id);
    if (!verifyPassword(password || '', row.password_hash)) throw new HttpError(400, 'Password is incorrect');
    destroySession(req, res);
    run('DELETE FROM users WHERE id = ?', u.id);
    sendJson(res, 200, { ok: true });
  });
}
