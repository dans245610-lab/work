import crypto from 'node:crypto';
import { config } from '../config.js';

const key = crypto.createHash('sha256').update('enc:' + config.secret).digest();
const signKey = crypto.createHash('sha256').update('sig:' + config.secret).digest();

export function encrypt(obj) {
  if (obj == null) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decrypt(str) {
  if (!str) return {};
  const [v, iv, tag, data] = str.split('.');
  if (v !== 'v1') return {};
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8'));
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${h.toString('base64url')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, salt, h] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(h, 'base64url');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64url'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, got);
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function sign(value) {
  return crypto.createHmac('sha256', signKey).update(value).digest('base64url').slice(0, 32);
}
export function verifySignature(value, sig) {
  const a = Buffer.from(sign(value));
  const b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Time-limited public URL for a rendered post (platforms that pull video by URL need this). */
export function publicRenderUrl(postId, ttlSec = 6 * 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${config.publicBaseUrl}/public/render/${postId}/${exp}/${sign(`render:${postId}:${exp}`)}.mp4`;
}

export function pkcePair() {
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
