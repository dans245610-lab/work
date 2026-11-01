// SRT / WebVTT parsing and re-timing.
const toMs = (t) => {
  const m = String(t).trim().replace(',', '.').match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!m) return NaN;
  return ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number((m[4] || '0').padEnd(3, '0'));
};
const fmt = (ms) => {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
};

export function parseCaptions(text) {
  const cues = [];
  const blocks = String(text).replace(/\r/g, '').replace(/^\uFEFF/, '').replace(/^WEBVTT[^\n]*\n/, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = toMs(a), end = toMs(b.trim().split(/\s+/)[0]);
    const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (!Number.isNaN(start) && !Number.isNaN(end) && body) cues.push({ start, end, text: body });
  }
  return cues;
}

export function serializeSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`).join('\n');
}

/** Re-time cues for a clip that starts at `offsetMs` in the original and plays at `speed`x. */
export function retime(cues, { offsetMs = 0, speed = 1, durationMs = Infinity } = {}) {
  return cues
    .map((c) => ({ ...c, start: (c.start - offsetMs) / speed, end: (c.end - offsetMs) / speed }))
    .filter((c) => c.end > 0 && c.start < durationMs)
    .map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(durationMs, c.end) }));
}

export function captionsToPlainText(cues) {
  return cues.map((c) => c.text.replace(/\n/g, ' ')).join(' ');
}
