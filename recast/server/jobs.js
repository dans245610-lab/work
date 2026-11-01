import { db, get, run, now, parseJson } from './db.js';

export function enqueue(type, payload = {}, { runAt = now(), dedupeKey = null, maxAttempts = 3 } = {}) {
  const r = run(`INSERT OR IGNORE INTO jobs (type, payload, dedupe_key, status, run_at, max_attempts, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    type, JSON.stringify(payload), dedupeKey, runAt, maxAttempts, now());
  return r.changes ? Number(r.lastInsertRowid) : null;
}

export function claimJob() {
  const row = get(`UPDATE jobs SET status = 'running', locked_at = ?, attempts = attempts + 1
    WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, id LIMIT 1)
    RETURNING *`, now(), now());
  return row ? { ...row, payload: parseJson(row.payload) } : null;
}

export function completeJob(id) {
  run(`UPDATE jobs SET status = 'done', finished_at = ?, locked_at = NULL WHERE id = ?`, now(), id);
}

/** Returns true if the job will be retried. */
export function failJob(job, err) {
  const retry = err?.retryable !== false && job.attempts < job.max_attempts;
  if (retry) {
    const delay = Math.min(60 * 60_000, 30_000 * 2 ** (job.attempts - 1));
    run(`UPDATE jobs SET status = 'pending', run_at = ?, last_error = ?, locked_at = NULL WHERE id = ?`, now() + delay, String(err?.message || err).slice(0, 2000), job.id);
  } else {
    run(`UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, locked_at = NULL WHERE id = ?`, String(err?.message || err).slice(0, 2000), now(), job.id);
  }
  return retry;
}

/** On boot, anything left "running" was interrupted. */
export function recoverJobs() {
  run(`UPDATE jobs SET status = 'pending', locked_at = NULL WHERE status = 'running'`);
}

export function cancelJobs(dedupeKey) {
  run(`UPDATE jobs SET status = 'canceled', finished_at = ? WHERE dedupe_key = ? AND status = 'pending'`, now(), dedupeKey);
}

export function pruneJobs(olderThanMs = 7 * 86400_000) {
  run(`DELETE FROM jobs WHERE status IN ('done','canceled','failed') AND finished_at < ?`, now() - olderThanMs);
}

export const pendingCount = () => get(`SELECT COUNT(*) n FROM jobs WHERE status IN ('pending','running')`).n;
export { db };
