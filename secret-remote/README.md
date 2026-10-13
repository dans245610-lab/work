# Secret Remote: play Flappy without touching the keyboard

There are two working demos of hands-free game input. Both run fully on-device: nothing is recorded or uploaded.

| Demo | File | Input | Needs |
|---|---|---|---|
| Secret Tap Remote | `flappy-tap-demo.html` | Desk taps, knocks and clicks picked up by the mic | Nothing. It's one self-contained file with no libraries, so you can double-click it. |
| Secret Camera Remote | `camera-demo/flappy-camera-demo.html` | Eyebrow raise, double blink, open mouth | A local web server or https (see below) |
| Hands-free Anki clicker | `anki-clicker.html` | Hand poses (palm, thumbs up/down) and face moves drive Anki reviews | Same as the camera demo, plus Anki desktop with AnkiConnect (or use the built-in practice deck) |

The keyboard always works as a fallback in both: `Space` flaps, `P` pauses, `R` restarts.

## Secret Tap Remote

**Controls:**

| Sound | Detected as | Action |
|---|---|---|
| Fingertip or knuckle tap on the desk | thud (< 900 Hz) or knock (900–2800 Hz) | Flap |
| Pen click or finger snap | click (> 2800 Hz) | Pause / resume |
| Any tap after a crash | | Restart |

Double and triple taps are detected and logged (a 650 ms window), but they are not mapped to anything in Flappy (see design notes).

**How it works (`TapRemote` in the file):**
- **Microphone setup:** `getUserMedia` with echo cancellation, noise suppression and auto gain all switched off, because voice processing smooths away exactly the transients we need. The page tells you if the device ignores that request.
- **Signal path:** an `AnalyserNode` with `fftSize` 2048 and smoothing 0.
- **Onset detection:** frame RMS must be above `max(calibrated threshold, 3.5 × adaptive noise floor, 0.012)` and also 1.6× the previous frame, with a 180 ms debounce. The noise floor only learns from quiet frames.
- **Classification:** a power-weighted spectral centroid, measured 20 ms after the onset.
- **Calibration (30 s button):** 2 s of quiet sets the floor, then you tap 5 times. The threshold becomes 45% of the median tap peak, and never less than 4× the floor.
- **UI:** a level meter with the threshold line (orange) and the floor line (grey), plus a tap log.

## Secret Camera Remote

**Controls:**

| Face | Action |
|---|---|
| Raise your eyebrows | Flap |
| Double blink (two within 700 ms) | Pause / resume |
| Open your mouth | Restart after a crash |

**Running it:** Chrome won't load ES modules or the face model from `file://`, so serve the folder:

```sh
cd secret-remote/camera-demo
python3 -m http.server 8000
# open http://localhost:8000/flappy-camera-demo.html
```

Any https host works too. The MediaPipe runtime (`vendor/mediapipe/`, Apache-2.0) and the model (`models/face_landmarker.task`, 3.7 MB) are bundled, so no CDN is needed.

**How it works (`face-remote.js`, `FaceRemote`):**
- **Model:** MediaPipe Face Landmarker in VIDEO mode with blend shapes on, at 640×480. It tries the GPU and falls back to the CPU.
- **Eyebrow raise:** brow = max(`browInnerUp`, `browOuterUpLeft`, `browOuterUpRight`). It fires on the rising edge through 0.55 with a 400 ms debounce. Holding the brows up flaps once, and it re-arms when brow drops below 80% of the threshold.
- **Double blink:** both `eyeBlink` scores above 0.65. Two eye-closing onsets 90–700 ms apart count as a double blink. Single blinks and winks never trigger anything.
- **Mouth:** `jawOpen` above 0.5, with a 1 s debounce. It only acts when the game is over. Turn it off with `FaceRemote.CFG.jawEnabled = false`.
- **Face hint:** "Looking for your face…" appears after more than 1 s with no face.
- **Calibration (15 s button):** a 3 s neutral baseline, then two eyebrow raises. The threshold is set halfway between your baseline maximum and your smaller raise.
- **Debug strip:** live bars for brow, blinkL, blinkR and jaw, each with its threshold mark.
- **API:** `FaceRemote.init(video, { onRaise, onDoubleBlink, onJaw, onFace, onFrame })`, `calibrate()`, `stop()`, `CFG`. `feed(scores, tMs)` drives the detector from any blend-shape source.

## Hands-free Anki clicker

Review Anki flashcards with your hands busy (treadmill desk, kitchen, workshop). Open `anki-clicker.html` and press **Start camera**.

There are 28 gestures. Every one can be mapped to Next, Again, Hard, Good, Easy, Undo or Nothing, and there are 4 presets to start from:

| Preset | Mapping |
|---|---|
| **Finger count = rating** (default) | 🖐 open hand → Next · ☝️ 1 / ✌️ 2 / 3 / 4 fingers → Again / Hard / Good / Easy (like Anki's 1–4 keys) · 👈 swipe left → Undo · 🤨 eyebrows → Next · nod → Good · shake → Again |
| **Thumbs** | 🖐 → Next · 👍 Good · 👎 Again · 👌 Easy · 👈 swipe → Undo · 🤨 → Next |
| **Face only** (hands full) | 🤨 → Next · nod → Good · shake → Again · 😁 big smile → Easy · 😠 frown → Hard · tilt head left → Undo |
| **Head only** (works with glasses, masks, beards) | tilt right → Next · nod → Good · shake → Again · tilt left → Undo |

"Next" shows the answer, or rates Good if the answer is already showing. Left and right are always *your* own left and right.

### All the cues

| Group | Cues | How it's detected |
|---|---|---|
| **Hand poses** (`hand-poses.js`) | 🖐 open hand · ☝️ 1 · ✌️ 2 · 3 · 4 (thumb tucked) · 👍 · 👎 · 👌 OK · 🤘 rock · 🤙 call me · ✊ fist | Ratios of each fingertip's and knuckle's distance from the wrist (so distance from the camera doesn't matter), plus where the thumb is. A pose must be held **still** for 300 ms, fires once, and re-arms when you drop it. |
| **Hand motion** | 👈 swipe left · 👉 swipe right | An open hand moves at least 22% of the frame width within 450 ms, mostly sideways. A hand drifting into view doesn't count. |
| **Face** (`face-remote.js`, MediaPipe blendshapes) | 🤨 eyebrows up · 😠 frown · 😁 big smile (both sides, held 0.4 s) · 😗 pucker · 😮 mouth open · 😏 mouth to the left or right · double blink · eyes shut 1 s · 😉 wink left or right eye | Rising edge plus a hold time on each blendshape score. Winks need one eye shut *and* clearly more shut than the other, held 150 ms, so ordinary blinks never count. |
| **Head** (face transformation matrix) | nod (yes) · shake (no) · tilt left · tilt right | **Nod:** 2 swings of 7–35° in pitch within 0.9 s. **Shake:** 3 swings of 9° or more in yaw within 1.3 s. Both re-arm only after the head has been still for 0.4 s, so "yes-yes-yes" counts once. **Tilt:** 18° of roll away from your usual resting tilt, held 0.35 s. |

### How each cue was checked

- **Hand poses, against about 9,000 real hand-landmark samples (ASL alphabet photos):**

  | Pose | Detected |
  |---|---|
  | 4 fingers | 97% |
  | 2 | 95–98% |
  | 3 | 83% (10% read as 2) |
  | 1 | 68–96% |
  | OK | 90% |
  | Call me | 88% |
  | Fist | 96–100% |

  Cross-confusion is low, and the hold-still rule smooths out single-frame slips.
- **Open-5 versus 4 fingers:** this hinges on the thumb. The thumb-tip-to-pinky-knuckle distance cleanly separates a tucked thumb (below 0.7 palm-widths) from a thumb that's out (above 1.2).
- **Hand poses with no real photos (thumbs up/down, rock, open 5):** tested on constructed hands.
  - 👍 and 👎 fire within about ±40° of vertical.
  - Real fists rotated in every direction misfire as a thumb pose 0.2–8% of frames, before the hold-still filter.
- **Face sides:**
  - Squashing one eye in real photos showed that MediaPipe's `eyeBlinkRight` is the person's own right eye.
  - Shifting the mouth confirmed `mouthRight` the same way.
  - Rotating photos 20° moved the measured roll by 18–22°, with the sign confirmed.
- **Face and head logic:** 27 scripted scenarios, all passing. These include the things that must **not** fire:
  - Glancing down at a phone.
  - Looking sideways and back.
  - Treadmill head bob (3° at 1.8 Hz).
  - Slowly looking around.
  - A crooked camera.
  - A brief tilt.
  - Normal and lopsided blinks.
  - A one-sided smirk.
  - A 0.2 s smile flicker.
- **End to end:** a real photo of a 4-finger hand fed through a fake camera rated a practice card Easy. Gestures against a fake AnkiConnect server produced the correct Anki calls.

### Options considered and left out

- **Tongue out, cheek puff:** MediaPipe's scores for these barely move on real faces, so they're unreliable.
- **Eye gaze (look left, right, up):** too noisy, and you look around naturally while reading cards.
- **Head turn (held yaw):** you turn your head constantly, so it would misfire. Shake covers "no".
- **Pinch:** looks like the OK sign and a resting hand.
- **Wave:** overlaps with swipes.
- **Swipe up or down:** a hand coming up into the frame looks like a swipe up.
- **Fist:** detected, but off by default, because it's how hands rest.
- **Smile:** off except in the face preset, because you smile at funny cards. It has to be a big smile on both sides, held for 0.4 s.

- **Practice deck:** the default mode. It's a small built-in Spanish deck that behaves like an Anki review, so you can try the whole flow without Anki installed.
- **My Anki (AnkiConnect):**
  1. Install the AnkiConnect add-on: Anki → Tools → Add-ons → Get Add-ons, code `2055492159`. Restart Anki.
  2. Press **Connect**. The page calls `requestPermission`, so Anki asks once whether to allow the page.
  3. Pick a deck and press **Start review**. Gestures then call `guiShowAnswer`, `guiAnswerCard` and `guiUndo`. The page mirrors the current card as plain text.
- **Safety:**
  - Every gesture fires once per occurrence. A hand pose must be held still for 300 ms, and you need to drop it before it fires again.
  - There's a 350 ms cooldown after each action.
  - Undo is always available: the ↶ button or `U`.
  - The **Watching** switch (`L`) pauses gestures.
- **Limits:**
  - Anki desktop must be open on the same computer. The phone apps don't run AnkiConnect.
  - Hosted on a website (not `localhost`), Chrome may ask to allow access to devices on your local network. Allow it, or run the page locally.
  - Safari may block a hosted page from reaching `localhost` at all.

## Honest limits

- **Camera LED:** your camera light will be on. On most laptops the LED is wired in hardware, and no web page can hide it.
- **Mic indicator:** the browser's tab indicator, and macOS's orange dot, will show the mic is in use. A page can't hide those either.
- **Tap classification depends on the surface:** a wooden desk, a laptop palm rest and a glass table sound very different. Calibrate on the surface you'll actually use.
- **Keyboard noise:** loud typing or music can still trigger flaps. Raise the threshold by calibrating while tapping firmly.
- **Eyebrow-raise strength varies a lot between people,** and glasses or fringes can hide the brows. Calibration fixes most of this. Good front lighting fixes the rest.

## Design notes (changes from the brief)

1. **Running from `file://`:** the camera demo can't, because the browser blocks modules and model loading there. The tap demo can.
2. **No waiting for patterns:** each tap fires instantly through `onHit`, and the single/double/triple pattern is reported afterwards through `onPattern`. Waiting 650 ms to resolve the pattern before every flap would make Flappy unplayable.
3. **Double tap is not pause:** in Flappy, flapping fast *is* a double tap, so pause moved to the click class (pen click or snap).
4. **Chest-tap variant:** taps on your chest through a phone in a shirt pocket are documented here only. They need a phone-side page and a link between devices, which is out of scope for these demos.

## Tested (Flappy demos)

Tested headlessly in Chromium:
- **Tap demo, synthetic recording:** fake mic input with nine synthetic taps (thuds, a knock, a click, a double and a triple). All 9 were detected and classified correctly, and the 2× and 3× patterns were reported.
- **Tap calibration:** reached 5/5 taps with the expected threshold.
- **Face detector logic, scripted blend-shape streams:**
  - A held raise flaps once.
  - Raises inside the debounce are ignored.
  - A single blink, winks and slow blinks are ignored.
  - A double blink pauses.
  - The jaw is debounced.
- **Face calibration:** gives the expected midpoint.
- **Camera page:** the init path works with a fake camera and shows the "looking for your face" hint.
- **Real model:** returns the 52 blend shapes on real portrait photos.

Anki clicker, also tested:
- **Real palm photo through a fake camera:** detected, and it flipped and rated the practice card.
- **Fake AnkiConnect server** (same origin rules as the real add-on):
  - Connect, deck list and start review all work.
  - Palm shows the answer, then rates Good. Thumbs up rates Good, thumbs down rates Again, and undo works.
  - Closing Anki shows a clear "Can't reach Anki" message.

Real-world feel on your own desk, face and hands has **not** been tested. Expect to tweak `CFG` for your setup.
