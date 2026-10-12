// Shared webcam + MediaPipe hand tracking for the hand-tracked games.
// Hands come back in *mirrored screen pixels* (the video is shown mirrored, the canvas is not),
// so "left" on screen is the player's left, and text can be drawn normally.
import { FilesetResolver, HandLandmarker, PoseLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const POSE_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

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

// Body pose (face + shoulders), for signs that happen at a place on the body.
export async function loadPoseModel() {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const opts = {
    baseOptions: { modelAssetPath: POSE_MODEL, delegate: location.hash.includes("cpu") ? "CPU" : "GPU" },
    runningMode: "VIDEO", numPoses: 1, minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
  };
  try { return await PoseLandmarker.createFromOptions(fileset, opts); }
  catch { opts.baseOptions.delegate = "CPU"; return PoseLandmarker.createFromOptions(fileset, opts); }
}

// Landmarks of the body that signs refer to, in mirrored screen pixels, plus a size unit
// (eyes-to-mouth distance) so "near" scales with how close you sit to the camera.
export function readBody(res, video, canvas) {
  const lm = res && res.landmarks && res.landmarks[0];
  if (!lm) return null;
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1, cw = canvas.width, ch = canvas.height;
  const scale = Math.max(cw / vw, ch / vh), dw = vw * scale, dh = vh * scale, ox = (cw - dw) / 2, oy = (ch - dh) / 2;
  const P = i => ({ x: cw - (ox + lm[i].x * dw), y: oy + lm[i].y * dh, v: lm[i].visibility ?? 1 });
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const eyes = mid(P(2), P(5)), mouth = mid(P(9), P(10)), nose = P(0), sL = P(11), sR = P(12);
  const unit = Math.hypot(mouth.x - eyes.x, mouth.y - eyes.y) || 1;
  const dx = mouth.x - eyes.x, dy = mouth.y - eyes.y;
  const shoulders = mid(sL, sR), sw = Math.hypot(sL.x - sR.x, sL.y - sR.y);
  return {
    eyes, mouth, nose, unit,
    chin: { x: mouth.x + dx * 0.6, y: mouth.y + dy * 0.6 },
    forehead: { x: eyes.x - dx * 0.9, y: eyes.y - dy * 0.9 },
    chest: { x: shoulders.x, y: shoulders.y + sw * 0.25 },
    shoulderW: sw, shouldersSeen: sL.v > 0.4 && sR.v > 0.4,
  };
}

let lastPoseTime = -1;
export function detectBody(poser, video, canvas, ms) {
  if (video.readyState < 2 || video.currentTime === lastPoseTime) return undefined;
  lastPoseTime = video.currentTime;
  return readBody(poser.detectForVideo(video, ms), video, canvas);
}
