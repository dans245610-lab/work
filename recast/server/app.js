import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { Router, HttpError, sendJson, sendFile, notFound } from './lib/http.js';
import { sessionUser } from './auth.js';
import authRoutes from './routes/auth.js';
import connectionRoutes from './routes/connections.js';
import mediaRoutes from './routes/media.js';
import workflowRoutes from './routes/workflows.js';
import postRoutes from './routes/posts.js';
import brandRoutes from './routes/brand.js';
import dashboardRoutes from './routes/dashboard.js';

const WEB = path.join(ROOT, 'web');

export function createApp() {
  const router = new Router();
  for (const reg of [authRoutes, connectionRoutes, mediaRoutes, workflowRoutes, postRoutes, brandRoutes, dashboardRoutes]) reg(router);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      const isApi = url.pathname.startsWith('/api/');
      // CSRF: state-changing API calls must carry a custom header (cross-site forms cannot set it).
      if (isApi && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'recast') {
        throw new HttpError(403, 'Missing X-Requested-With header');
      }
      req.query = url.searchParams;
      req.user = sessionUser(req);
      const match = router.match(req.method, url.pathname);
      if (match) {
        req.params = match.params;
        for (const h of match.handlers) await h(req, res);
        return;
      }
      if (isApi || url.pathname.startsWith('/files/') || url.pathname.startsWith('/public/')) throw notFound();
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      // Pure helpers shared with the browser (caption templating preview).
      if (url.pathname === '/shared/templates.js') return sendFile(req, res, path.join(ROOT, 'server/lib/templates.js'), { cache: 'no-cache' });
      // Static frontend with SPA fallback
      const file = path.normalize(path.join(WEB, decodeURIComponent(url.pathname)));
      if (file.startsWith(WEB + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return sendFile(req, res, file, { cache: 'no-cache' });
      }
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
      return sendFile(req, res, path.join(WEB, 'index.html'), { cache: 'no-cache' });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e.retryable === false ? 400 : 500;
      if (status >= 500) console.error(`[http] ${req.method} ${url.pathname}`, e);
      if (res.headersSent) return res.destroy();
      sendJson(res, status, { error: status >= 500 && !(e instanceof HttpError) ? `Server error: ${e.message}` : e.message, details: e.details });
    }
  });
}
