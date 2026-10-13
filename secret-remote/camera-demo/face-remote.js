// FaceRemote: facial gestures → named events, on-device (MediaPipe Face Landmarker, bundled locally).
//
//   await FaceRemote.init(videoEl, { onGesture(name, value), onRaise, onDoubleBlink, onJaw, onFace, onFrame })
//   await FaceRemote.calibrate(onStep)      // 3 s neutral baseline, then raise your eyebrows twice
//   FaceRemote.CFG                          // thresholds; tune per device
//   FaceRemote.feed(scores, tMs, head)      // run the detectors on blendshape scores (+ optional head angles)
//   FaceRemote.headAngles(matrix)           // {yaw, pitch, roll} in degrees from MediaPipe's transformation matrix
//   FaceRemote.stop()
//
// Gestures (all fire once per occurrence; holding doesn't repeat):
//   expressions  raise, frown, smile, pucker, jaw (mouth open), mouthLeft, mouthRight
//   eyes         dblink (two blinks < 0.7 s), longBlink (eyes shut ≥ 0.7 s), winkLeft, winkRight
//   head         nod, shake, tiltLeft, tiltRight
// Left/right are always the *user's* own left/right.
import { FilesetResolver, FaceLandmarker } from "./vendor/mediapipe/vision_bundle.js";

const CFG = {
  browThreshold: 0.55, browRearm: 0.8, browDebounceMs: 400,      // eyebrow raise is instant (rising edge)
  blinkThreshold: 0.65, doubleBlinkMs: 700, minBlinkGapMs: 90, longBlinkMs: 700,
  winkClosedLeft: 0.55, winkClosedRight: 0.55, winkDiffLeft: 0.4, winkDiffRight: 0.4, winkHoldMs: 150,
  jawThreshold: 0.5, jawDebounceMs: 1000, jawEnabled: true,
  frownThreshold: 0.45, smileThreshold: 0.6, smileHoldMs: 400, puckerThreshold: 0.6, mouthLeftThreshold: 0.5, mouthRightThreshold: 0.5, holdMs: 250,
  tiltDeg: 18, tiltHoldMs: 350,
  nodDeg: 7, nodMaxDeg: 35, nodWindowMs: 900, shakeDeg: 9, shakeWindowMs: 1300,
  noFaceMs: 1000, everyOtherFrame: false,
};
// MediaPipe's blendshape names are from the subject's point of view (eyeBlinkLeft = the user's own left eye),
// checked by squashing one eye / shifting the mouth in real photos. Flip here if a future model changes that.
const SIDE = { left: "Left", right: "Right" };

let landmarker = null, video = null, handlers = {}, raf = 0, stream = null;
let state, holds, headHist, rollBase;
function resetState() {
  state = { browArmed: true, lastRaise: -1e9, eyesClosed: false, closedSince: 0, longFired: false, lastBlink: -1e9,
    jawArmed: true, lastJaw: -1e9, lastFaceAt: 0, faceShown: null, frame: 0, lastVideoTime: -1, headArmed: true, headFiredAt: 0 };
  holds = {}; headHist = []; rollBase = null;
}
resetState();
let sampler = null;   // used by calibration

const LEGACY = { raise: "onRaise", dblink: "onDoubleBlink", jaw: "onJaw" };
function emit(name, v) {
  handlers.onGesture && handlers.onGesture(name, v);
  const legacy = LEGACY[name]; if (legacy && handlers[legacy]) handlers[legacy](v);
}

// Fires once when v stays ≥ thr for holdMs; re-arms when v drops below thr × rearm.
function held(name, v, thr, holdMs, now, rearm = 0.7) {
  const h = holds[name] || (holds[name] = { armed: true, since: null });
  if (v >= thr) {
    if (h.since === null) h.since = now;
    if (h.armed && now - h.since >= holdMs) { h.armed = false; emit(name, v); }
  } else { h.since = null; if (!h.armed && v < thr * rearm) h.armed = true; }
}

// Alternating swings in a signal, with hysteresis: [+12, -10, +9] = up 12°, down 10°, up 9°.
function swings(xs, hyst) {
  if (xs.length < 2) return [];
  const tps = [xs[0]]; let dir = 0, ext = xs[0];
  for (const x of xs) {
    if (dir === 0) { if (Math.abs(x - tps[0]) >= hyst) { dir = Math.sign(x - tps[0]); ext = x; } }
    else if ((x - ext) * dir > 0) ext = x;
    else if (Math.abs(x - ext) >= hyst) { tps.push(ext); dir = -dir; ext = x; }
  }
  if (dir !== 0) tps.push(ext);
  return tps.slice(1).map((v, i) => v - tps[i]);
}
const range = xs => Math.max(...xs) - Math.min(...xs);

function feedHead(head, now) {
  // Tilt: roll away from your usual resting roll (learned slowly while you're not tilting).
  if (rollBase === null) rollBase = head.roll;
  const dr = head.roll - rollBase;
  if (Math.abs(dr) < CFG.tiltDeg / 2) rollBase += 0.02 * dr;
  held("tiltLeft", -dr, CFG.tiltDeg, CFG.tiltHoldMs, now, 0.5);
  held("tiltRight", dr, CFG.tiltDeg, CFG.tiltHoldMs, now, 0.5);
  // Nod / shake: quick back-and-forth in pitch / yaw, while the other axis stays fairly still.
  headHist.push({ t: now, yaw: head.yaw, pitch: head.pitch });
  while (headHist.length && now - headHist[0].t > CFG.shakeWindowMs) headHist.shift();
  // After a nod/shake, wait for the head to settle (still for 400 ms) so "yes-yes-yes" counts once.
  if (!state.headArmed) {
    const last = headHist.filter(s => now - s.t <= 400);
    if (now - state.headFiredAt > 400 && last.length > 5 && range(last.map(s => s.pitch)) < 4 && range(last.map(s => s.yaw)) < 4) { state.headArmed = true; headHist = []; }
    return;
  }
  const recent = headHist.filter(s => now - s.t <= CFG.nodWindowMs);
  const P = recent.map(s => s.pitch), Yr = recent.map(s => s.yaw), Y = headHist.map(s => s.yaw), Pl = headHist.map(s => s.pitch);
  const sp = swings(P, CFG.nodDeg * 0.5).filter(s => Math.abs(s) >= CFG.nodDeg && Math.abs(s) <= CFG.nodMaxDeg);
  const sy = swings(Y, CFG.shakeDeg * 0.5).filter(s => Math.abs(s) >= CFG.shakeDeg);
  let fired = null;
  if (sy.length >= 3 && range(Pl) < 0.6 * range(Y)) fired = "shake";
  else if (sp.length >= 2 && range(Yr) < 0.6 * range(P)) fired = "nod";
  if (fired) { emit(fired); state.headArmed = false; state.headFiredAt = now; }
}

function feed(s, now, head) {
  const g = n => s[n] || 0;
  const brow = Math.max(g("browInnerUp"), g("browOuterUpLeft"), g("browOuterUpRight"));
  const blinkL = g("eyeBlink" + SIDE.left), blinkR = g("eyeBlink" + SIDE.right), jaw = g("jawOpen");
  const frown = Math.max(g("browDownLeft"), g("browDownRight"));
  const smile = Math.min(g("mouthSmileLeft"), g("mouthSmileRight"));
  const pucker = g("mouthPucker"), mouthL = g("mouth" + SIDE.left), mouthR = g("mouth" + SIDE.right);
  // Eyebrow raise: rising edge through the threshold, debounced (instant, so it can drive a game).
  if (state.browArmed && brow >= CFG.browThreshold && now - state.lastRaise > CFG.browDebounceMs) {
    state.browArmed = false; state.lastRaise = now; emit("raise", brow);
  } else if (!state.browArmed && brow < CFG.browThreshold * CFG.browRearm) state.browArmed = true;
  // Blinks: count eye-closing onsets; two within doubleBlinkMs = double blink. Single blinks are never inputs.
  const closed = blinkL > CFG.blinkThreshold && blinkR > CFG.blinkThreshold;
  if (closed && !state.eyesClosed) {
    state.closedSince = now; state.longFired = false;
    const gap = now - state.lastBlink;
    if (gap > CFG.minBlinkGapMs && gap < CFG.doubleBlinkMs) { state.lastBlink = -1e9; emit("dblink"); }
    else state.lastBlink = now;
  }
  if (closed && !state.longFired && now - state.closedSince >= CFG.longBlinkMs) { state.longFired = true; state.lastBlink = -1e9; emit("longBlink"); }
  state.eyesClosed = closed;
  // Winks: one eye shut, the other clearly open (MediaPipe lets a wink pull the other eye's score up a bit).
  held("winkLeft", blinkL > CFG.winkClosedLeft && blinkL - blinkR > CFG.winkDiffLeft ? 1 : 0, 1, CFG.winkHoldMs, now);
  held("winkRight", blinkR > CFG.winkClosedRight && blinkR - blinkL > CFG.winkDiffRight ? 1 : 0, 1, CFG.winkHoldMs, now);
  // Jaw drop.
  if (CFG.jawEnabled) {
    if (state.jawArmed && jaw >= CFG.jawThreshold && now - state.lastJaw > CFG.jawDebounceMs) { state.jawArmed = false; state.lastJaw = now; emit("jaw", jaw); }
    else if (!state.jawArmed && jaw < CFG.jawThreshold * 0.7) state.jawArmed = true;
  }
  // Held expressions.
  held("frown", frown, CFG.frownThreshold, CFG.holdMs, now);
  held("smile", smile, CFG.smileThreshold, CFG.smileHoldMs, now);
  held("pucker", pucker, CFG.puckerThreshold, CFG.holdMs, now);
  held("mouthLeft", mouthL, CFG.mouthLeftThreshold, CFG.holdMs, now);
  held("mouthRight", mouthR, CFG.mouthRightThreshold, CFG.holdMs, now);
  if (head) feedHead(head, now);
  const values = { brow, blinkL, blinkR, jaw, frown, smile, pucker, mouthL, mouthR, ...(head || {}) };
  if (sampler) sampler(values, now);
  handlers.onFrame && handlers.onFrame(values);
  return values;
}

// Head angles from MediaPipe's 4×4 facial transformation matrix (column-major). Degrees.
// roll > 0 = head tilted towards the user's right shoulder (checked by rotating real photos 20°: roll moved ≈ 20°).
function headAngles(matrix) {
  const m = matrix.data || matrix, deg = 180 / Math.PI;
  return { yaw: Math.asin(Math.max(-1, Math.min(1, -m[2]))) * deg, pitch: Math.atan2(m[6], m[10]) * deg, roll: Math.atan2(m[1], m[0]) * deg };
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
  const now = performance.now();
  process(landmarker.detectForVideo(video, now), now);
}
// Shared by init()'s own loop and by GestureCam: one landmarker result → detectors + face-found hint.
function process(res, now) {
  const cats = res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
  if (cats) {
    state.lastFaceAt = now; setFace(true);
    const s = {}; for (const c of cats) s[c.categoryName] = c.score;
    const mx = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0];
    feed(s, now, mx ? headAngles(mx) : undefined);
  } else if (now - state.lastFaceAt > CFG.noFaceMs) setFace(false);
}

const LANDMARKER_OPTS = { runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true };

async function init(videoEl, h = {}) {
  video = videoEl; handlers = h;
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();
  const base = new URL("./vendor/mediapipe/wasm", import.meta.url).href;
  const fileset = await FilesetResolver.forVisionTasks(base);
  const opts = { baseOptions: { modelAssetPath: new URL("./models/face_landmarker.task", import.meta.url).href, delegate: "GPU" }, ...LANDMARKER_OPTS };
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

export const FaceRemote = { init, calibrate, feed, process, headAngles, stop, CFG, LANDMARKER_OPTS, reset: resetState,
  setHandlers: h => (handlers = h), _sampler: f => (sampler = f) };
