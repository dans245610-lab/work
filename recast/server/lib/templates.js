// Caption/title templating: {{title}}, {{description}}, {{hashtags}}, {{source_url}}, {{date}}, {{platform}}, {{account}}
export const TEMPLATE_VARS = ['title', 'description', 'hashtags', 'source_url', 'date', 'platform', 'account', 'first_line'];

export function extractHashtags(text = '') {
  const seen = new Set();
  const out = [];
  for (const m of String(text).matchAll(/(^|\s)#([\p{L}\p{N}_]+)/gu)) {
    const tag = m[2];
    if (/^\d+$/.test(tag)) continue; // "#1" is not a hashtag
    if (!seen.has(tag.toLowerCase())) { seen.add(tag.toLowerCase()); out.push('#' + tag); }
  }
  return out;
}

export function stripHashtags(text = '') {
  return String(text).replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

export function stripMentions(text = '') {
  return String(text).replace(/(^|\s)@[\w.]+/g, '$1').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

export function normalizeTagList(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  return list.map((t) => t.trim()).filter(Boolean).map((t) => (t.startsWith('#') ? t : '#' + t));
}

/** Truncate on a word boundary to fit a platform's character limit. */
export function truncate(text, max) {
  text = String(text ?? '');
  if (!max || [...text].length <= max) return text;
  const chars = [...text].slice(0, max - 1).join('');
  const cut = chars.lastIndexOf(' ');
  return (cut > max * 0.6 ? chars.slice(0, cut) : chars).replace(/[\s#@.,;:!\-]+$/, '') + '…';
}

/**
 * Build the title + caption for a post.
 * opts: { stripSourceHashtags, stripMentions, addHashtags, removeHashtags, titleMax, captionMax }
 */
export function renderTemplate(tpl, media, ctx = {}, opts = {}) {
  const rawDesc = media.description || '';
  let tags = extractHashtags(`${media.title || ''} ${rawDesc}`);
  const remove = new Set(normalizeTagList(opts.removeHashtags).map((t) => t.toLowerCase()));
  tags = tags.filter((t) => !remove.has(t.toLowerCase()));
  for (const t of normalizeTagList(opts.addHashtags)) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);

  let description = rawDesc;
  let title = media.title || '';
  if (opts.stripSourceHashtags) { description = stripHashtags(description); title = stripHashtags(title); }
  if (opts.stripMentions) { description = stripMentions(description); title = stripMentions(title); }

  const vars = {
    title,
    description,
    // When the template also prints the description, don't repeat tags it already contains.
    hashtags: (/\{\{\s*description\s*\}\}/.test(tpl) ? tags.filter((t) => !new RegExp(`(^|\\s)${t}(?![\\p{L}\\p{N}_])`, 'iu').test(description)) : tags).join(' '),
    source_url: media.source_url || '',
    date: new Date(media.source_published_at || media.created_at || Date.now()).toISOString().slice(0, 10),
    platform: ctx.platform || '',
    account: ctx.account || '',
    first_line: (description || title).split('\n')[0],
  };
  const out = String(tpl ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function buildPostText(media, dest, ctx, limits = {}) {
  const opts = dest.options || {};
  const title = truncate(renderTemplate(dest.title_template ?? '{{title}}', media, ctx, opts) || media.title || 'Untitled', limits.titleMax);
  let caption = renderTemplate(dest.caption_template ?? '{{description}}', media, ctx, opts);
  // If the template does not mention {{hashtags}} but user asked to add tags, append them.
  const added = normalizeTagList(opts.addHashtags);
  if (added.length && !/\{\{\s*hashtags\s*\}\}/.test(dest.caption_template || '')) {
    const missing = added.filter((t) => !caption.toLowerCase().includes(t.toLowerCase()));
    if (missing.length) caption = `${caption}\n\n${missing.join(' ')}`.trim();
  }
  return { title, caption: truncate(caption, limits.captionMax) };
}
