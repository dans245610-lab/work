// Workflow content filters.
const words = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Text-only filters, evaluated when an item is discovered. Returns null if OK, else a reason. */
export function checkTextFilters(filters = {}, media) {
  const text = `${media.title || ''}\n${media.description || ''}`.toLowerCase();
  const include = words(filters.includeKeywords);
  if (include.length && !include.some((k) => text.includes(k))) return `does not contain any of: ${include.join(', ')}`;
  const exclude = words(filters.excludeKeywords);
  const hit = exclude.find((k) => text.includes(k));
  if (hit) return `contains excluded keyword "${hit}"`;
  const req = words(filters.requiredHashtags).map((t) => (t.startsWith('#') ? t : '#' + t));
  const missing = req.filter((t) => !new RegExp(`(^|\\s)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|$)`, 'i').test(text));
  if (req.length && missing.length) return `missing required hashtag(s): ${missing.join(' ')}`;
  return null;
}

/** Media filters, evaluated once the file has been probed. */
export function checkMediaFilters(filters = {}, media) {
  const dur = Number(media.duration || 0);
  if (filters.minDuration && dur < Number(filters.minDuration)) return `shorter than ${filters.minDuration}s`;
  if (filters.maxDuration && dur > Number(filters.maxDuration)) return `longer than ${filters.maxDuration}s`;
  if (filters.orientation && filters.orientation !== 'any' && media.kind === 'video') {
    const o = media.width > media.height ? 'landscape' : media.width < media.height ? 'portrait' : 'square';
    if (o !== filters.orientation) return `orientation is ${o}, not ${filters.orientation}`;
  }
  return null;
}
