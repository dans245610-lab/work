// Renders every scene in graphics/scenes.html to a transparent 1080x1920 30fps clip.
//   node render.mjs                 -> all scenes, QuickTime Animation (.mov, alpha)
//   node render.mjs --stills        -> one PNG per scene at its busiest moment (for review)
//   node render.mjs 07_roe_bars     -> just that scene
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const here = path.dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const args = process.argv.slice(2);
const stills = args.includes('--stills');
const green = args.includes('--green');   // solid green background + no drop shadow, for CapCut chroma key
const only = args.filter(a => !a.startsWith('--'));
const outDir = path.join(here, stills ? 'stills' : green ? 'clips_green' : 'clips');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
await page.goto('file://' + path.join(here, 'graphics/scenes.html'));
await page.evaluate(() => document.fonts.ready);
if (green) await page.addStyleTag({ content: 'html,body{background:#00ff00 !important}.card,.cal{box-shadow:none !important}.card{background:linear-gradient(160deg,#16243a,#0d1726) !important}' });
const scenes = (await page.evaluate(() => window.SCENES)).filter(s => !only.length || only.includes(s.id));

for (const s of scenes) {
  const D = s.end - s.start;
  await page.evaluate(id => window.loadScene(id), s.id);
  if (stills) {
    await page.evaluate(t => window.seek(t), D - 0.4);
    await page.screenshot({ path: path.join(outDir, `${s.id}.png`), omitBackground: true });
    console.log('still', s.id);
    continue;
  }
  const n = Math.round(D * FPS);
  const enc = green
    ? ['-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(outDir, `${s.id}.mp4`)]
    : ['-c:v', 'qtrle', '-pix_fmt', 'argb', path.join(outDir, `${s.id}.mov`)];
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', ...enc],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let f = 0; f < n; f++) {
    await page.evaluate(t => window.seek(t), f / FPS);
    const buf = await page.screenshot({ omitBackground: !green });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await new Promise((r, j) => ff.on('close', c => c ? j(new Error('ffmpeg ' + c)) : r()));
  console.log(`clip ${s.id}  ${n} frames  @ ${s.start}s`);
}
await browser.close();
