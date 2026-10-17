// everyFrame(fn) → stop(): calls fn about 30 times a second, also in hidden pages (see ticker-worker.js).
// The next tick is requested only after fn returns, leaving at least a few ms for the page's other work.
export function everyFrame(fn, ms = 33) {
  let worker = null, raf = 0, stopped = false;
  try {
    worker = new Worker(new URL("./ticker-worker.js", import.meta.url));
    worker.onmessage = () => {
      if (stopped) return;
      const t0 = performance.now();
      try { fn(); } finally { if (!stopped) worker.postMessage(Math.max(4, ms - (performance.now() - t0))); }
    };
    worker.postMessage(0);
  } catch {   // no workers: fall back to animation frames (fine in visible pages)
    const loop = () => { if (stopped) return; fn(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
  }
  return () => { stopped = true; if (worker) worker.terminate(); cancelAnimationFrame(raf); };
}
