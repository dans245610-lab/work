# Little Hands: baby sign practice

Practise 20 everyday baby signs from American Sign Language (ASL) at home, with live feedback from your
camera on **hand shape**, **place** and **movement**. Runs entirely in the browser: no accounts, no
uploads, no analytics, and it works offline after the first visit.

> **A practice aid, not a teacher.** ASL is the language of the Deaf community. Every sign links to
> example videos by Deaf signers, and the app encourages learning from Deaf instructors.

## Features
- 20 signs in four groups: Mealtime (milk, more, eat, drink, water, all done), Manners (please, thank you,
  yes, no), Family & feelings (mommy, daddy, baby, I love you, hurt, help), Routines & play (sleep, bath, book, play).
- Live three-part check per sign, with specific hints ("Bring your thumb to your chin", "Tap 2 times: 1 / 2").
- On-screen target on your face or chest, hand outline, celebration when you get it.
- For each sign: diagram, hand-shape pictures, steps, ASL gloss, "when to use it" tip for parents,
  and links to example videos (ASL University / Lifeprint and Signing Savvy).
- Quiz mode, progress saved on the device, settings for sound and confetti.
- About page: respecting ASL and the Deaf community, learning resources, family resources for babies who
  are deaf or hard of hearing, privacy, disclaimer, accessibility, credits.

## Privacy
- Camera frames are processed on-device by MediaPipe (bundled in `vendor/` and `models/`) and discarded.
- A Content-Security-Policy restricts every page to this site's own files (`connect-src 'self'`), so the
  app cannot send data anywhere. The test suite checks that no request ever leaves the site.
- Stored locally only: progress, settings, and whether the welcome message was seen (`localStorage`,
  keys starting `lh.`). Settings → Clear progress removes progress.
- The camera only runs during practice, and stops when you leave a lesson, press "Turn off", or hide the tab.

## Run locally
Any static web server works. The camera needs `https://` or `localhost`.
```sh
npm start            # serves this folder at http://localhost:8080 (no dependencies needed)
# or: python3 -m http.server 8080
```

## Deploy
Upload the folder as-is to any static host (Netlify, Cloudflare Pages, GitHub Pages, Vercel, S3...).
- It must be served over **https** (browsers only allow the camera on secure origins).
- `_headers` adds security headers on Netlify and Cloudflare Pages. On other hosts, the in-page
  Content-Security-Policy still applies; ideally also send `Permissions-Policy: camera=(self)` and
  `X-Content-Type-Options: nosniff`.
- Total size is about 32 MB, mostly the two models and the WebAssembly runtime (downloaded once, then cached).
- After changing any file, bump `VERSION` in `sw.js` so returning visitors get the update.

## Test
```sh
npm install          # Playwright + axe-core (dev only)
npx playwright install chromium   # first time only
npm test
```
Checks (fake camera, simulated hands, no real person needed):
privacy (no requests leave the site, no CSP violations, models served locally, camera released, camera
badge accurate) · offline mode · all 20 signs recognised and 6 wrong versions rejected · accessibility
(axe, WCAG 2 A/AA) · phone layout.

## How recognition works
`js/recognizer.js` turns hand landmarks into hand shapes (which fingers are straight, bent or touching;
thresholds validated on ~2,700 real hand photos), checks places on the body from the pose landmarks
(forehead, eyes, mouth, chin, chest), and checks movement over the last few seconds (taps, circles,
twists, holds and so on). It's rule-based and approximate by design.

## Project layout
```
index.html, about.html     pages (each with its own Content-Security-Policy)
css/app.css                styles
js/app.js                  UI, lessons, quiz, camera lifecycle
js/recognizer.js           hand shapes, places, movements, the 20 signs
js/sign-info.js            ASL glosses and example-video links
js/vision.js               camera + MediaPipe setup (local files only)
js/handsvg.js, js/handshape-data.js   hand diagrams
vendor/mediapipe/          MediaPipe Tasks Vision 0.10.14 (Apache-2.0) + WebAssembly runtime
models/                    hand landmarker + pose landmarker (lite) models (Apache-2.0)
sw.js, manifest.webmanifest, icons/   offline support and install
tests/                     local server, end-to-end tests, simulated signers
```

## Credits and licences
See `THIRD_PARTY_NOTICES.md`.
