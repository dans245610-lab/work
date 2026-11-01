import { all, get, run, now } from './db.js';
import { config } from './config.js';
import { claimJob, completeJob, failJob, enqueue, recoverJobs, pruneJobs } from './jobs.js';
import { pollSource, downloadMediaJob, onDownloadFailed, renderPostJob, onRenderFailed, publishPostJob, onPublishFailed, pruneRenders } from './pipeline.js';

const HANDLERS = {
  poll_source: { run: (p) => pollSource(p.connectionId) },
  download_media: { run: (p) => downloadMediaJob(p.mediaId), fail: (p, e, retry) => { if (!retry) onDownloadFailed(p.mediaId, e); } },
  render_post: { run: (p) => renderPostJob(p.postId), fail: (p, e, retry) => { if (!retry) onRenderFailed(p.postId, e); } },
  publish_post: { run: (p) => publishPostJob(p.postId), fail: (p, e, retry) => onPublishFailed(p.postId, e, retry) },
};

let active = 0;
let timer = null;
let tickTimer = null;
const log = (...a) => { if (process.env.NODE_ENV !== 'test') console.log('[worker]', ...a); };

export async function runJob(job) {
  const h = HANDLERS[job.type];
  try {
    if (!h) throw Object.assign(new Error(`Unknown job type ${job.type}`), { retryable: false });
    await h.run(job.payload);
    completeJob(job.id);
  } catch (e) {
    const retry = failJob(job, e);
    log(`${job.type}#${job.id} failed${retry ? ' (will retry)' : ''}:`, e.message);
    try { h?.fail?.(job.payload, e, retry); } catch (e2) { log('fail handler error', e2.message); }
  }
}

function pump() {
  while (active < config.workerConcurrency) {
    const job = claimJob();
    if (!job) break;
    active++;
    runJob(job).finally(() => { active--; setImmediate(pump); });
  }
}

/** Enqueue polls for every source that feeds an enabled workflow and is due. */
export function schedulerTick() {
  const due = now() - config.pollIntervalMinutes * 60_000;
  const conns = all(`SELECT DISTINCT c.id FROM connections c JOIN workflows w ON w.source_connection_id = c.id
    WHERE w.enabled = 1 AND c.platform != 'upload' AND c.status != 'disabled' AND (c.last_polled_at IS NULL OR c.last_polled_at < ?)`, due);
  for (const c of conns) enqueue('poll_source', { connectionId: c.id }, { dedupeKey: `poll:${c.id}`, maxAttempts: 1 });
  run('DELETE FROM oauth_states WHERE created_at < ?', now() - 3600_000);
  run('DELETE FROM sessions WHERE expires_at < ?', now());
}

export function startWorker() {
  recoverJobs();
  timer = setInterval(pump, 1000);
  tickTimer = setInterval(() => {
    try { schedulerTick(); } catch (e) { log('tick error', e.message); }
  }, 30_000);
  setInterval(() => { try { pruneJobs(); pruneRenders(); } catch (e) { log('prune error', e.message); } }, 6 * 3600_000).unref();
  schedulerTick();
  pump();
  log(`started (concurrency ${config.workerConcurrency}, poll every ${config.pollIntervalMinutes}m)`);
}

export function stopWorker() { clearInterval(timer); clearInterval(tickTimer); }

/** Test helper: run jobs until the queue is idle (ignores jobs scheduled in the future beyond `horizonMs`). */
export async function drain({ horizonMs = 0, maxJobs = 500 } = {}) {
  for (let i = 0; i < maxJobs; i++) {
    if (horizonMs) run(`UPDATE jobs SET run_at = ? WHERE status = 'pending' AND run_at <= ?`, now(), now() + horizonMs);
    const job = claimJob();
    if (!job) return i;
    await runJob(job);
  }
  return maxJobs;
}

export const queueStats = () => get(`SELECT
  SUM(status='pending') pending, SUM(status='running') running, SUM(status='failed') failed FROM jobs`);
