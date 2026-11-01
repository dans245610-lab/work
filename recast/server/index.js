import { config } from './config.js';
import { createApp } from './app.js';
import { startWorker } from './worker.js';
import { binaryVersion } from './media/ffmpeg.js';

const ff = await binaryVersion(config.ffmpeg);
if (!ff) console.warn(`[recast] WARNING: ffmpeg not found at "${config.ffmpeg}". Rendering will fail until it is installed.`);

const server = createApp();
server.requestTimeout = 0; // large uploads
server.listen(config.port, () => {
  console.log(`[recast] listening on http://localhost:${config.port}  (public URL ${config.publicBaseUrl})`);
  console.log(`[recast] data dir ${config.dataDir}`);
});
if (process.env.RECAST_NO_WORKER !== '1') startWorker();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log('[recast] shutting down'); server.close(); process.exit(0); });
