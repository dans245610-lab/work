// EyeGaze: vertical gaze from a webcam, on-device (MediaPipe Face Landmarker with iris points, bundled locally).
//
//   const eyes = await EyeGaze.start(videoEl, { onFrame(features | null) })   // features every camera frame, null = no face
//   const model = fitGaze(samples)          // samples: [{ f: features, y: 0..1 screen height }] from looking at dots
//   predict(model, features)                 → 0 (top) … 1 (bottom)
//   eyes.stop()
//
// Webcam eye tracking is coarse: expect roughly ±10–15 % of the screen height after calibration. So three signals
// are combined and calibration learns how much each one counts for *you*:
//   up     MediaPipe's eyeLookUp − eyeLookDown blendshapes (both eyes)
//   iris   iris centre above/below the line between the eye corners, ÷ eye width (both eyes)
//   pitch  head pitch (people look partly with their head)
// Blinks make all eye signals jump, so frames with closed eyes are flagged (features.blink) for the caller to skip.
import { FilesetResolver, FaceLandmarker } from "./vendor/mediapipe/vision_bundle.js";
import { FaceRemote } from "./face-remote.js?v=9";

// Landmark indices (MediaPipe 478-point mesh): [corner, corner, iris centre] for each eye.
const EYES = [[33, 133, 468], [362, 263, 473]];
export const FEATURES = ["up", "iris", "pitch"];

export function gazeFeatures(landmarks, blend, matrix) {
  const g = n => (blend && blend[n]) || 0;
  let iris = 0;
  for (const [a, b, c] of EYES) {
    const A = landmarks[a], B = landmarks[b], C = landmarks[c];
    const w = Math.hypot(B.x - A.x, B.y - A.y) || 1e-6;
    // Signed distance of the iris centre from the corner-to-corner line, positive = above it (looking up).
    const cross = ((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) / w;
    iris += (A.x < B.x ? -cross : cross) / w / EYES.length;
  }
  const up = (g("eyeLookUpLeft") + g("eyeLookUpRight") - g("eyeLookDownLeft") - g("eyeLookDownRight")) / 2;
  const pitch = matrix ? FaceRemote.headAngles(matrix).pitch : 0;
  return { up, iris, pitch, blink: Math.max(g("eyeBlinkLeft"), g("eyeBlinkRight")) };
}

/* ---------- calibration: ridge regression from the three signals to screen height ---------- */
function solve(A, b) {   // Gaussian elimination with partial pivoting
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < n; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  return M.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[n] / r[i]));
}
export function fitGaze(samples, lambda = 0.05) {
  const X = samples.map(s => FEATURES.map(k => s.f[k])), y = samples.map(s => s.y), n = X.length;
  const mean = FEATURES.map((_, j) => X.reduce((a, r) => a + r[j], 0) / n);
  const sd = FEATURES.map((_, j) => Math.sqrt(X.reduce((a, r) => a + (r[j] - mean[j]) ** 2, 0) / n) || 1);
  const Z = X.map(r => [1, ...r.map((v, j) => (v - mean[j]) / sd[j])]);
  const k = Z[0].length, A = Array.from({ length: k }, () => Array(k).fill(0)), b = Array(k).fill(0);
  for (let i = 0; i < n; i++) for (let p = 0; p < k; p++) { b[p] += Z[i][p] * y[i]; for (let q = 0; q < k; q++) A[p][q] += Z[i][p] * Z[i][q]; }
  for (let p = 1; p < k; p++) A[p][p] += lambda * n;   // ridge (not on the bias): stops a signal that barely moved from blowing up
  const w = solve(A, b), model = { mean, sd, w };
  // How good is it? Average error on the calibration points (each dot's frames averaged first, as the game smooths too).
  const byDot = new Map(); samples.forEach(s => { const key = s.y.toFixed(3); if (!byDot.has(key)) byDot.set(key, []); byDot.get(key).push(predict(model, s.f)); });
  const errs = [...byDot.entries()].map(([yy, ps]) => Math.abs(ps.reduce((a, v) => a + v, 0) / ps.length - +yy));
  model.error = errs.reduce((a, v) => a + v, 0) / errs.length;            // fraction of screen height
  const contrib = FEATURES.map((_, j) => Math.abs(w[j + 1]));
  const tot = contrib.reduce((a, v) => a + v, 0) || 1;
  model.weights = Object.fromEntries(FEATURES.map((f, j) => [f, contrib[j] / tot]));   // what it relies on, for the UI
  return model;
}
export function predict(model, f) {
  let y = model.w[0];
  FEATURES.forEach((k, j) => { y += model.w[j + 1] * (f[k] - model.mean[j]) / model.sd[j]; });
  return y;
}
// Without calibration: MediaPipe's look-up/down score alone, roughly centred.
export const DEFAULT_MODEL = { mean: [0, 0, 0], sd: [1, 1, 1], w: [0.5, -1.4, 0, 0], error: null, weights: { up: 1, iris: 0, pitch: 0 } };

/* ---------- One Euro filter: smooth when still, responsive when moving ---------- */
export function oneEuro(minCutoff = 1.2, beta = 0.5, dCutoff = 1) {
  let x = null, dx = 0, t0 = 0;
  const alpha = (cut, dt) => 1 / (1 + 1 / (2 * Math.PI * cut * dt));
  return (v, t) => {
    if (x === null) { x = v; t0 = t; return v; }
    const dt = Math.max(1e-3, (t - t0) / 1000); t0 = t;
    const d = (v - x) / dt; dx += alpha(dCutoff, dt) * (d - dx);
    x += alpha(minCutoff + beta * Math.abs(dx), dt) * (v - x);
    return x;
  };
}

async function start(video, h = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();
  const fileset = await FilesetResolver.forVisionTasks(new URL("./vendor/mediapipe/wasm", import.meta.url).href);
  const opts = { baseOptions: { modelAssetPath: new URL("./models/face_landmarker.task", import.meta.url).href, delegate: "GPU" }, ...FaceRemote.LANDMARKER_OPTS };
  let lm; try { lm = await FaceLandmarker.createFromOptions(fileset, opts); } catch { opts.baseOptions.delegate = "CPU"; lm = await FaceLandmarker.createFromOptions(fileset, opts); }
  let raf = 0, lastT = -1;
  function tick() {
    raf = requestAnimationFrame(tick);
    if (video.readyState < 2 || video.currentTime === lastT) return;
    lastT = video.currentTime;
    const now = performance.now(), r = lm.detectForVideo(video, now);
    const L = r.faceLandmarks && r.faceLandmarks[0];
    if (!L || L.length < 478) { h.onFrame && h.onFrame(null, now); return; }
    const blend = {}; for (const c of r.faceBlendshapes[0].categories) blend[c.categoryName] = c.score;
    h.onFrame && h.onFrame(gazeFeatures(L, blend, r.facialTransformationMatrixes && r.facialTransformationMatrixes[0]), now);
  }
  tick();
  return { stop() { cancelAnimationFrame(raf); stream.getTracks().forEach(t => t.stop()); video.srcObject = null; lm.close(); } };
}

export const EyeGaze = { start };
