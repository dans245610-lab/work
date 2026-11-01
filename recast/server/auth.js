import { get, insert, run, now } from './db.js';
import { randomToken, sha256 } from './lib/security.js';
import { HttpError, parseCookies } from './lib/http.js';
import { config } from './config.js';

const COOKIE = 'recast_sid';
const TTL = 30 * 86400_000;

export function createSession(res, userId) {
  const token = randomToken();
  insert('sessions', { token_hash: sha256(token), user_id: userId, expires_at: now() + TTL, created_at: now() });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL / 1000}${config.secureCookies ? '; Secure' : ''}`);
}

export function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function sessionUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = get(`SELECT u.id, u.email, u.name, u.timezone, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`, sha256(token), now());
  return row || null;
}

export function requireUser(req) {
  if (!req.user) throw new HttpError(401, 'Please sign in');
  return req.user;
}

// Simple in-memory login throttle: 10 attempts / 15 minutes per IP+email.
const attempts = new Map();
export function throttle(key) {
  const t = now();
  const a = (attempts.get(key) || []).filter((x) => t - x < 15 * 60_000);
  if (a.length >= 10) throw new HttpError(429, 'Too many attempts — try again in a few minutes');
  a.push(t);
  attempts.set(key, a);
}
export const clearThrottle = (key) => attempts.delete(key);
