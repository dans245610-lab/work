// Camera + on-device hand and body tracking (MediaPipe, bundled with the app).
// Every file is loaded from this site; frames never leave the browser.
import { FilesetResolver, HandLandmarker, PoseLandmarker } from "../vendor/mediapipe/vision_bundle.js";

const WASM = new URL("../vendor/mediapipe/wasm", import.meta.url).href;
const HAND_MODEL = new URL("../models/hand_landmarker.task", import.meta.url).href;
const POSE_MODEL = new URL("../models/pose_landmarker_lite.task", import.meta.url).href;

// Friendly messages for the ways starting a camera can fail.
export class CameraError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

export async function startCamera(video) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new CameraError("unsupported", "This browser can't use the camera here. Open the app over https (or on localhost) in a recent Chrome, Edge, Firefox or Safari.");
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream;
    await video.play();
    return stream;
  } catch (e) {
    if (e.name === "NotAllowedError" || e.name === "SecurityError") throw new CameraError("denied", "Camera permission was blocked. Allow the camera for this site in your browser's address bar or settings, then try again.");
    if (e.name === "NotFoundError" || e.name === "OverconstrainedError") throw new CameraError("missing", "No camera was found. Plug one in or try another device.");
    if (e.name === "NotReadableError" || e.name === "AbortError") throw new CameraError("busy", "The camera is being used by another app. Close it there and try again.");
    throw new CameraError("other", "The camera couldn't start: " + e.message);
  }
}

export function stopCamera(video) {
  const s = video.srcObject;
  if (s) for (const t of s.getTracks()) t.stop();
  video.srcObject = null;
}

let fileset = null;
async function create(Task, model, extra) {
  fileset = fileset || (await FilesetResolver.forVisionTasks(WASM));
  const opts = { baseOptions: { modelAssetPath: model, delegate: "GPU" }, runningMode: "VIDEO", ...extra };
  try { return await Task.createFromOptions(fileset, opts); }
  catch { opts.baseOptions.delegate = "CPU"; return Task.createFromOptions(fileset, opts); }
}
export async function loadModels() {
  const [hands, pose] = await Promise.all([
    create(HandLandmarker, HAND_MODEL, { numHands: 2, minHandDetectionConfidence: 0.5, minTrackingConfidence: 0.5 }),
    create(PoseLandmarker, POSE_MODEL, { numPoses: 1, minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5 }),
  ]);
  return { hands, pose };
}

export function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

// Maps normalized video coordinates to mirrored canvas pixels (the video is shown mirrored, object-fit: cover).
function mapper(video, canvas) {
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1, cw = canvas.width, ch = canvas.height;
  const scale = Math.max(cw / vw, ch / vh), dw = vw * scale, dh = vh * scale, ox = (cw - dw) / 2, oy = (ch - dh) / 2;
  return { map: (x, y) => ({ x: cw - (ox + x * dw), y: oy + y * dh }), dw };
}

let lastTime = -1;
// Returns { hands, body } for a new video frame, or null if there is no new frame yet.
export function track(models, video, canvas, ms) {
  if (video.readyState < 2 || video.currentTime === lastTime) return null;
  lastTime = video.currentTime;
  const { map, dw } = mapper(video, canvas);
  const hr = models.hands.detectForVideo(video, ms);
  const hands = (hr.landmarks || []).map((lm, i) => {
    const pts = lm.map(q => ({ ...map(q.x, q.y), z: q.z * dw }));
    const center = [0, 5, 9, 13, 17].reduce((s, k) => ({ x: s.x + pts[k].x / 5, y: s.y + pts[k].y / 5 }), { x: 0, y: 0 });
    return { pts, world: hr.worldLandmarks?.[i], center, palm: Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y) || 1 };
  });
  const pr = models.pose.detectForVideo(video, ms);
  return { hands, body: readBody(pr.landmarks?.[0], map) };
}

// Places on the body that signs refer to, plus a size unit (eyes→mouth) so "near" scales with distance.
function readBody(lm, map) {
  if (!lm) return null;
  const P = i => ({ ...map(lm[i].x, lm[i].y), v: lm[i].visibility ?? 1 });
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const eyes = mid(P(2), P(5)), mouth = mid(P(9), P(10)), sL = P(11), sR = P(12);
  const dx = mouth.x - eyes.x, dy = mouth.y - eyes.y, unit = Math.hypot(dx, dy) || 1;
  const shoulders = mid(sL, sR), sw = Math.hypot(sL.x - sR.x, sL.y - sR.y);
  return {
    eyes, mouth, nose: P(0), unit,
    chin: { x: mouth.x + dx * 0.6, y: mouth.y + dy * 0.6 },
    forehead: { x: eyes.x - dx * 0.9, y: eyes.y - dy * 0.9 },
    chest: { x: shoulders.x, y: shoulders.y + sw * 0.25 },
    shoulderW: sw,
  };
}
