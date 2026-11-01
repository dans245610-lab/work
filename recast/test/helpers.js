import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated data dir per test process; must be set before importing server modules.
export const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.NODE_ENV = 'test';
process.env.RENDER_PRESET = 'ultrafast';
process.env.PUBLIC_BASE_URL = 'http://localhost:0';

export async function startServer() {
  const { createApp } = await import('../server/app.js');
  const server = createApp();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function api(method, p, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
    const res = await fetch(base + p, {
      method, headers: { 'X-Requested-With': 'recast', ...(cookie ? { Cookie: cookie } : {}), ...(body && !isBuf ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body == null ? undefined : isBuf ? body : JSON.stringify(body), redirect: 'manual',
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  }
  return { server, base, api, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}
