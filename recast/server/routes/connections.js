import { get, all, insert, update, run, now, parseJson, logActivity } from '../db.js';
import { readJson, sendJson, bad, notFound, redirect, HttpError } from '../lib/http.js';
import { requireUser } from '../auth.js';
import { encrypt, randomToken, pkcePair } from '../lib/security.js';
import { config } from '../config.js';
import { CONNECTORS, getConnector, buildAuthUrl, exchangeCode, normalizeTokens, appCredentials, makeContext, describeConnectors, pollConnection } from '../connectors/index.js';
import { enqueue } from '../jobs.js';

export function publicConnection(c) {
  const meta = CONNECTORS[c.platform];
  const cfg = parseJson(c.config);
  if (cfg.secret) cfg.secret = '••••••';
  return {
    id: c.id, platform: c.platform, platform_name: meta?.name || c.platform, color: meta?.color, label: c.label, account_name: c.account_name, account_id: c.account_id,
    avatar_url: c.avatar_url, config: cfg, demo: !!c.demo, status: c.status, status_message: c.status_message, last_polled_at: c.last_polled_at, created_at: c.created_at,
    roles: meta?.roles || {}, system: !!meta?.system,
    workflow_count: get('SELECT COUNT(*) n FROM workflows WHERE source_connection_id = ? OR id IN (SELECT workflow_id FROM destinations WHERE connection_id = ?)', c.id, c.id).n,
  };
}

export const ownedConnection = (userId, id) => {
  const c = get('SELECT * FROM connections WHERE id = ? AND user_id = ?', Number(id), userId);
  if (!c) throw notFound('Connection not found');
  return c;
};

export default function register(r) {
  r.get('/api/connectors', async (req, res) => { requireUser(req); sendJson(res, 200, { connectors: describeConnectors() }); });

  r.get('/api/connections', async (req, res) => {
    const u = requireUser(req);
    sendJson(res, 200, { connections: all('SELECT * FROM connections WHERE user_id = ? ORDER BY platform = \'upload\' DESC, created_at', u.id).map(publicConnection) });
  });

  // Field-based connections (folder, rss, webhook, profile) and demo connections.
  r.post('/api/connections', async (req, res) => {
    const u = requireUser(req);
    const { platform, label = '', config: cfg = {}, demo = false } = await readJson(req);
    const c = getConnector(platform);
    if (c.system) throw bad('This connection is created automatically');
    let info = {};
    if (demo) {
      if (!config.allowDemo || c.auth !== 'oauth2') throw bad('Demo connections are not available for this platform');
      info = { account_name: `Demo ${c.name}`, account_id: `demo-${randomToken(6)}` };
    } else if (c.auth === 'fields') {
      for (const f of c.fields) if (f.required && !String(cfg[f.key] || '').trim()) throw bad(`${f.label} is required`);
      try { info = await c.validate(cfg); } catch (e) { throw bad(e.message); }
    } else {
      throw bad(`${c.name} connects through OAuth — use the Connect button`);
    }
    const id = insert('connections', { user_id: u.id, platform, label: String(label).slice(0, 100), account_name: info.account_name || '', account_id: info.account_id || '', config: cfg, demo, created_at: now() });
    logActivity(u.id, `Connected ${c.name}${demo ? ' (demo)' : ''}: ${info.account_name || ''}`, { refType: 'connection', refId: id });
    sendJson(res, 201, { connection: publicConnection(get('SELECT * FROM connections WHERE id = ?', id)) });
  });

  r.patch('/api/connections/:id', async (req, res) => {
    const u = requireUser(req);
    const c = ownedConnection(u.id, req.params.id);
    const body = await readJson(req);
    const patch = {};
    if (body.label !== undefined) patch.label = String(body.label).slice(0, 100);
    if (body.status !== undefined && ['active', 'disabled'].includes(body.status)) patch.status = body.status;
    if (body.config) {
      const conn = getConnector(c.platform);
      const merged = { ...parseJson(c.config), ...body.config };
      if (body.config.secret === '••••••') merged.secret = parseJson(c.config).secret;
      if (conn.validate) { try { Object.assign(patch, await conn.validate(merged)); } catch (e) { throw bad(e.message); } }
      patch.config = merged;
    }
    update('connections', c.id, patch);
    sendJson(res, 200, { connection: publicConnection(get('SELECT * FROM connections WHERE id = ?', c.id)) });
  });

  r.delete('/api/connections/:id', async (req, res) => {
    const u = requireUser(req);
    const c = ownedConnection(u.id, req.params.id);
    if (CONNECTORS[c.platform]?.system) throw bad('The library connection cannot be removed');
    run('DELETE FROM connections WHERE id = ?', c.id);
    logActivity(u.id, `Removed connection ${c.account_name || c.platform}`);
    sendJson(res, 200, { ok: true });
  });

  // Check the connection works: for sources, list items without saving them.
  r.post('/api/connections/:id/test', async (req, res) => {
    const u = requireUser(req);
    const c = ownedConnection(u.id, req.params.id);
    const meta = getConnector(c.platform);
    try {
      if (c.demo) return sendJson(res, 200, { ok: true, message: 'Demo connection — publishing is simulated and sources generate sample clips.' });
      if (meta.auth === 'oauth2') {
        const ctx = makeContext(c);
        const tokens = { access_token: await ctx.getToken() };
        const p = await meta.profile(ctx, tokens);
        const prof = Array.isArray(p) ? p.find((x) => x.account_id === c.account_id) || p[0] : p;
        update('connections', c.id, { account_name: prof.account_name, avatar_url: prof.avatar_url || '', status: 'active', status_message: '' });
      } else if (meta.validate) {
        await meta.validate(parseJson(c.config));
      }
      let message = 'Connection works.';
      if (meta.roles.source && meta.poll && !meta.system) {
        const items = await pollConnection(c);
        message += ` Found ${items.length} item${items.length === 1 ? '' : 's'} at the source.`;
      }
      update('connections', c.id, { status: 'active', status_message: '' });
      sendJson(res, 200, { ok: true, message });
    } catch (e) {
      update('connections', c.id, { status_message: e.message.slice(0, 500) });
      sendJson(res, 200, { ok: false, message: e.message });
    }
  });

  r.post('/api/connections/:id/poll', async (req, res) => {
    const u = requireUser(req);
    const c = ownedConnection(u.id, req.params.id);
    enqueue('poll_source', { connectionId: c.id }, { dedupeKey: `poll:${c.id}`, maxAttempts: 1 });
    sendJson(res, 202, { ok: true });
  });

  // ----- OAuth -----
  r.get('/api/oauth/:platform/start', async (req, res) => {
    const u = requireUser(req);
    const c = getConnector(req.params.platform);
    if (c.auth !== 'oauth2') throw bad('Not an OAuth platform');
    if (!appCredentials(c.id)) throw bad(`${c.name} is not configured on this server yet. Add ${c.id.toUpperCase()}_CLIENT_ID / _SECRET to .env, or create a demo connection.`);
    const state = randomToken(24);
    const { verifier, challenge } = pkcePair();
    insert('oauth_states', { state, user_id: u.id, platform: c.id, verifier, created_at: now() });
    sendJson(res, 200, { url: buildAuthUrl(c.id, { state, challenge }) });
  });

  r.get('/oauth/callback/:platform', async (req, res) => {
    const q = req.query;
    const back = (params) => redirect(res, `/#/connections?${new URLSearchParams(params)}`);
    if (q.get('error')) return back({ error: q.get('error_description') || q.get('error') });
    const st = get('SELECT * FROM oauth_states WHERE state = ? AND platform = ?', q.get('state') || '', req.params.platform);
    if (!st || now() - st.created_at > 3600_000) return back({ error: 'Authorization expired — please try again' });
    run('DELETE FROM oauth_states WHERE state = ?', st.state);
    if (req.user && req.user.id !== st.user_id) return back({ error: 'Signed-in user changed during authorization' });
    const c = getConnector(st.platform);
    try {
      const tokens = normalizeTokens(await exchangeCode(c.id, { code: q.get('code'), verifier: st.verifier }));
      const prof = await c.profile({ app: appCredentials(c.id) }, tokens);
      const accounts = Array.isArray(prof) ? prof : [prof];
      for (const a of accounts) {
        const creds = a.credentials ? { ...tokens, ...a.credentials, expires_at: a.credentials.expires_at ?? null, refresh_token: a.credentials.refresh_token ?? null } : tokens;
        const existing = get('SELECT id FROM connections WHERE user_id = ? AND platform = ? AND account_id = ? AND demo = 0', st.user_id, c.id, String(a.account_id));
        const data = { account_name: a.account_name || '', account_id: String(a.account_id), avatar_url: a.avatar_url || '', credentials: encrypt(creds), status: 'active', status_message: '' };
        if (existing) update('connections', existing.id, data);
        else insert('connections', { user_id: st.user_id, platform: c.id, ...data, created_at: now() });
        logActivity(st.user_id, `Connected ${c.name}: ${a.account_name}`, { level: 'success' });
      }
      back({ connected: c.id });
    } catch (e) {
      back({ error: `${c.name}: ${e.message}`.slice(0, 300) });
    }
  });
}
