// Runs the engines and reports gestures to the background worker. Settings come from the background
// (offscreen documents can't use chrome.storage).
import { startEngine } from "./engine.js";
import { applyCalibration } from "./lib/calibration.js";
import { AudioRemote } from "./lib/audio-remote.js";

let eng = null, mic = null, settings = null, starting = null;
const send = msg => chrome.runtime.sendMessage({ from: "offscreen", ...msg }).catch(() => {});
const status = {};
const report = patch => { Object.assign(status, patch); send({ type: "status", status }); };

async function apply(s) {
  settings = s;
  applyCalibration(s.calibration); AudioRemote.apply(s.calibration);
  const camWanted = s.inputs.hands || s.inputs.face || s.inputs.gaze;
  try {
    if (camWanted && !eng) {
      report({ camera: "starting" });
      eng = await startEngine(document.getElementById("video"), {
        onGesture: name => send({ type: "gesture", name }),
        onHandPose: pose => report({ hand: pose }),
        onFace: found => report({ face: found }),
        onGazeZone: dir => send({ type: "gazeZone", dir }),
      });
      report({ camera: "on", error: null });
    } else if (!camWanted && eng) { eng.stop(); eng = null; report({ camera: "off", hand: null, face: null }); }
    if (eng) {
      Object.assign(eng.use, { hands: s.inputs.hands, face: s.inputs.face, gaze: s.inputs.gaze });
      eng.gazeZones = { down: s.gaze.scrollDown, up: s.gaze.scrollUp };
      eng.setGazeModel(s.gazeModel);
    }
    if (s.inputs.mic && !mic) {
      report({ mic: "starting" });
      mic = await AudioRemote.start({ onGesture: name => send({ type: "gesture", name }) });
      report({ mic: "on" });
    } else if (!s.inputs.mic && mic) { mic.stop(); mic = null; report({ mic: "off" }); }
  } catch (e) {
    report({ error: e.name === "NotAllowedError" ? "permission" : (e.message || e.name), camera: eng ? "on" : "off", mic: mic ? "on" : "off" });
  }
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.to !== "offscreen") return;
  if (msg.type === "settings") starting = (starting || Promise.resolve()).then(() => apply(msg.settings));
});
send({ type: "ready" });
