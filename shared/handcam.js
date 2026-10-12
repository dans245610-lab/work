// Shared webcam + MediaPipe hand tracking for the hand-tracked games.
// Hands come back in *mirrored screen pixels* (the video is shown mirrored, the canvas is not),
// so "left" on screen is the player's left, and text can be drawn normally.
import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

export async function loadHandModel(numHands = 2) {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const opts = {
    baseOptions: { modelAssetPath: MODEL, delegate: location.hash.includes("cpu") ? "CPU" : "GPU" },
    runningMode: "VIDEO", numHands, minHandDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
  };
  try { return await HandLandmarker.createFromOptions(fileset, opts); }
  catch { opts.baseOptions.delegate = "CPU"; return HandLandmarker.createFromOptions(fileset, opts); }
}

export function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return dpr;
}

// Finger extension from 3D world landmarks: wrist->tip distance over wrist->knuckle distance.
// ~1.7-2.0 when straight, ~0.9-1.2 when curled. Order: index, middle, ring, pinky.
export function extension(W) {
  if (!W) return null;
  const d = (a, b) => Math.hypot(W[a].x - W[b].x, W[a].y - W[b].y, W[a].z - W[b].z);
  return [[5, 8], [9, 12], [13, 16], [17, 20]].map(([m, t]) => d(0, t) / (d(0, m) || 1));
}

// Runs the detector on a new video frame; returns null when there is no new frame.
let lastVideoTime = -1;
export function detectHands(landmarker, video, canvas, ms) {
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return null;
  lastVideoTime = video.currentTime;
  const res = landmarker.detectForVideo(video, ms);
  return readHands(res, video, canvas);
}

export function readHands(res, video, canvas) {
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1, cw = canvas.width, ch = canvas.height;
  const scale = Math.max(cw / vw, ch / vh), dw = vw * scale, dh = vh * scale;
  const ox = (cw - dw) / 2, oy = (ch - dh) / 2;
  return (res.landmarks || []).map((lm, i) => {
    const pts = lm.map(q => ({ x: cw - (ox + q.x * dw), y: oy + q.y * dh, z: q.z * dw }));
    const world = res.worldLandmarks?.[i];
    const c = [0, 5, 9, 13, 17].reduce((s, k) => ({ x: s.x + pts[k].x / 5, y: s.y + pts[k].y / 5 }), { x: 0, y: 0 });
    return { pts, world, center: c, palm: Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y) || 1, ext: extension(world) };
  });
}
