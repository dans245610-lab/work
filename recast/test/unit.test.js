import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, buildPostText, extractHashtags, truncate, stripHashtags } from '../server/lib/templates.js';
import { nextSlot, computeScheduledAt, zonedParts } from '../server/lib/schedule.js';
import { checkTextFilters, checkMediaFilters } from '../server/lib/filters.js';
import { parseFeed } from '../server/lib/feed.js';
import { parseCaptions, retime, serializeSrt } from '../server/media/captions.js';
import { tiktokChunkPlan } from '../server/connectors/tiktok.js';
import { escapeLittleText, linkedinVersion } from '../server/connectors/linkedin.js';
import { timing, outputDims } from '../server/media/ffmpeg.js';
import { encrypt, decrypt, hashPassword, verifyPassword } from '../server/lib/security.js';

const media = { title: 'My #Cool video', description: 'Watch this @friend\nsecond line #fun #Cool', source_url: 'https://x.test/v/1', created_at: Date.UTC(2026, 0, 2) };

test('templates', () => {
  assert.deepEqual(extractHashtags(media.title + ' ' + media.description), ['#Cool', '#fun']);
  assert.equal(renderTemplate('{{title}} | {{hashtags}} | {{date}} | {{unknown}}', media), 'My #Cool video | #Cool #fun | 2026-01-02 | {{unknown}}');
  assert.equal(renderTemplate('{{description}}', media, {}, { stripSourceHashtags: true, stripMentions: true }), 'Watch this\nsecond line');
  assert.equal(renderTemplate('{{hashtags}}', media, {}, { addHashtags: 'shorts, #Fun', removeHashtags: ['cool'] }), '#fun #shorts');
  assert.equal(renderTemplate('{{first_line}}', media), 'Watch this @friend');
  assert.equal(renderTemplate('{{description}} | {{hashtags}}', media, {}, { addHashtags: 'new' }), 'Watch this @friend\nsecond line #fun #Cool | #new');
  assert.deepEqual(extractHashtags('clip #1 #ok'), ['#ok']);
  assert.equal(truncate('hello wonderful world', 12), 'hello wonde…');
  assert.equal(truncate('hello wonderful world', 19), 'hello wonderful…');
  assert.equal(stripHashtags('a #b c'), 'a c');
  const { title, caption } = buildPostText(media, { title_template: '{{title}}', caption_template: '{{description}}', options: { addHashtags: 'extra' } }, {}, { titleMax: 5, captionMax: 1000 });
  assert.equal(title, 'My…');
  assert.match(caption, /#extra$/);
});

test('schedule slots respect timezone and taken slots', () => {
  // 2026-03-02 is a Monday. 10:00 New York = 15:00 UTC (EST).
  const from = Date.UTC(2026, 2, 2, 15, 0);
  const s = { mode: 'slots', days: [1, 3], times: ['09:00', '17:00'] };
  const a = nextSlot(s, from, 'America/New_York');
  assert.equal(new Date(a).toISOString(), '2026-03-02T22:00:00.000Z');
  const b = nextSlot(s, from, 'America/New_York', new Set([a]));
  assert.equal(new Date(b).toISOString(), '2026-03-04T14:00:00.000Z');
  // DST: 2026-03-09 (Mon) New York is EDT (UTC-4)
  const c = nextSlot({ days: [1], times: ['09:00'] }, Date.UTC(2026, 2, 8), 'America/New_York');
  assert.equal(new Date(c).toISOString(), '2026-03-09T13:00:00.000Z');
  assert.equal(computeScheduledAt({ mode: 'delay', minutes: 10 }, { now: 1000 }), 1000 + 600000);
  assert.equal(computeScheduledAt({ mode: 'immediate' }, { now: 5 }), 5);
  assert.equal(zonedParts(Date.UTC(2026, 0, 1, 3), 'Asia/Tokyo').h, 12);
});

test('filters', () => {
  assert.equal(checkTextFilters({}, media), null);
  assert.match(checkTextFilters({ includeKeywords: 'cats, dogs' }, media), /does not contain/);
  assert.equal(checkTextFilters({ includeKeywords: 'watch' }, media), null);
  assert.match(checkTextFilters({ excludeKeywords: 'second' }, media), /excluded/);
  assert.equal(checkTextFilters({ requiredHashtags: 'fun' }, media), null);
  assert.match(checkTextFilters({ requiredHashtags: '#fu' }, media), /missing/);
  assert.match(checkMediaFilters({ maxDuration: 60 }, { duration: 61 }), /longer/);
  assert.match(checkMediaFilters({ orientation: 'portrait' }, { kind: 'video', width: 1920, height: 1080, duration: 5 }), /landscape/);
});

test('feed parsing (RSS podcast + YouTube Atom)', () => {
  const rss = `<rss><channel><title>My Pod</title><item><title><![CDATA[Ep 1 &amp; more]]></title><guid>ep1</guid><pubDate>Mon, 02 Mar 2026 10:00:00 GMT</pubDate>
    <enclosure url="https://cdn.test/ep1.mp3" type="audio/mpeg" length="1"/><description>&lt;p&gt;Hello&lt;/p&gt;</description><itunes:image href="https://cdn.test/c.jpg"/></item></channel></rss>`;
  const f = parseFeed(rss);
  assert.equal(f.title, 'My Pod');
  assert.equal(f.items[0].title, 'Ep 1 & more');
  assert.equal(f.items[0].mediaUrl, 'https://cdn.test/ep1.mp3');
  assert.equal(f.items[0].description, 'Hello');
  assert.equal(f.items[0].image, 'https://cdn.test/c.jpg');
  const atom = `<feed><title>Chan</title><entry><id>yt:video:abc</id><yt:videoId>abc</yt:videoId><title>Vid</title><link rel="alternate" href="https://www.youtube.com/watch?v=abc"/><published>2026-03-01T00:00:00+00:00</published><media:group><media:description>Desc</media:description></media:group></entry></feed>`;
  const a = parseFeed(atom);
  assert.equal(a.items[0].ref, 'abc');
  assert.equal(a.items[0].url, 'https://www.youtube.com/watch?v=abc');
  assert.equal(a.items[0].description, 'Desc');
});

test('captions parse / retime / serialize (SRT + VTT)', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500 align:start\n<b>Hi</b> there\n\n00:00:04.000 --> 00:00:05.000\nBye\n';
  const cues = parseCaptions(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hi there');
  const r = retime(cues, { offsetMs: 2000, speed: 2, durationMs: 1200 });
  assert.deepEqual(r.map((c) => [c.start, c.end]), [[0, 750], [1000, 1200]]);
  assert.match(serializeSrt(r), /^1\n00:00:00,000 --> 00:00:00,750\nHi there\n/);
});

test('render timing & dims', () => {
  assert.deepEqual(timing({ trimStart: 2, cutEnd: 3, speed: 2 }, { duration: 20 }), { start: 2, outDur: 7.5, speed: 2 });
  assert.equal(timing({ maxDuration: 5 }, { duration: 20 }).outDur, 5);
  assert.deepEqual(outputDims({ aspect: '9:16' }, {}), [1080, 1920]);
  assert.deepEqual(outputDims({ aspect: 'original' }, { kind: 'video', width: 3840, height: 2160 }), [1920, 1080]);
  assert.deepEqual(outputDims({ aspect: 'original' }, { kind: 'audio' }), [1080, 1080]);
});

test('connector helpers', () => {
  assert.deepEqual(tiktokChunkPlan(1000), { chunkSize: 1000, count: 1 });
  const big = 100 * 1024 * 1024 + 123;
  assert.deepEqual(tiktokChunkPlan(big), { chunkSize: 10 * 1024 * 1024, count: 10 });
  assert.equal(escapeLittleText('Hi (you) #tag @me'), 'Hi \\(you\\) \\#tag \\@me');
  assert.equal(linkedinVersion(new Date(Date.UTC(2026, 10, 15))), '202608');
});

test('security helpers', () => {
  const enc = encrypt({ access_token: 'secret' });
  assert.ok(!enc.includes('secret'));
  assert.equal(decrypt(enc).access_token, 'secret');
  const h = hashPassword('hunter22');
  assert.ok(verifyPassword('hunter22', h));
  assert.ok(!verifyPassword('hunter23', h));
});
