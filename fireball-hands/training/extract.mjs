import { chromium } from 'playwright';
import fs from 'fs';
const NM = 'node_modules/@mediapipe/tasks-vision/';
const meta = JSON.parse(fs.readFileSync('asl/meta.json'));
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--enable-unsafe-swiftshader'] });
const p = await b.newPage();
p.on('pageerror', e => console.log('pageerror:', e.message));
const types = { mjs: 'text/javascript', js: 'text/javascript', wasm: 'application/wasm', html: 'text/html', jpg: 'image/jpeg' };
await p.route('http://local.test/**', r => {
  const path = new URL(r.request().url()).pathname;
  let file;
  if (path === '/x.html') return r.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
  if (path.startsWith('/tv/')) file = NM + path.slice(4);
  else if (path === '/model.task') file = 'hand.task';
  else if (path.startsWith('/img/')) file = 'asl/all/' + path.slice(5);
  r.fulfill({ body: fs.readFileSync(file), contentType: types[file.split('.').pop()] || 'application/octet-stream' });
});
await p.goto('http://local.test/x.html');
await p.evaluate(async () => {
  const { FilesetResolver, HandLandmarker } = await import('/tv/vision_bundle.mjs');
  const fs = await FilesetResolver.forVisionTasks('/tv/wasm');
  window.lmk = await HandLandmarker.createFromOptions(fs, {
    baseOptions: { modelAssetPath: '/model.task', delegate: 'CPU' }, runningMode: 'IMAGE', numHands: 1, minHandDetectionConfidence: 0.3,
  });
  window.cv = document.createElement('canvas');
});
const out = [];
const t0 = Date.now();
for (let i = 0; i < meta.length; i += 200) {
  const chunk = meta.slice(i, i + 200);
  const res = await p.evaluate(async (chunk) => {
    const r = [];
    for (const [fn, label] of chunk) {
      const img = new Image(); img.src = '/img/' + fn; await img.decode();
      const s = 320 / Math.max(img.width, img.height);
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const d = lmk.detect(cv);
      if (!d.landmarks.length) { r.push({ fn, label, miss: 1 }); continue; }
      r.push({ fn, label, w: cv.width, h: cv.height,
        lm: d.landmarks[0].map(q => [q.x, q.y, q.z]),
        wl: d.worldLandmarks[0].map(q => [q.x, q.y, q.z]),
        hand: d.handedness[0][0].categoryName, score: d.handedness[0][0].score });
    }
    return r;
  }, chunk);
  out.push(...res);
  if (i % 2000 === 0) console.log(i, ((Date.now() - t0) / 1000).toFixed(0) + 's', 'hits', out.filter(o => !o.miss).length);
}
fs.writeFileSync('asl/landmarks.json', JSON.stringify(out));
console.log('done', out.length, 'hits', out.filter(o => !o.miss).length);
await b.close();
