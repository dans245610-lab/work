// Tiny RSS/Atom parser (enough for podcast feeds and YouTube channel feeds).
const decode = (s = '') => s
  .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1].trim()) : '';
};
const attr = (xml, name, a) => {
  const m = xml.match(new RegExp(`<${name}\\s[^>]*${a}="([^"]*)"`, 'i'));
  return m ? decode(m[1]) : '';
};
const stripHtml = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();

export function parseFeed(xml) {
  const feedTitle = tag(xml.replace(/<(item|entry)[\s>][\s\S]*$/i, ''), 'title');
  const items = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const x = m[0];
    const enclosure = attr(x, 'enclosure', 'url');
    items.push({
      ref: tag(x, 'guid') || enclosure || tag(x, 'link'),
      title: tag(x, 'title'),
      description: stripHtml(tag(x, 'itunes:summary') || tag(x, 'description') || tag(x, 'content:encoded')),
      url: tag(x, 'link'),
      mediaUrl: enclosure,
      mediaType: attr(x, 'enclosure', 'type'),
      publishedAt: Date.parse(tag(x, 'pubDate')) || null,
      image: attr(x, 'itunes:image', 'href'),
    });
  }
  for (const m of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) {
    const x = m[0];
    const videoId = tag(x, 'yt:videoId');
    items.push({
      ref: videoId || tag(x, 'id'),
      title: tag(x, 'title'),
      description: stripHtml(tag(x, 'media:description') || tag(x, 'summary') || tag(x, 'content')),
      url: attr(x, 'link', 'href'),
      mediaUrl: attr(x, 'media:content', 'url'),
      mediaType: attr(x, 'media:content', 'type'),
      publishedAt: Date.parse(tag(x, 'published') || tag(x, 'updated')) || null,
      image: attr(x, 'media:thumbnail', 'url'),
      videoId,
    });
  }
  return { title: feedTitle, items };
}
