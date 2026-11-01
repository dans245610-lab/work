import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  credentials TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  demo INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  status_message TEXT NOT NULL DEFAULT '',
  last_polled_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  verifier TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL,
  source_ref TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  download_url TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'video',
  file_path TEXT,
  captions_path TEXT,
  thumb_path TEXT,
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  has_audio INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ready',
  error TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  source_published_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS media_source_ref ON media(connection_id, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS brand_kits (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  logo_path TEXT,
  logo_position TEXT NOT NULL DEFAULT 'top-right',
  logo_scale REAL NOT NULL DEFAULT 0.18,
  logo_opacity REAL NOT NULL DEFAULT 0.9,
  watermark_text TEXT NOT NULL DEFAULT '',
  caption_style TEXT NOT NULL DEFAULT '{}',
  accent_color TEXT NOT NULL DEFAULT '#7c5cff',
  intro_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  outro_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  source_connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  filters TEXT NOT NULL DEFAULT '{}',
  cutoff_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS destinations (
  id INTEGER PRIMARY KEY,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  brand_kit_id INTEGER REFERENCES brand_kits(id) ON DELETE SET NULL,
  transform TEXT NOT NULL DEFAULT '{}',
  title_template TEXT NOT NULL DEFAULT '{{title}}',
  caption_template TEXT NOT NULL DEFAULT '{{description}}',
  schedule TEXT NOT NULL DEFAULT '{"mode":"immediate"}',
  options TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id INTEGER REFERENCES workflows(id) ON DELETE SET NULL,
  destination_id INTEGER REFERENCES destinations(id) ON DELETE SET NULL,
  media_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
  connection_id INTEGER REFERENCES connections(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  transform TEXT NOT NULL DEFAULT '{}',
  brand_kit_id INTEGER,
  schedule TEXT NOT NULL DEFAULT '{"mode":"immediate"}',
  options TEXT NOT NULL DEFAULT '{}',
  output_path TEXT,
  output_meta TEXT NOT NULL DEFAULT '{}',
  scheduled_at INTEGER,
  published_at INTEGER,
  external_id TEXT NOT NULL DEFAULT '',
  external_url TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_user_status ON posts(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS posts_dedupe ON posts(destination_id, media_id) WHERE destination_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT NOT NULL DEFAULT '',
  locked_at INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status, run_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_user ON activity(user_id, created_at DESC);
`;

export const db = new DatabaseSync(path.join(config.dataDir, 'recast.db'));
db.exec('PRAGMA busy_timeout = 5000;');
db.exec(SCHEMA);

export const now = () => Date.now();

const stmtCache = new Map();
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const clean = (row) => (row ? { ...row } : row);
export const get = (sql, ...p) => clean(stmt(sql).get(...p));
export const all = (sql, ...p) => stmt(sql).all(...p).map(clean);
export const run = (sql, ...p) => stmt(sql).run(...p);

export function insert(table, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => ':' + k).join(',')})`;
  return Number(stmt(sql).run(normalize(data)).lastInsertRowid);
}

export function update(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :__id`;
  stmt(sql).run({ ...normalize(data), __id: id });
}

function normalize(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) out[k] = null;
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else if (v !== null && typeof v === 'object') out[k] = JSON.stringify(v);
    else out[k] = v;
  }
  return out;
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const parseJson = (s, d = {}) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function logActivity(userId, message, { level = 'info', refType = '', refId = null } = {}) {
  insert('activity', { user_id: userId, level, message, ref_type: refType, ref_id: refId, created_at: now() });
}
