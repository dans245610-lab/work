// FaceRemote: facial gestures → game inputs, on-device (MediaPipe Face Landmarker, bundled locally).
//
//   await FaceRemote.init(videoEl, { onRaise, onDoubleBlink, onJaw, onFace, onFrame })
//   await FaceRemote.calibrate(onStep)      // 3 s neutral baseline, then raise your eyebrows twice
//   FaceRemote.CFG                          // thresholds; tune per device
//   FaceRemote.feed(scores, tMs)            // run the detector on blendshape scores you supply (tests / other models)
//   FaceRemote.stop()
//
// Signals: brow = max(browInnerUp, browOuterUpLeft, browOuterUpRight); blink = both eyeBlink above threshold;
// jaw = jawOpen. All are rising-edge events (holding a pose doesn't repeat) with debounce.
import { FilesetResolver, FaceLandmarker } from "./vendor/mediapipe/vision_bundle.js";

const CFG = {
  browThreshold: 0.55, browRearm: 0.8,        // re-arm once brow falls below threshold × browRearm
  browDebounceMs: 400,
  blinkThreshold: 0.65, doubleBlinkMs: 700, minBlinkGapMs: 90,
  jawThreshold: 0.5, jawDebounceMs: 1000, jawEnabled: true,
  noFaceMs: 1000, everyOtherFrame: false,
};

let landmarker = null, video = null, handlers = {}, raf = 0, stream = null;
const state = { browArmed: true, lastRaise: -1e9, eyesClosed: false, lastBlink: -1e9, jawArmed: true, lastJaw: -1e9, lastFaceAt: 0, faceShown: null, frame: 0, lastVideoTime: -1 };
let sampler = null;   // used by calibration

function feed(s, now) {
  const brow = Math.max(s.browInnerUp || 0, s.browOuterUpLeft || 0, s.browOuterUpRight || 0);
  const blinkL = s.eyeBlinkLeft || 0, blinkR = s.eyeBlinkRight || 0, jaw = s.jawOpen || 0;
  // Eyebrow raise: rising edge through the threshold, debounced.
  if (state.browArmed && brow >= CFG.browThreshold && now - state.lastRaise > CFG.browDebounceMs) {
    state.browArmed = false; state.lastRaise = now; handlers.onRaise && handlers.onRaise(brow);
  } else if (!state.browArmed && brow < CFG.browThreshold * CFG.browRearm) state.browArmed = true;
  // Blinks: count eye-closing onsets; two within doubleBlinkMs = double blink. Single blinks are never inputs.
  const closed = blinkL > CFG.blinkThreshold && blinkR > CFG.blinkThreshold;
  if (closed && !state.eyesClosed) {
    const gap = now - state.lastBlink;
    if (gap > CFG.minBlinkGapMs && gap < CFG.doubleBlinkMs) { state.lastBlink = -1e9; handlers.onDoubleBlink && handlers.onDoubleBlink(); }
    else state.lastBlink = now;
  }
  state.eyesClosed = closed;
  // Jaw drop (optional).
  if (CFG.jawEnabled) {
    if (state.jawArmed && jaw >= CFG.jawThreshold && now - state.lastJaw > CFG.jawDebounceMs) { state.jawArmed = false; state.lastJaw = now; handlers.onJaw && handlers.onJaw(jaw); }
    else if (!state.jawArmed && jaw < CFG.jawThreshold * 0.7) state.jawArmed = true;
  }
  const values = { brow, blinkL, blinkR, jaw };
  if (sampler) sampler(values, now);
  handlers.onFrame && handlers.onFrame(values);
  return values;
}

function setFace(found) {
  if (state.faceShown === found) return;
  state.faceShown = found;
  handlers.onFace && handlers.onFace(found);
}

function tick() {
  raf = requestAnimationFrame(tick);
  if (video.readyState < 2 || video.currentTime === state.lastVideoTime) return;
  state.lastVideoTime = video.currentTime;
  if (CFG.everyOtherFrame && (state.frame++ & 1)) return;
  const now = performance.now(), res = landmarker.detectForVideo(video, now);
  const cats = res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
  if (cats) {
    state.lastFaceAt = now; setFace(true);
    const s = {}; for (const c of cats) s[c.categoryName] = c.score;
    feed(s, now);
  } else if (now - state.lastFaceAt > CFG.noFaceMs) setFace(false);
}

async function init(videoEl, h = {}) {
  video = videoEl; handlers = h;
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();
  const base = new URL("./vendor/mediapipe/wasm", import.meta.url).href;
  const fileset = await FilesetResolver.forVisionTasks(base);
  const opts = { baseOptions: { modelAssetPath: new URL("./models/face_landmarker.task", import.meta.url).href, delegate: "GPU" },
    runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true };
  try { landmarker = await FaceLandmarker.createFromOptions(fileset, opts); }
  catch { opts.baseOptions.delegate = "CPU"; landmarker = await FaceLandmarker.createFromOptions(fileset, opts); }
  state.lastFaceAt = performance.now();
  tick();
}

// 3 s neutral baseline, then two eyebrow raises; threshold goes halfway between baseline max and the smaller raise.
async function calibrate(onStep = () => {}) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  onStep("neutral", "Relax and look at the screen for 3 seconds…");
  let baseMax = 0;
  sampler = v => { baseMax = Math.max(baseMax, v.brow); };
  await wait(3000);
  onStep("raise", "Now raise your eyebrows twice.");
  const peaks = []; let inRaise = false, peak = 0;
  const gate = Math.min(0.9, baseMax + 0.08);
  sampler = v => {
    if (v.brow > gate) { inRaise = true; peak = Math.max(peak, v.brow); }
    else if (inRaise && v.brow < gate - 0.03) { peaks.push(peak); inRaise = false; peak = 0; onStep("raise", `Raises seen: ${peaks.length} / 2`); }
  };
  const t0 = performance.now();
  while (peaks.length < 2 && performance.now() - t0 < 10000) await wait(50);
  sampler = null;
  if (peaks.length < 2) { onStep("failed", "Couldn't see two clear eyebrow raises. Try more light on your face, then calibrate again."); return { baseline: baseMax, threshold: CFG.browThreshold, ok: false }; }
  CFG.browThreshold = +((baseMax + Math.min(...peaks)) / 2).toFixed(3);
  onStep("done", `Calibrated: eyebrow threshold ${CFG.browThreshold}`);
  return { baseline: baseMax, threshold: CFG.browThreshold, ok: true };
}

function stop() { cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach(t => t.stop()); if (video) video.srcObject = null; }

export const FaceRemote = { init, calibrate, feed, stop, CFG, setHandlers: h => (handlers = h), _sampler: f => (sampler = f) };
