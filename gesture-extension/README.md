# Gesture Control: a Chrome extension

Control Chrome hands-free with **hand signs, face and head moves, eye gaze, desk taps and whistles**. It brings together everything from the hand-tracking demos in this repo (Secret Remote, the Anki clicker and Flappy Eyes). Video and sound are processed **on your device only**.

## Install (2 minutes)

1. Download **`dist/gesture-control-extension.zip`** from this repo and unzip it. You get a folder called `gesture-extension`.
   (Or clone the repo and use the `gesture-extension/` folder directly.)
2. In Chrome, open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `gesture-extension` folder.
4. The settings page opens. Click **Allow camera & microphone**, then tick **Turn Gesture Control on**.
5. Pick a preset, press **Start preview**, then **Calibrate my gestures** (about 1 minute) and, if you want gaze scrolling, **Calibrate eye gaze**.

Pin the extension (the puzzle icon → pin) to see the **ON / II** badge and use the quick popup. **Alt+Shift+G** pauses and resumes from anywhere.

## What it can do

**37 gestures**, each mappable to any action:

| Input | Gestures |
|---|---|
| 🖐 Hands | open hand · 1 / 2 / 3 / 4 fingers · 👍 · 👎 · 👌 · 🤘 · 🤙 · ✊ · swipe left / right |
| 🤨 Face | eyebrows up · frown · big smile · pucker · mouth open · mouth left / right · double blink · eyes shut 1 s · wink left / right |
| ↕️ Head | nod · shake · tilt left / right · nod left / right |
| 👆 Sounds | 1 / 2 / 3 desk taps · pen click / snap · whistle · whistle sliding up / down |
| 👀 Gaze | look at the bottom of the screen to keep scrolling down (top-edge scrolling up is optional) |

**Actions:**
- **Page:** scroll down / up, top / bottom of page.
- **Tabs:** next / previous tab, back, forward, reload, zoom in / out / reset.
- **Media:** play/pause the page's video, ±10 s, mute.
- **Keys:** → ← ↓ ↑, Space, Enter, Esc, 1–4. These are for slides, AnkiWeb and games.
- **Anki desktop** (via AnkiConnect): show answer / Good, Again / Hard / Good / Easy, Undo.
- **Pause / resume gestures.**

**Presets:** Browsing · Reading (hands free) · Video · Slides · Anki desktop · AnkiWeb · Custom.

## How it works

| File | Role |
|---|---|
| `background.js` | Service worker. Keeps the engine running while it's on, maps gestures to actions, runs them through the `tabs` and `scripting` APIs, and shows a confirmation pill on the page. **Acts only while a Chrome window is in front.** |
| `offscreen.html/js` | Hidden offscreen document. Chrome only allows camera and mic capture in one of these. It runs the engines and messages gestures to the background. |
| `engine.js` | One camera, one MediaPipe face model, one hand model. Produces hand poses and swipes, face and head gestures, and blink-safe eye gaze with edge zones. |
| `lib/` | The detectors from the demos: `hand-poses.js`, `face-remote.js`, `eye-gaze.js`, `audio-remote.js`, `calibration.js`. Also the bundled MediaPipe runtime and models (no CDN), and `ticker.js`. |
| `options.html/js` | Setup, inputs, the mapping, a live preview (the background engine steps aside while it runs), the calibration wizard, full-screen gaze calibration, and the Anki connection. |
| `popup.html/js` | On/off, pause, preset, live status, last gesture. |

A detail that matters: hidden pages never get `requestAnimationFrame`. So the camera and mic loops run on a **ping-pong worker ticker** (`lib/ticker.js`). The page asks for the next tick only after finishing the current frame, so ticks can't pile up on a slow machine.

**Permissions:**
- `offscreen`: camera and mic in the hidden page.
- `tabs` and `scripting` with `<all_urls>`: act on the tab you're looking at.
- `storage`: your settings and calibration.

There are no network requests, except to Anki on `127.0.0.1:8765` if you use the Anki actions.

## Tested (Chromium, extension loaded unpacked, fake camera and microphone)

- **Install and setup:** the settings page opens on install, permission grants, the hidden engine starts the camera with MediaPipe loading under the extension's security policy, and the badge shows ON.
- **Actions:** scroll down/up (with the page confirmation), video play/pause, next/previous tab (wrapping around), pause/resume (gestures are ignored while paused), slide keys reaching the page, gaze scrolling at the set speed and stopping when you look away, and a clean "can't act on this page" on `chrome://` pages.
- **Real recognition path:** a real hand photo fed in as the camera was recognised as "4 fingers" by the hidden engine, mapped to Scroll down, and the page scrolled.
  - This caught a real bug, now fixed: the hidden page never ran its frame loop.
- **Sounds through the extension:** taps (1/2/3), pen click, whistles (steady, rising, falling) and knocks all fired their actions. Speech and music were ignored.
- **Preview handoff:** the background engine closes while the settings preview has the camera, and comes back afterwards.
- **Calibration wizard:** runs inside the extension and reports clearly on steps it can't measure.

**Not tested:**
- Your real hands, face, eyes and room.
- Real Anki.
- The "only when Chrome is in front" check while another app has focus, which headless Chrome can't simulate. The logic is simple: it asks Chrome whether its last window is focused.

## Limits

- **Camera light and mic indicator:** the camera light stays on while it's on, as does Chrome's mic indicator when Sounds is enabled. Turn it off from the popup.
- **Pages it can't reach:** it can't act inside `chrome://` pages, the Chrome Web Store or the PDF viewer. Tab actions still work there.
- **Key actions** are synthetic key presses. Apps that listen for keys react; Chrome's own built-in shortcuts don't.
- **CPU use:** face and hand models together use noticeable CPU on older laptops. Switch off inputs you don't use.
- **Gaze precision:** webcam gaze is about ±10–15% of the screen height, which is fine for edge scrolling but not for pointing.
