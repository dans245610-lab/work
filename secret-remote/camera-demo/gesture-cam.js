// GestureCam: one camera, two trackers. Hand poses (palm / thumbs up / thumbs down) and face moves
// (eyebrow raise / double blink / open mouth) come out as named gestures. All on-device.
//
//   const cam = await GestureCam.start(videoEl, { onGesture(name), onHandPose(pose|null), onFace(found) })
//   cam.use.hands = false / cam.use.face = false   // switch a tracker off
//   await cam.calibrateFace(onStep)                  // eyebrow calibration (see face-remote.js)
//   cam.stop()
import { FilesetResolver, FaceLandmarker, HandLandmarker } from "./vendor/mediapipe/vision_bundle.js";
import { FaceRemote } from "./face-remote.js";
import { classifyHand, makePoseTrigger } from "./hand-poses.js";

async function create(Task, fileset, model, extra) {
  const opts = { baseOptions: { modelAssetPath: new URL(`./models/${model}`, import.meta.url).href, delegate: "GPU" }, runningMode: "VIDEO", ...extra };
  try { return await Task.createFromOptions(fileset, opts); }
  catch { opts.baseOptions.delegate = "CPU"; return Task.createFromOptions(fileset, opts); }
}

async function start(video, h = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();
  const fileset = await FilesetResolver.forVisionTasks(new URL("./vendor/mediapipe/wasm", import.meta.url).href);
  const [face, hands] = await Promise.all([
    create(FaceLandmarker, fileset, "face_landmarker.task", { numFaces: 1, outputFaceBlendshapes: true }),
    create(HandLandmarker, fileset, "hand_landmarker.task", { numHands: 2 }),
  ]);
  const emit = g => h.onGesture && h.onGesture(g);
  FaceRemote.setHandlers({ onRaise: () => emit("raise"), onDoubleBlink: () => emit("dblink"), onJaw: () => emit("jaw") });
  const trigger = makePoseTrigger(emit);
  const use = { hands: true, face: true };
  let raf = 0, lastT = -1, lastFaceAt = performance.now(), faceShown = null, lastPose;

  function tick() {
    raf = requestAnimationFrame(tick);
    if (video.readyState < 2 || video.currentTime === lastT) return;
    lastT = video.currentTime;
    const now = performance.now();
    if (use.hands) {
      const r = hands.detectForVideo(video, now), aspect = video.videoWidth / video.videoHeight || 4 / 3;
      const pose = (r.landmarks || []).map(lm => classifyHand(lm, aspect)).find(Boolean) || null;
      trigger(pose, now);
      if (pose !== lastPose) { lastPose = pose; h.onHandPose && h.onHandPose(pose); }
    }
    if (use.face) {
      const r = face.detectForVideo(video, now);
      const cats = r.faceBlendshapes && r.faceBlendshapes[0] && r.faceBlendshapes[0].categories;
      if (cats) { const s = {}; for (const c of cats) s[c.categoryName] = c.score; FaceRemote.feed(s, now); lastFaceAt = now; }
      const found = !!cats || now - lastFaceAt < FaceRemote.CFG.noFaceMs;
      if (found !== faceShown) { faceShown = found; h.onFace && h.onFace(found); }
    }
  }
  tick();
  return {
    use,
    calibrateFace: onStep => FaceRemote.calibrate(onStep),
    stop() { cancelAnimationFrame(raf); stream.getTracks().forEach(t => t.stop()); video.srcObject = null; face.close(); hands.close(); },
  };
}

export const GestureCam = { start, FaceRemote };
