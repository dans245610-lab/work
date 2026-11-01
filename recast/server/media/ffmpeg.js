import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { parseCaptions, retime, serializeSrt } from './captions.js';

const FONT_CANDIDATES = [
  process.env.FONT_FILE,
  '/usr/share/fonts/opentype/inter/Inter-Bold.otf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/Library/Fonts/Arial Bold.ttf',
  'C:/Windows/Fonts/arialbd.ttf',
].filter(Boolean);
export const FONT_FILE = FONT_CANDIDATES.find((f) => fs.existsSync(f)) || '';

export const ASPECTS = {
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
  '16:9': [1920, 1080],
};

export const PRESET = process.env.RENDER_PRESET || 'veryfast';

/** Run a binary, resolve with stdout; reject with the stderr tail. */
export function run(bin, args, { timeoutMs = 60 * 60 * 1000, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${path.basename(bin)} timed out`)); }, timeoutMs);
    p.stdout.on('data', (d) => { const s = d.toString(); out += s; if (out.length > 4e6) out = out.slice(-2e6); onStdout?.(s); });
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-10000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error(`${bin} is not installed`) : e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${err.trim().split('\n').slice(-6).join(' | ')}`));
    });
  });
}

export async function binaryVersion(bin, args = ['-version']) {
  try { return (await run(bin, args, { timeoutMs: 10000 })).split('\n')[0].trim(); } catch { return null; }
}

export async function probe(file) {
  const out = await run(config.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60000 });
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = j.streams.find((s) => s.codec_type === 'audio');
  let width = v?.width || 0, height = v?.height || 0;
  const rot = Number(v?.tags?.rotate || v?.side_data_list?.find((s) => s.rotation != null)?.rotation || 0);
  if (Math.abs(rot) % 180 === 90) [width, height] = [height, width];
  return {
    kind: v ? 'video' : a ? 'audio' : 'unknown',
    duration: Number(j.format?.duration || v?.duration || a?.duration || 0),
    width, height,
    hasAudio: !!a,
    size: Number(j.format?.size || 0),
    format: j.format?.format_name || '',
  };
}

export async function makeThumbnail(file, out, { at = 1, kind = 'video' } = {}) {
  if (kind !== 'video') return null;
  await run(config.ffmpeg, ['-y', '-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out], { timeoutMs: 60000 })
    .catch(() => run(config.ffmpeg, ['-y', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out], { timeoutMs: 60000 }));
  return out;
}

// ---------- filter helpers ----------
const escFilterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
const hex = (c, d = 'ffffff') => (String(c || '').match(/^#?([0-9a-f]{6})$/i)?.[1] || d).toLowerCase();
const assColor = (c, alpha = 0) => { const h = hex(c); return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase(); };
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export function outputDims(transform, media) {
  if (ASPECTS[transform.aspect]) return ASPECTS[transform.aspect];
  if (media.kind === 'audio' || !media.width || !media.height) return ASPECTS['1:1'];
  const scale = Math.min(1, 1920 / Math.max(media.width, media.height));
  return [even(media.width * scale), even(media.height * scale)];
}

function positionXY(pos, margin) {
  const m = margin;
  switch (pos) {
    case 'top-left': return [`${m}`, `${m}`];
    case 'bottom-left': return [`${m}`, `H-h-${m}`];
    case 'bottom-right': return [`W-w-${m}`, `H-h-${m}`];
    case 'center': return ['(W-w)/2', '(H-h)/2'];
    default: return [`W-w-${m}`, `${m}`];
  }
}

function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(',');
}

/** Effective [start, outputDuration] in seconds for a media item + transform. */
export function timing(transform, media) {
  const speed = clamp(Number(transform.speed) || 1, 0.25, 4);
  const srcDur = Number(media.duration) || 0;
  const start = Math.max(0, Number(transform.trimStart) || 0);
  let end = Number(transform.trimEnd) > 0 ? Math.min(Number(transform.trimEnd), srcDur || Infinity) : srcDur;
  end -= Math.max(0, Number(transform.cutEnd) || 0);
  let outDur = Math.max(0.5, (end - start) / speed);
  if (Number(transform.maxDuration) > 0) outDur = Math.min(outDur, Number(transform.maxDuration));
  return { start, outDur, speed };
}
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

/**
 * Build ffmpeg arguments for one render.
 * Returns { args, tmpFiles } — caller deletes tmpFiles.
 */
export function buildRenderArgs({ media, transform = {}, brand = null, outPath, dims, tmpDir, preview = false }) {
  const [W, H] = dims || outputDims(transform, media);
  const { start, outDur, speed } = timing(transform, media);
  const duration = preview ? Math.min(outDur, 6) : outDur;
  const tmpFiles = [];
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats'];
  const inputs = [];
  const addInput = (opts) => { inputs.push(opts); return inputs.length - 1; };

  const mainIdx = addInput([...(start > 0 ? ['-ss', String(start)] : []), '-i', media.file_path]);
  const isAudio = media.kind === 'audio';
  const cover = isAudio && media.cover_path && fs.existsSync(media.cover_path) ? media.cover_path : null;
  const coverIdx = cover ? addInput(['-loop', '1', '-framerate', '30', '-i', cover]) : -1;
  const logoIdx = brand?.logo_path && fs.existsSync(brand.logo_path) ? addInput(['-i', brand.logo_path]) : -1;
  const needSilence = !media.has_audio || transform.mute;
  const silenceIdx = needSilence ? addInput(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']) : -1;

  const f = [];
  let v;
  if (isAudio) {
    const accent = hex(brand?.accent_color, '7c5cff');
    if (coverIdx >= 0) {
      f.push(`[${coverIdx}:v]split=2[cva][cvb]`);
      f.push(`[cva]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:3,eq=brightness=-0.18[bg0]`);
      const s = even(Math.min(W, H) * 0.55);
      f.push(`[cvb]scale=${s}:${s}:force_original_aspect_ratio=increase,crop=${s}:${s}[cov]`);
      f.push(`[bg0][cov]overlay=(W-w)/2:(H-h)/2-${Math.round(H * 0.08)}[bg]`);
    } else {
      f.push(`color=c=0x${accent}:s=${W}x${H}:r=30,format=yuv420p[bg]`);
    }
    f.push(`[${mainIdx}:a]asplit=2[aw][amain]`);
    const wh = even(H * 0.16);
    f.push(`[aw]showwaves=s=${W}x${wh}:mode=cline:rate=30:colors=white,format=rgba,colorchannelmixer=aa=0.9[waves]`);
    f.push(`[bg][waves]overlay=0:${Math.round(H * 0.74)}:shortest=1[v0]`);
    v = 'v0';
    if (FONT_FILE && media.title) {
      const tf = path.join(tmpDir, `title-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      fs.writeFileSync(tf, wrapText(media.title, 28).slice(0, 4).join('\n'));
      tmpFiles.push(tf);
      f.push(`[${v}]drawtext=fontfile='${escFilterPath(FONT_FILE)}':textfile='${escFilterPath(tf)}':fontcolor=white:fontsize=${Math.round(H * 0.045)}:line_spacing=12:x=(w-text_w)/2:y=${Math.round(H * 0.08)}:shadowcolor=black@0.5:shadowx=2:shadowy=2[v1]`);
      v = 'v1';
    }
  } else {
    const pre = [];
    if (speed !== 1) pre.push(`setpts=PTS/${speed}`);
    if (transform.flip) pre.push('hflip');
    const fit = transform.fit || 'blur';
    const src = `[${mainIdx}:v]${pre.length ? pre.join(',') + ',' : ''}`;
    if (fit === 'crop') {
      f.push(`${src}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[v0]`);
    } else if (fit === 'pad') {
      f.push(`${src}scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x${hex(transform.padColor, '000000')}[v0]`);
    } else {
      f.push(`${src}split=2[sa][sb]`);
      f.push(`[sa]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:2,eq=brightness=-0.08[bg]`);
      f.push(`[sb]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg]`);
      f.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2[v0]`);
    }
    v = 'v0';
  }

  // Headline ("hook") text on top for the first N seconds.
  if (transform.headline && FONT_FILE) {
    const tf = path.join(tmpDir, `hl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(tf, wrapText(transform.headline, W > H ? 40 : 22).slice(0, 3).join('\n'));
    tmpFiles.push(tf);
    const secs = Number(transform.headlineSeconds) > 0 ? Number(transform.headlineSeconds) : 4;
    f.push(`[${v}]drawtext=fontfile='${escFilterPath(FONT_FILE)}':textfile='${escFilterPath(tf)}':fontcolor=white:fontsize=${Math.round(Math.min(W, H) * 0.06)}:line_spacing=10:box=1:boxcolor=0x${hex(brand?.accent_color, '000000')}@0.85:boxborderw=24:x=(w-text_w)/2:y=${Math.round(H * 0.12)}:enable='lt(t,${secs})'[vh]`);
    v = 'vh';
  }

  // Burned-in captions
  if (transform.burnCaptions && media.captions_path && fs.existsSync(media.captions_path)) {
    const cues = retime(parseCaptions(fs.readFileSync(media.captions_path, 'utf8')), { offsetMs: start * 1000, speed, durationMs: duration * 1000 });
    if (cues.length) {
      const srt = path.join(tmpDir, `cap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.srt`);
      fs.writeFileSync(srt, serializeSrt(cues));
      tmpFiles.push(srt);
      const cs = { size: 'm', color: '#ffffff', outline: '#000000', position: 'bottom', ...(brand?.caption_style || {}) };
      const fontSize = { s: 12, m: 15, l: 19, xl: 24 }[cs.size] || 15;
      const align = { top: 8, middle: 5, bottom: 2 }[cs.position] || 2;
      const marginV = cs.position === 'bottom' ? (H > W ? 60 : 25) : 20;
      const fontName = FONT_FILE.includes('Inter') ? 'Inter' : FONT_FILE.includes('DejaVu') ? 'DejaVu Sans' : 'Arial';
      const style = [`FontName=${fontName}`, `FontSize=${fontSize}`, 'Bold=1', `PrimaryColour=${assColor(cs.color)}`, `OutlineColour=${assColor(cs.outline)}`,
        cs.box ? `BorderStyle=3,BackColour=${assColor(cs.outline, 0x40)}` : 'BorderStyle=1', 'Outline=2', 'Shadow=0', `Alignment=${align}`, `MarginV=${marginV}`].join(',');
      const fontsDir = FONT_FILE ? `:fontsdir='${escFilterPath(path.dirname(FONT_FILE))}'` : '';
      f.push(`[${v}]subtitles=filename='${escFilterPath(srt)}'${fontsDir}:original_size=${W}x${H}:force_style='${style}'[vc]`);
      v = 'vc';
    }
  }

  // Logo
  if (logoIdx >= 0) {
    const lw = even(W * clamp(Number(brand.logo_scale) || 0.18, 0.03, 0.8));
    const [x, y] = positionXY(brand.logo_position, Math.round(Math.min(W, H) * 0.04));
    f.push(`[${logoIdx}:v]scale=${lw}:-1,format=rgba,colorchannelmixer=aa=${clamp(Number(brand.logo_opacity) || 0.9, 0.05, 1)}[logo]`);
    f.push(`[${v}][logo]overlay=${x}:${y}[vl]`);
    v = 'vl';
  }

  // Text watermark
  if (brand?.watermark_text && FONT_FILE) {
    const tf = path.join(tmpDir, `wm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(tf, brand.watermark_text.slice(0, 80));
    tmpFiles.push(tf);
    const m = Math.round(Math.min(W, H) * 0.04);
    const pos = brand.logo_position === 'bottom-left' ? `x=w-text_w-${m}:y=h-text_h-${m}` : `x=${m}:y=h-text_h-${m}`;
    f.push(`[${v}]drawtext=fontfile='${escFilterPath(FONT_FILE)}':textfile='${escFilterPath(tf)}':fontcolor=white@0.85:fontsize=${Math.round(Math.min(W, H) * 0.03)}:shadowcolor=black@0.6:shadowx=2:shadowy=2:${pos}[vw]`);
    v = 'vw';
  }

  f.push(`[${v}]fps=30,setsar=1,format=yuv420p[vout]`);

  // Audio
  let aLabel;
  if (needSilence) {
    aLabel = `${silenceIdx}:a`;
  } else {
    const chain = [];
    const src = isAudio ? '[amain]' : `[${mainIdx}:a]`;
    if (speed !== 1 && !isAudio) chain.push(atempoChain(speed));
    if (Number(transform.volume) > 0 && Number(transform.volume) !== 1) chain.push(`volume=${Number(transform.volume)}`);
    if (transform.normalizeAudio !== false) chain.push('loudnorm=I=-14:TP=-1.5:LRA=11');
    chain.push('aresample=44100', 'aformat=sample_fmts=fltp:channel_layouts=stereo');
    f.push(`${src}${chain.join(',')}[aout]`);
    aLabel = '[aout]';
  }

  for (const i of inputs) args.push(...i);
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', aLabel.startsWith('[') ? aLabel : aLabel);
  args.push('-t', duration.toFixed(3));
  args.push('-c:v', 'libx264', '-preset', preview ? 'ultrafast' : PRESET, '-crf', transform.quality === 'high' ? '18' : '21', '-profile:v', 'high', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', '-shortest', outPath);
  return { args, tmpFiles, dims: [W, H], duration };
}

function wrapText(text, max) {
  const lines = [];
  let cur = '';
  for (const w of String(text).replace(/\s+/g, ' ').trim().split(' ')) {
    if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Render media with transform + brand, including optional intro/outro (concatenated).
 * onProgress(0..1)
 */
export async function render({ media, transform, brand, outPath, intro, outro, preview = false, onProgress }) {
  const tmpDir = config.tmpDir;
  const cleanup = [];
  try {
    const main = buildRenderArgs({ media, transform, brand, outPath: (intro || outro) && !preview ? outPath + '.main.mp4' : outPath, tmpDir, preview });
    cleanup.push(...main.tmpFiles);
    const total = main.duration;
    await run(config.ffmpeg, main.args, {
      onStdout: (s) => {
        const m = s.match(/out_time_(?:ms|us)=(\d+)/g);
        if (m && onProgress) onProgress(Math.min(0.99, Number(m[m.length - 1].split('=')[1]) / 1e6 / total));
      },
    });
    if (preview || (!intro && !outro)) return { dims: main.dims, duration: main.duration };

    const parts = [];
    const dims = main.dims;
    for (const [name, m] of [['intro', intro], ['main', null], ['outro', outro]]) {
      if (name === 'main') { parts.push(outPath + '.main.mp4'); cleanup.push(outPath + '.main.mp4'); continue; }
      if (!m) continue;
      const p = `${outPath}.${name}.mp4`;
      const r = buildRenderArgs({ media: m, transform: { fit: 'blur', normalizeAudio: true }, brand: null, outPath: p, dims, tmpDir });
      cleanup.push(p, ...r.tmpFiles);
      await run(config.ffmpeg, r.args);
      parts.push(p);
    }
    const list = `${outPath}.concat.txt`;
    fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    cleanup.push(list);
    await run(config.ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', outPath]);
    const p = await probe(outPath);
    return { dims, duration: p.duration };
  } finally {
    for (const f of cleanup) fs.rm(f, { force: true }, () => {});
  }
}

/** Generate a sample clip (used by demo sources and tests). */
export async function generateSample(outPath, { seconds = 6, width = 1280, height = 720, label = 'Sample clip', hue = 0 } = {}) {
  const draw = FONT_FILE
    ? `,drawtext=fontfile='${escFilterPath(FONT_FILE)}':text='${label.replace(/[':\\]/g, ' ')}':fontcolor=white:fontsize=${Math.round(height * 0.08)}:box=1:boxcolor=black@0.55:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2`
    : '';
  await run(config.ffmpeg, ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=30:d=${seconds},hue=h=${hue}${draw}`,
    '-f', 'lavfi', '-i', `sine=frequency=${330 + (hue % 5) * 55}:sample_rate=44100:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outPath]);
  return outPath;
}
