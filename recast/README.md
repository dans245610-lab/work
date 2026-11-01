# Recast

Self-hosted content repurposing. Recast watches your sources (TikTok, YouTube, Instagram, Facebook Pages, podcast/RSS feeds, public profiles, a server folder, or your own uploads). Each new video gets reformatted per platform, branded, captioned, and published to your destinations on your schedule.

**No npm dependencies.** It runs on Node ≥ 22.13, which has built-in SQLite, plus `ffmpeg`. `yt-dlp` is optional.

```bash
cp .env.example .env     # optional — the defaults work locally
npm start                # http://localhost:4000
npm test                 # unit + end-to-end tests (needs ffmpeg)
```

Or with Docker (includes ffmpeg and yt-dlp):

```bash
docker build -t recast . && docker run -p 4000:4000 -v recast-data:/data --env-file .env recast
```

## What it does

| Area | Features |
|---|---|
| **Workflows** | Source → many destinations. Picks up content published after the workflow was created. "Repurpose existing" backfills the last N items. Can be paused, run on demand, or edited. |
| **Filters** | Include/exclude keywords, required hashtags, min/max duration, orientation. |
| **Formatting** (per destination) | 9:16 / 1:1 / 4:5 / 16:9 / original, with blur-fill, crop or bars. Trim start, cut N seconds from the end (e.g. TikTok end screen), max length (auto-capped to the platform limit), speed, mute, mirror, loudness normalisation (−14 LUFS), hook headline overlay, burned-in captions from an attached `.srt`/`.vtt`, high-quality mode. |
| **Podcasts** | Audio items become audiogram videos (waveform, title, cover art or brand colour). |
| **Brand kits** | Logo (position/size/opacity), text watermark, caption style (size, colours, position, boxed), accent colour, intro and outro clips (resized to each format and joined on). |
| **Captions** | Templates with `{{title}} {{description}} {{hashtags}} {{first_line}} {{source_url}} {{date}}`. Add or remove hashtags, strip source hashtags or @mentions. Trimmed to each platform's limits. The editor shows a live preview. |
| **Scheduling** | Right away, after a delay, or recurring time slots (days × times, in your timezone, one post per slot per account). An optional "hold for approval" step lets you review the render and edit the text before it goes out. |
| **Queue** | List and calendar views, with live render progress, approve, publish now, reschedule, edit, re-render, retry, cancel and download. |
| **Library** | Drag-and-drop uploads with progress, import by URL, attach captions, a quick format preview render, and manual one-off publishing to any destinations. |
| **Ops** | Dashboard, activity log, retrying job queue with backoff, token refresh, expiring signed public video URLs, render retention cleanup, and multi-user accounts. |

## Connectors

| Platform | Source | Destination | Notes |
|---|---|---|---|
| TikTok | ✓ (lists via API, downloads via yt-dlp) | ✓ Content Posting API: direct post or drafts inbox, chunked upload | Unaudited TikTok apps can only post privately or to drafts. |
| YouTube | ✓ (channel feed + yt-dlp) | ✓ resumable upload, Shorts URL detection | Visibility and category options. |
| Instagram | ✓ (own Reels via Graph API) | ✓ Reels via the Instagram API with Instagram Login | Needs a public `PUBLIC_BASE_URL`, because Instagram pulls the video from it. |
| Facebook Pages | ✓ | ✓ Reels (rupload) or regular video | One connection is created per Page. |
| LinkedIn | | ✓ Videos API (multipart) + Posts API | The API version auto-tracks about 3 months back; override with `LINKEDIN_API_VERSION`. |
| X | | ✓ v2 chunked media upload + tweet | OAuth 2 with PKCE. |
| RSS / Podcast | ✓ audio/video enclosures, YouTube Atom feeds | | |
| Public profile | ✓ any yt-dlp-supported profile/playlist URL | | No API app needed. |
| Server folder | ✓ watch folder | ✓ export `.mp4` + caption `.txt` | Sandboxed to `FOLDER_ROOT`. |
| Webhook | | ✓ signed JSON POST (`X-Recast-Signature`) with a 24h video URL | Works with Zapier, Make, n8n and similar. |
| Library uploads | ✓ (built-in) | | |

**Demo connections.** Every OAuth platform can be added as a *demo* connection. Demo sources produce sample clips, and demo destinations simulate publishing. This lets you exercise the whole pipeline (render, review, schedule, "publish") before you register any developer apps.

### Setting up real platforms

1. Create a developer app on the platform (Google Cloud for YouTube Data API v3, TikTok for Developers, Meta for Developers, LinkedIn Developers, X Developer Portal).
2. Register the redirect URI shown under **Settings → Platform apps** (`PUBLIC_BASE_URL/oauth/callback/<platform>`).
3. Put the client ID and secret in `.env` and restart.

The platform API integrations follow each platform's published API, but they have **not been exercised against live accounts** in this repository's tests. Expect to work through app review and scopes on each platform, and possibly small API adjustments. The tests cover the full pipeline end to end, using demo connections and the folder destination.

## Architecture

```
server/
  index.js          boot HTTP server + worker
  app.js            routing, CSRF guard, static SPA
  db.js             node:sqlite schema + helpers
  jobs.js           durable job queue (dedupe keys, retries with backoff)
  worker.js         job runner + scheduler tick (polls due sources)
  pipeline.js       discover → download → render → schedule → publish
  media/ffmpeg.js   probe, thumbnails, render graph (reformat, brand, captions, audiogram, intro/outro)
  connectors/       one module per platform + OAuth/token refresh + demo mode
  routes/           REST API (auth, connections, media, workflows, posts, brand kits, dashboard)
  lib/              templates, schedule (timezone slots), filters, RSS parser, security
web/                vanilla-JS SPA (no build step)
test/               node:test unit + end-to-end tests
```

Post lifecycle: `waiting_media → rendering → (needs_approval) → scheduled → publishing → published | failed | skipped | canceled`.

Security: scrypt password hashing; HttpOnly SameSite session cookies; a custom-header CSRF guard on mutating API calls; OAuth tokens encrypted with AES-256-GCM; HMAC-signed, expiring public render URLs; per-user ownership checks on every resource; login throttling; and folder connectors confined to `FOLDER_ROOT`.

## Configuration

See `.env.example`. The most important variables:

- `PUBLIC_BASE_URL`: used for OAuth redirects and for the public video URLs that Instagram, Facebook and webhooks download from.
- `RECAST_SECRET`: if empty, one is generated into `DATA_DIR`.
- `POLL_INTERVAL_MINUTES` and `WORKER_CONCURRENCY`.
- `RENDER_PRESET`: the x264 preset, `veryfast` by default.
- `RENDER_RETENTION_DAYS`: published renders are deleted after this many days (14 by default).
- `MAX_UPLOAD_MB`.

## Clickable demo

`demo/` builds a static demo: the real frontend running against a simulated backend in the browser, with sample videos rendered by Recast's own ffmpeg pipeline. Nothing is uploaded or posted.

```bash
node --disable-warning=ExperimentalWarning demo/build.mjs   # writes demo/site/ (add --skip-media to reuse rendered samples)
```

To host `demo/site/` on **Cloudflare Pages** (free, gives you a `*.pages.dev` address):
Cloudflare dashboard → Workers & Pages → Create → Pages → **Connect to Git** → pick this repository and branch →
Framework preset *None*, build command *(empty)*, build output directory `recast/demo/site` → Save and Deploy.

The full app can't run on Cloudflare Pages or Workers, because it needs ffmpeg, a writable disk and a long-running worker. Use a container host for it (the Dockerfile works on Render, Railway, Fly.io, or Cloudflare Containers).
