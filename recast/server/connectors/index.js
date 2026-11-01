import path from 'node:path';
import { config } from '../config.js';
import { get, update, parseJson, now } from '../db.js';
import { encrypt, decrypt, publicRenderUrl } from '../lib/security.js';
import { http, ConnectorError, sleep } from './helpers.js';
import { generateSample } from '../media/ffmpeg.js';
import youtube from './youtube.js';
import tiktok from './tiktok.js';
import instagram from './instagram.js';
import facebook from './facebook.js';
import linkedin from './linkedin.js';
import x from './x.js';
import { upload, folder, rss, profile, webhook } from './local.js';

export const CONNECTORS = Object.fromEntries([upload, tiktok, youtube, instagram, facebook, linkedin, x, rss, profile, folder, webhook].map((c) => [c.id, c]));
export { ConnectorError };

export const getConnector = (id) => {
  const c = CONNECTORS[id];
  if (!c) throw new ConnectorError(`Unknown platform "${id}"`, { retryable: false });
  return c;
};

export function appCredentials(id) {
  const a = config.oauth[id];
  return a && a.clientId && a.clientSecret ? a : null;
}

/** Public, serialisable description for the UI. */
export function describeConnectors() {
  return Object.values(CONNECTORS).map((c) => ({
    id: c.id, name: c.name, color: c.color, description: c.description, roles: c.roles, auth: c.auth, system: !!c.system,
    fields: c.fields || [], limits: c.limits || {}, defaultTransform: c.defaultTransform || { aspect: 'original', fit: 'blur' },
    defaultTemplates: c.defaultTemplates || { title: '{{title}}', caption: '{{description}}' },
    destinationOptions: c.destinationOptions || [], sourceNote: c.sourceNote || '',
    oauthConfigured: c.auth === 'oauth2' ? !!appCredentials(c.id) : null,
    demoAvailable: c.auth === 'oauth2' && config.allowDemo,
    redirectUri: c.auth === 'oauth2' ? `${config.publicBaseUrl}/oauth/callback/${c.id}` : null,
  }));
}

export const redirectUriFor = (id) => `${config.publicBaseUrl}/oauth/callback/${id}`;

export function buildAuthUrl(id, { state, challenge }) {
  const c = getConnector(id);
  const app = appCredentials(id);
  if (!app) throw new ConnectorError(`${c.name} is not configured on this server. Add its client ID/secret to .env.`, { retryable: false });
  const o = c.oauth;
  const params = new URLSearchParams({
    [o.clientIdParam || 'client_id']: app.clientId,
    redirect_uri: redirectUriFor(id),
    response_type: 'code',
    scope: o.scopes.join(o.scopeSeparator || ' '),
    state,
    ...(o.extraAuthParams || {}),
  });
  if (o.pkce) { params.set('code_challenge', challenge); params.set('code_challenge_method', 'S256'); }
  return `${o.authorizeUrl}?${params}`;
}

export async function exchangeCode(id, { code, verifier }) {
  const c = getConnector(id);
  const app = appCredentials(id);
  const ctx = { app };
  const redirectUri = redirectUriFor(id);
  if (c.exchangeCode) return c.exchangeCode(ctx, { code, redirectUri, verifier });
  const form = { grant_type: 'authorization_code', code, redirect_uri: redirectUri };
  if (c.oauth.pkce) form.code_verifier = verifier;
  const headers = {};
  if (c.oauth.tokenAuth === 'basic') {
    headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.clientSecret)}`).toString('base64');
    form.client_id = app.clientId;
  } else Object.assign(form, { client_id: app.clientId, client_secret: app.clientSecret });
  return http(c.oauth.tokenUrl, { method: 'POST', form, headers });
}

async function refreshTokens(c, creds) {
  const app = appCredentials(c.id);
  if (!app) throw new ConnectorError(`${c.name} app credentials are missing on the server`, { retryable: false, reauth: true });
  if (c.refresh) return c.refresh({ app }, creds.refresh_token);
  const form = { grant_type: 'refresh_token', refresh_token: creds.refresh_token };
  const headers = {};
  if (c.oauth.tokenAuth === 'basic') {
    headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.clientSecret)}`).toString('base64');
    form.client_id = app.clientId;
  } else Object.assign(form, { client_id: app.clientId, client_secret: app.clientSecret });
  return http(c.oauth.tokenUrl, { method: 'POST', form, headers });
}

export function normalizeTokens(t, prev = {}) {
  return {
    ...prev,
    ...t,
    access_token: t.access_token,
    refresh_token: t.refresh_token || prev.refresh_token,
    expires_at: t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : t.expires_at || prev.expires_at || null,
  };
}

/** Context object handed to connector methods. */
export function makeContext(connRow, extra = {}) {
  const c = getConnector(connRow.platform);
  const conn = { ...connRow, config: parseJson(connRow.config) };
  let creds = decrypt(connRow.credentials);
  return {
    conn,
    connector: c,
    app: appCredentials(c.id),
    ...extra,
    publicUrl: (ttl) => publicRenderUrl(extra.postId, ttl),
    async getToken() {
      if (!creds.access_token) throw new ConnectorError('Connection has no access token — reconnect it', { retryable: false, reauth: true });
      if (creds.expires_at && creds.expires_at < Date.now() + 120_000 && creds.refresh_token) {
        try {
          creds = normalizeTokens(await refreshTokens(c, creds), creds);
          update('connections', conn.id, { credentials: encrypt(creds), status: 'active', status_message: '' });
        } catch (e) {
          update('connections', conn.id, { status: 'error', status_message: `Token refresh failed: ${e.message}` });
          throw new ConnectorError(`Could not refresh ${c.name} token — reconnect the account`, { retryable: false, reauth: true });
        }
      }
      return creds.access_token;
    },
  };
}

// ---------- Demo mode: simulate a platform end-to-end without API credentials ----------
const DEMO_MAX_ITEMS = 3;

export async function pollConnection(connRow) {
  const c = getConnector(connRow.platform);
  if (connRow.demo) {
    const count = get('SELECT COUNT(*) n FROM media WHERE connection_id = ?', connRow.id).n;
    if (count >= DEMO_MAX_ITEMS) return [];
    const n = count + 1;
    return [{ ref: `demo-${connRow.id}-${n}`, title: `${c.name} demo clip #${n}`, description: `A sample ${c.name} video for testing workflows #demo #recast`, url: '', publishedAt: now(), demo: true }];
  }
  if (!c.poll) return [];
  return c.poll(makeContext(connRow));
}

export async function downloadMedia(connRow, media, dest) {
  if (connRow?.demo || media.meta?.demo) {
    const n = Number(String(media.source_ref).split('-').pop()) || 1;
    const landscape = n % 2 === 1;
    await generateSample(dest, { seconds: 6, width: landscape ? 1280 : 720, height: landscape ? 720 : 1280, label: media.title, hue: n * 70 });
    return {};
  }
  const c = getConnector(connRow.platform);
  if (!c.download) throw new ConnectorError(`${c.name} cannot download media`, { retryable: false });
  return c.download(makeContext(connRow), media, dest);
}

export async function publishPost(connRow, post, filePath) {
  const c = getConnector(connRow.platform);
  if (connRow.demo) {
    await sleep(800);
    return { externalId: `demo_${post.id}_${Date.now().toString(36)}`, url: '', note: `Simulated ${c.name} publish (demo connection)` };
  }
  if (!c.publish) throw new ConnectorError(`${c.name} cannot be used as a destination`, { retryable: false });
  return c.publish(makeContext(connRow, { postId: post.id, filePath }), post);
}

export const isPathInside = (p, root) => path.resolve(p).startsWith(path.resolve(root) + path.sep);
