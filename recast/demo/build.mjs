// Builds the static, self-contained demo of Recast (no server needed).
//   node --disable-warning=ExperimentalWarning demo/build.mjs
// Output: demo/dist/index.html + demo/dist/media/*  (sample clips rendered by Recast's real ffmpeg pipeline)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(HERE, 'dist');
const MEDIA = path.join(DIST, 'media');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-demo-'));
process.env.RENDER_PRESET = 'veryfast';

const { describeConnectors } = await import('../server/connectors/index.js');
const { render, run, probe, FONT_FILE } = await import('../server/media/ffmpeg.js');
const { SAMPLES } = await import('./samples.js');

fs.mkdirSync(MEDIA, { recursive: true });
const ff = (...args) => run('ffmpeg', ['-y', '-v', 'error', ...args]);
const esc = (s) => s.replace(/[':\\%,]/g, ' ');
const tmp = process.env.DATA_DIR;
const SKIP_MEDIA = process.argv.includes('--skip-media');

// Logo for the demo brand kit
const logo = path.join(tmp, 'logo.png');
await ff('-f', 'lavfi', '-i', `color=c=0xf5c84c:s=360x110,format=rgba,drawtext=fontfile='${FONT_FILE}':text='FIELD NOTES':fontsize=44:fontcolor=0x1d1a12:x=(w-tw)/2:y=(h-th)/2`, '-frames:v', '1', logo);
fs.copyFileSync(logo, path.join(MEDIA, 'logo.png'));
const brand = { logo_path: logo, logo_position: 'top-right', logo_scale: 0.26, logo_opacity: 0.95, watermark_text: '@fieldnoteskitchen', accent_color: '#d9542b', caption_style: { size: 'l', color: '#ffffff', outline: '#000000', position: 'bottom' } };

const small = async (src, out, w) => ff('-i', src, '-vf', `scale=${w}:-2`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out);

if (!SKIP_MEDIA) {
  for (const s of SAMPLES) {
    const srcFull = path.join(tmp, `${s.key}-src.mp4`);
    if (s.kind === 'audio') {
      await ff('-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-filter_complex', '[0][1]amix=inputs=2,volume=2,tremolo=f=3:d=0.7', '-c:a', 'libmp3lame', path.join(MEDIA, `${s.key}-src.mp3`));
      const p = await probe(path.join(MEDIA, `${s.key}-src.mp3`));
      for (const aspect of s.renders) {
        const out = path.join(tmp, `${s.key}-${aspect.replace(':', 'x')}.mp4`);
        await render({ media: { ...p, kind: 'audio', file_path: path.join(MEDIA, `${s.key}-src.mp3`), has_audio: 1, title: s.title.replace(/#\S+/g, '').trim() }, transform: { aspect }, brand, outPath: out });
        await small(out, path.join(MEDIA, `${s.key}-${aspect.replace(':', 'x')}.mp4`), aspect === '16:9' ? 640 : 360);
      }
      continue;
    }
    const [w, h] = s.portrait ? [720, 1280] : [1280, 720];
    await ff('-f', 'lavfi', '-i', `gradients=s=${w}x${h}:c0=${s.colors[0]}:c1=${s.colors[1]}:c2=${s.colors[2]}:n=3:speed=0.03:d=5:r=30,drawtext=fontfile='${FONT_FILE}':text='${esc(s.label)}':fontcolor=white:fontsize=${Math.round(w * 0.075)}:x=(w-tw)/2:y=h*0.42:shadowcolor=black@0.5:shadowx=3:shadowy=3`,
      '-f', 'lavfi', '-i', `sine=frequency=${s.tone}:duration=5`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', srcFull);
    await small(srcFull, path.join(MEDIA, `${s.key}-src.mp4`), s.portrait ? 360 : 640);
    await ff('-ss', '1.5', '-i', srcFull, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', path.join(MEDIA, `${s.key}-thumb.jpg`));
    const p = await probe(srcFull);
    const caps = path.join(tmp, `${s.key}.srt`);
    fs.writeFileSync(caps, `1\n00:00:00,300 --> 00:00:02,200\n${s.caption[0]}\n\n2\n00:00:02,300 --> 00:00:04,600\n${s.caption[1]}\n`);
    for (const aspect of s.renders) {
      const out = path.join(tmp, `${s.key}-${aspect.replace(':', 'x')}.mp4`);
      await render({ media: { ...p, file_path: srcFull, has_audio: 1, captions_path: caps }, transform: { aspect, fit: 'blur', burnCaptions: true, headline: aspect === '9:16' ? s.hook : '' }, brand, outPath: out });
      await small(out, path.join(MEDIA, `${s.key}-${aspect.replace(':', 'x')}.mp4`), aspect === '16:9' ? 640 : 360);
    }
    console.log('rendered', s.key);
  }
}

// Connector metadata exactly as the real server describes it
fs.writeFileSync(path.join(HERE, 'connectors.json'), JSON.stringify(describeConnectors().map((c) => ({ ...c, oauthConfigured: false, redirectUri: c.redirectUri && c.redirectUri.replace(/^https?:\/\/[^/]+/, 'https://your-recast-server.example') })), null, 2));

// Bundle the real SPA + the in-browser mock backend into one script
// The SPA imports the server's template helpers from /shared/templates.js; point that at the real file.
const webCopy = path.join(tmp, 'webjs');
fs.cpSync(path.join(ROOT, 'web/js'), webCopy, { recursive: true });
for (const f of fs.readdirSync(path.join(webCopy, 'pages'))) {
  const fp = path.join(webCopy, 'pages', f);
  fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').replaceAll("'/shared/templates.js'", JSON.stringify(path.join(ROOT, 'server/lib/templates.js'))));
}
const entry = path.join(tmp, 'entry.js');
fs.writeFileSync(entry, `import ${JSON.stringify(path.join(HERE, 'mock.js'))};\nimport ${JSON.stringify(path.join(webCopy, 'app.js'))};\n`);
const bundle = path.join(tmp, 'bundle.js');
execFileSync('npx', ['-y', 'esbuild@0.23.1', entry, '--bundle', '--format=iife', '--minify', '--target=es2020', `--outfile=${bundle}`], { stdio: 'inherit' });

// CSS: make dark mode follow the artifact theme contract (system + explicit data-theme)
let css = fs.readFileSync(path.join(ROOT, 'web/css/app.css'), 'utf8');
const darkRe = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\}\s*\}/;
const dark = css.match(darkRe)[1];
css = css.replace(darkRe, `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${dark}} }\n:root[data-theme="dark"] {${dark}}`);
css += fs.readFileSync(path.join(HERE, 'demo.css'), 'utf8');

const favicon = 'data:image/svg+xml,' + encodeURIComponent(fs.readFileSync(path.join(ROOT, 'web/favicon.svg'), 'utf8'));
const js = fs.readFileSync(bundle, 'utf8').replaceAll('"/favicon.svg"', JSON.stringify(favicon)).replace(/<\/script/gi, '<\\/script');

fs.writeFileSync(path.join(DIST, 'index.html'), `<title>Recast Demo</title>
<style>${css}</style>
<div id="app"><div class="boot">Loading…</div></div>
<div id="toasts" aria-live="polite"></div>
<script>${js}</script>
`);
console.log('built', path.join(DIST, 'index.html'), `${Math.round(fs.statSync(path.join(DIST, 'index.html')).size / 1024)} KB`);

// Standalone website copy (full HTML document) for static hosts such as Cloudflare Pages.
const SITE = path.join(HERE, 'site');
fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(SITE, { recursive: true });
fs.cpSync(MEDIA, path.join(SITE, 'media'), { recursive: true });
fs.writeFileSync(path.join(SITE, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Clickable demo of Recast, a self-hosted content repurposing app.">
${fs.readFileSync(path.join(DIST, 'index.html'), 'utf8').replace('<div id="app">', '</head>\n<body>\n<div id="app">')}
</body>
</html>
`);
fs.writeFileSync(path.join(SITE, '_headers'), '/media/*\n  Cache-Control: public, max-age=86400\n');
console.log('built', SITE);
