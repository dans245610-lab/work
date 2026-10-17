// Engine: one camera, one face model, one hand model → every camera gesture plus eye gaze. All on-device.
//
//   const eng = await startEngine(videoEl, { onGesture(name), onHandPose(pose|null), onFace(found), onGaze(y, t), onGazeZone(dir) })
//   eng.use = { hands, face, gaze }      // switch parts off (saves CPU)
//   eng.setGazeModel(model)               // from the gaze calibration (null = rough default)
//   eng.gazeZones = { down: true, up: false }
//   eng.onRaw = frame => {}                // every processed frame (calibration): { t, aspect, face, hands, gazeF }
//   eng.stop()
import { FilesetResolver, FaceLandmarker, HandLandmarker } from "./lib/vendor/mediapipe/vision_bundle.js";
import { FaceRemote } from "./lib/face-remote.js";
import { classifyHand, palmCenter, makePoseTrigger, makeSwipeDetector } from "./lib/hand-poses.js";
import { gazeFeatures, predict, oneEuro, DEFAULT_MODEL } from "./lib/eye-gaze.js";
import { everyFrame } from "./lib/ticker.js";

async function create(fileset, Task, model, extra) {
  const opts = { baseOptions: { modelAssetPath: chrome.runtime.getURL(`lib/models/${model}`), delegate: "GPU" }, ...extra };
  try { return await Task.createFromOptions(fileset, opts); }
  catch { opts.baseOptions.delegate = "CPU"; return Task.createFromOptions(fileset, opts); }
}

export async function startEngine(video, h = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();
  const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("lib/vendor/mediapipe/wasm"));
  const [face, hands] = await Promise.all([
    create(fileset, FaceLandmarker, "face_landmarker.task", FaceRemote.LANDMARKER_OPTS),
    create(fileset, HandLandmarker, "hand_landmarker.task", { runningMode: "VIDEO", numHands: 2 }),
  ]);
  const emit = g => h.onGesture && h.onGesture(g);
  FaceRemote.reset();
  let faceVals = null;
  FaceRemote.setHandlers({ onGesture: emit, onFace: f => h.onFace && h.onFace(f), onFrame: v => { faceVals = v; } });
  const trigger = makePoseTrigger(emit), swipe = makeSwipeDetector(emit);
  let stopLoop = null, lastT = -1, lastPose, openAt = -1e9;

  /* --- gaze: blink-safe (see Flappy Eyes), then "look at the bottom/top edge" zones --- */
  let gazeModel = null, smooth = oneEuro(), blinkBase = 0.15, blinkUntil = -1e9, pending = [], win = [];
  let zone = null, zoneCand = null, zoneSince = 0;
  const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  function gazeFrame(f, t) {
    const line = Math.max(0.4, blinkBase + 0.18);
    if (f.blink > line) { blinkUntil = t + 150; pending = []; return; }
    if (f.blink < line - 0.1) blinkBase += 0.02 * (f.blink - blinkBase);
    if (t < blinkUntil) return;
    pending.push([f, t]); if (pending.length <= 2) return;
    const [g, tg] = pending.shift();
    win.push(Math.max(-0.1, Math.min(1.1, predict(gazeModel || DEFAULT_MODEL, g)))); if (win.length > 3) win.shift();
    const y = smooth(median(win), tg);
    h.onGaze && h.onGaze(y, tg);
    // Zones need a calibrated model (the default is too rough to scroll on) and a short dwell, with hysteresis.
    if (!gazeModel) return setZone(null);
    const want = api.gazeZones.down && y > 0.85 ? "down" : api.gazeZones.up && y < 0.1 ? "up"
      : zone === "down" && y > 0.75 ? "down" : zone === "up" && y < 0.2 ? "up" : null;
    if (want !== zoneCand) { zoneCand = want; zoneSince = tg; }
    if (want !== zone && tg - zoneSince >= (want ? (want === "up" ? 900 : 600) : 120)) setZone(want);
  }
  function setZone(z) { if (z !== zone) { zone = z; h.onGazeZone && h.onGazeZone(z); } }

  function tick() {
    if (video.readyState < 2 || video.currentTime === lastT) return;
    lastT = video.currentTime;
    const now = performance.now(), frame = { t: now, aspect: video.videoWidth / video.videoHeight || 4 / 3, face: null, hands: [], gazeF: null };
    if (api.use.hands) {
      const r = hands.detectForVideo(video, now);
      const found = (r.landmarks || []).map(lm => ({ lm, pose: classifyHand(lm, frame.aspect), pos: palmCenter(lm) }));
      frame.hands = found;
      const best = found.find(f => f.pose && f.pose !== "fist") || found.find(f => f.pose) || found[0];
      const pose = best ? best.pose : null, pos = best ? best.pos : null;
      trigger(pose, now, pos);
      if (pose === "palm" || pose === "four") openAt = now;
      swipe(pos && now - openAt < 500 ? pos : null, now);
      if (pose !== lastPose) { lastPose = pose; h.onHandPose && h.onHandPose(pose); }
    }
    if (api.use.face || api.use.gaze) {
      const r = face.detectForVideo(video, now);
      faceVals = null;
      if (api.use.face) FaceRemote.process(r, now);
      const L = r.faceLandmarks && r.faceLandmarks[0];
      if (L && L.length >= 478) {
        const bl = {}; for (const c of r.faceBlendshapes[0].categories) bl[c.categoryName] = c.score;
        frame.gazeF = gazeFeatures(L, bl, r.facialTransformationMatrixes && r.facialTransformationMatrixes[0]);
        if (api.use.gaze) gazeFrame(frame.gazeF, now);
      } else if (!api.use.face && h.onFace) h.onFace(false);
      frame.face = faceVals;
    }
    if (api.onRaw) api.onRaw(frame);
  }
  const api = {
    use: { hands: true, face: true, gaze: true }, gazeZones: { down: true, up: false }, onRaw: null,
    setGazeModel(m) { gazeModel = m; smooth = oneEuro(); win = []; setZone(null); },
    stop() { stopLoop && stopLoop(); stream.getTracks().forEach(t => t.stop()); video.srcObject = null; face.close(); hands.close(); },
  };
  stopLoop = everyFrame(tick);   // not requestAnimationFrame: it never runs in the hidden offscreen page
  return api;
}
