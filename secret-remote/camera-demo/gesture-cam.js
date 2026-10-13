// GestureCam: one camera, two trackers. Hand poses and swipes plus face and head moves all come out as
// named gestures (see hand-poses.js and face-remote.js for the full lists). All on-device.
//
//   const cam = await GestureCam.start(videoEl, { onGesture(name), onHandPose(pose|null), onFace(found), onFaceValues(v) })
//   cam.use.hands = false / cam.use.face = false   // switch a tracker off
//   await cam.calibrateFace(onStep)                  // eyebrow calibration (see face-remote.js)
//   cam.onRaw = frame => {}                         // every processed frame: { t, aspect, face: values|null, hands: [{ lm, pose, pos }] }
//   cam.stop()
import { FilesetResolver, FaceLandmarker, HandLandmarker } from "./vendor/mediapipe/vision_bundle.js";
import { FaceRemote } from "./face-remote.js?v=8";
import { classifyHand, palmCenter, makePoseTrigger, makeSwipeDetector, POSE_CFG, SWIPE_CFG } from "./hand-poses.js?v=8";

async function create(Task, fileset, model, extra) {
  const opts = { baseOptions: { modelAssetPath: new URL(`./models/${model}`, import.meta.url).href, delegate: "GPU" }, ...extra };
  try { return await Task.createFromOptions(fileset, opts); }
  catch { opts.baseOptions.delegate = "CPU"; return Task.createFromOptions(fileset, opts); }
}

async function start(video, h = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();
  const fileset = await FilesetResolver.forVisionTasks(new URL("./vendor/mediapipe/wasm", import.meta.url).href);
  const [face, hands] = await Promise.all([
    create(FaceLandmarker, fileset, "face_landmarker.task", FaceRemote.LANDMARKER_OPTS),
    create(HandLandmarker, fileset, "hand_landmarker.task", { runningMode: "VIDEO", numHands: 2 }),
  ]);
  const emit = g => h.onGesture && h.onGesture(g);
  FaceRemote.reset();
  let faceVals = null;
  FaceRemote.setHandlers({ onGesture: emit, onFace: f => h.onFace && h.onFace(f), onFrame: v => { faceVals = v; h.onFaceValues && h.onFaceValues(v); } });
  const trigger = makePoseTrigger(emit), swipe = makeSwipeDetector(emit);
  const use = { hands: true, face: true };
  let raf = 0, lastT = -1, lastPose, openAt = -1e9;

  function tick() {
    raf = requestAnimationFrame(tick);
    if (video.readyState < 2 || video.currentTime === lastT) return;
    lastT = video.currentTime;
    const now = performance.now(), frame = { t: now, aspect: video.videoWidth / video.videoHeight || 4 / 3, face: null, hands: [] };
    if (use.hands) {
      const r = hands.detectForVideo(video, now);
      const found = (r.landmarks || []).map(lm => ({ lm, pose: classifyHand(lm, frame.aspect), pos: palmCenter(lm) }));
      frame.hands = found;
      // Prefer a hand that's making a sign over one that's just resting (fist / unclear).
      const best = found.find(f => f.pose && f.pose !== "fist") || found.find(f => f.pose) || found[0];
      const pose = best ? best.pose : null, pos = best ? best.pos : null;
      trigger(pose, now, pos);
      // Swipes only count with an open hand (seen open in the last half second), not a hand drifting into view.
      if (pose === "palm" || pose === "four") openAt = now;
      swipe(pos && now - openAt < 500 ? pos : null, now);
      if (pose !== lastPose) { lastPose = pose; h.onHandPose && h.onHandPose(pose); }
    }
    if (use.face) { faceVals = null; FaceRemote.process(face.detectForVideo(video, now), now); frame.face = faceVals; }
    if (api.onRaw) api.onRaw(frame);
  }
  const api = {
    use, onRaw: null,
    calibrateFace: onStep => FaceRemote.calibrate(onStep),
    stop() { cancelAnimationFrame(raf); stream.getTracks().forEach(t => t.stop()); video.srcObject = null; face.close(); hands.close(); },
  };
  tick();
  return api;
}

export const GestureCam = { start, FaceRemote, POSE_CFG, SWIPE_CFG };
