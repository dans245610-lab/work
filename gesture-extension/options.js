// Settings page: setup, inputs, mapping, live preview, calibration wizard, gaze calibration, Anki connection.
import { GROUPS, GESTURES, GESTURE, SOUND_IDS, ACTION_LIST, ACTION, PRESETS, fullMap, loadSettings } from "./catalog.js";
import { startEngine } from "./engine.js";
import { planSteps, runCalibration, applyCalibration, estimateSeconds } from "./lib/calibration.js";
import { AudioRemote } from "./lib/audio-remote.js";
import { fitGaze } from "./lib/eye-gaze.js";

const $ = id => document.getElementById(id);
const save = patch => chrome.storage.local.set(patch);
let S = await loadSettings();
chrome.storage.onChanged.addListener(async (c, area) => { if (area === "local") { S = await loadSettings(); render(); } });

/* ---------------- setup ---------------- */
async function permState() {
  const q = async name => { try { return (await navigator.permissions.query({ name })).state; } catch { return "unknown"; } };
  return { camera: await q("camera"), mic: await q("microphone") };
}
async function showPerm() {
  const p = await permState(), ok = p.camera === "granted";
  $("grantStatus").innerHTML = ok ? `<span class="ok">✓ Camera allowed</span>${p.mic === "granted" ? ' <span class="ok">✓ Microphone allowed</span>' : ' <span class="muted">(microphone not yet)</span>'}`
    : p.camera === "denied" ? '<span class="bad">Blocked. Click the camera icon in the address bar of this page to allow it, then reload.</span>' : "";
  $("grantBtn").textContent = ok ? "Allowed" : "Allow camera & microphone";
}
$("grantBtn").onclick = async () => {
  try { const st = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); st.getTracks().forEach(t => t.stop()); }
  catch { try { const st = await navigator.mediaDevices.getUserMedia({ video: true }); st.getTracks().forEach(t => t.stop()); } catch {} }
  showPerm();
};
$("enabled").onchange = e => save({ enabled: e.target.checked });

/* ---------------- inputs ---------------- */
for (const k of ["hands", "face", "gaze", "mic"]) $("in-" + k).onchange = e => save({ inputs: { ...S.inputs, [k]: e.target.checked } });
$("gz-down").onchange = e => save({ gaze: { ...S.gaze, scrollDown: e.target.checked } });
$("gz-up").onchange = e => save({ gaze: { ...S.gaze, scrollUp: e.target.checked } });
$("gz-speed").oninput = e => { $("gz-speedTxt").textContent = `${e.target.value} px/s`; };
$("gz-speed").onchange = e => save({ gaze: { ...S.gaze, speed: +e.target.value } });
$("scrollAmt").onchange = e => save({ scrollAmount: +e.target.value });
$("toast").onchange = e => save({ toast: e.target.checked });

/* ---------------- mapping ---------------- */
$("preset").replaceChildren(...Object.entries(PRESETS).map(([k, p]) => Object.assign(document.createElement("option"), { value: k, textContent: p.name })));
$("preset").onchange = e => { const p = PRESETS[e.target.value]; save(p.map ? { preset: e.target.value, map: p.map } : { preset: e.target.value }); openUsed(p.map || S.map); };
const groups = [...new Set(ACTION_LIST.map(a => a[2]))];
const optionsHtml = groups.map(g => {
  const opts = ACTION_LIST.filter(a => a[2] === g).map(([id, label]) => `<option value="${id}">${label}</option>`).join("");
  return g ? `<optgroup label="${g}">${opts}</optgroup>` : opts;
}).join("");
$("map").innerHTML = GROUPS.map(([name, input, list]) => `<details data-group="${name}"><summary>${name} <span class="muted" id="n-${name}"></span></summary><div class="map">` +
  list.map(([id, icon, label]) => `<label for="m-${id}">${icon} ${label}</label><select id="m-${id}">${optionsHtml}</select>`).join("") + "</div></details>").join("");
for (const [id] of GESTURES) $("m-" + id).onchange = e => save({ preset: "custom", map: { ...fullMap(S.map), [id]: e.target.value } });
function openUsed(m) { document.querySelectorAll("#map details").forEach((d, i) => (d.open = GROUPS[i][2].some(([id]) => m && m[id] && m[id] !== "none"))); }

function render() {
  $("enabled").checked = S.enabled;
  for (const k of ["hands", "face", "gaze", "mic"]) $("in-" + k).checked = S.inputs[k];
  $("gz-down").checked = S.gaze.scrollDown; $("gz-up").checked = S.gaze.scrollUp;
  $("gz-speed").value = S.gaze.speed; $("gz-speedTxt").textContent = `${S.gaze.speed} px/s`;
  $("scrollAmt").value = String(S.scrollAmount); $("toast").checked = S.toast;
  $("preset").value = S.preset; $("presetHelp").textContent = PRESETS[S.preset].help;
  const m = fullMap(S.map);
  for (const [id] of GESTURES) { $("m-" + id).value = m[id]; $("m-" + id).classList.toggle("on", m[id] !== "none"); }
  for (const [name, input, list] of GROUPS) {
    const n = list.filter(([id]) => m[id] !== "none").length, off = !S.inputs[input === "face" ? "face" : input];
    $("n-" + name).textContent = n ? `· ${n} on${off ? " (input off)" : ""}` : "";
  }
  calInfo();
}

/* ---------------- live preview (the background engine steps aside meanwhile) ---------------- */
let eng = null, mic = null, port = null;
async function startLive() {
  port = chrome.runtime.connect({ name: "options-live" });
  $("liveBtn").disabled = true; $("liveStatus").textContent = "Starting camera…";
  applyCalibration(S.calibration); AudioRemote.apply(S.calibration);
  try {
    eng = await startEngine($("video"), {
      onGesture: g => seen(g), onHandPose: p => ($("handTxt").textContent = "hand: " + (p ? `${GESTURE[p]?.icon || ""} ${p}` : "–")),
      onFace: f => ($("faceTxt").textContent = "face: " + (f ? "✓" : "looking…")),
      onGaze: y => ($("gazeMark").style.left = `${Math.max(0, Math.min(1, y)) * 100}%`),
    });
    eng.setGazeModel(S.gazeModel); eng.gazeZones = { down: false, up: false };
    Object.assign(eng.use, { hands: S.inputs.hands, face: S.inputs.face, gaze: true });   // gaze always: it drives the preview bar
    if (S.inputs.mic) { try { mic = await AudioRemote.start({ onGesture: g => seen(g) }); } catch { $("liveStatus").textContent = "Microphone unavailable; camera only."; } }
    $("liveBox").hidden = false; $("liveBtn").textContent = "Stop preview"; $("liveStatus").textContent = mic ? "Camera and mic on." : "Camera on.";
  } catch (e) {
    $("liveStatus").textContent = e.name === "NotAllowedError" ? "Camera blocked: press “Allow camera & microphone” first." : `Camera unavailable: ${e.message || e.name}`;
    stopLive();
  } finally { $("liveBtn").disabled = false; }
}
function stopLive() {
  if (eng) eng.stop(); if (mic) mic.stop(); eng = mic = null;
  if (port) port.disconnect(); port = null;
  $("liveBox").hidden = true; $("liveBtn").textContent = "Start preview";
}
$("liveBtn").onclick = () => (eng ? stopLive() : startLive());
let seenT = 0;
function seen(g) {
  const a = fullMap(S.map)[g];
  $("seenTxt").textContent = `seen: ${GESTURE[g]?.icon || ""} ${GESTURE[g]?.label || g} → ${a === "none" ? "not mapped" : ACTION[a]}`;
  clearTimeout(seenT); seenT = setTimeout(() => ($("seenTxt").textContent = "seen: –"), 3000);
}

/* ---------------- calibration wizard (camera + mic steps; shared runner from lib/calibration.js) ---------------- */
let calControl = null, calibrating = false;
// Only gestures whose input is switched on (hands / face & head / sounds) get calibration steps.
const INPUT_OF = Object.fromEntries(GROUPS.flatMap(([, input, list]) => list.map(([id]) => [id, input])));
function used(all) { const m = fullMap(S.map); return GESTURES.map(([id]) => id).filter(id => (all || m[id] !== "none") && S.inputs[INPUT_OF[id]]); }
function plan(ids) {
  const cam = ids.filter(id => !SOUND_IDS.has(id)), snd = ids.filter(id => SOUND_IDS.has(id));
  return [...(eng ? planSteps(cam) : []), ...(mic ? AudioRemote.planSteps(snd) : [])];
}
function calInfo() {
  const c = S.calibration, g = S.gazeModel;
  const parts = [c ? `Gestures calibrated ${new Date(c.at).toLocaleDateString()} (${c.report.filter(r => r.ok).length} ✓${c.report.some(r => r.ok === false) ? `, ${c.report.filter(r => r.ok === false).length} ⚠ kept defaults` : ""}).` : "Gestures not calibrated yet (defaults suit most people).",
    g ? `Gaze calibrated: about ±${Math.round(g.error * 100)}% of the screen height.` : "Gaze not calibrated: gaze scrolling stays off until you do."];
  if (eng) { const n = plan(used(false)); parts.push(n.length ? `Calibrating your gestures takes about ${Math.max(1, Math.round(estimateSeconds(n) / 60))} min.` : ""); }
  $("calInfo").textContent = parts.join(" ");
}
async function startWizard(all) {
  if (!eng || calibrating) return;
  const steps = plan(used(all));
  if (!steps.length) { $("liveStatus").textContent = "Nothing to calibrate for the inputs that are on."; return; }
  calibrating = true; calControl = { skip: false, stop: false };
  $("wizard").hidden = false; $("calReport").hidden = true; $("calDone").hidden = true; $("calSkip").hidden = $("calStop").hidden = false; $("calMeterBox").hidden = false;
  const sources = { camera: { subscribe(fn) { eng.onRaw = fn; return () => { eng.onRaw = null; }; } },
    audio: { subscribe(fn) { mic.onRaw = fn; return () => { mic.onRaw = null; }; } } };
  const ui = {
    control: calControl,
    step(st, i, n) { $("calStepNo").textContent = `Step ${i + 1} of ${n}`; $("calIcon").textContent = st.icon; $("calTitle").textContent = st.title; $("calSay").textContent = st.say; $("calResult").textContent = ""; $("calResult").className = "cal-result"; },
    phase(kind, frac) { $("calPhase").className = "cal-phase" + (kind === "go" ? " go" : ""); $("calPhase").textContent = kind === "go" ? "Go! Do it now…" : "Get ready…"; $("calProg").style.width = `${Math.round((kind === "go" ? frac : 1 - frac) * 100)}%`; },
    meter(x) { $("calMeter").style.width = `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`; },
    result(st, res) { $("calPhase").textContent = ""; $("calResult").className = "cal-result " + (res.ok ? "good" : res.ok === false ? "poor" : ""); $("calResult").textContent = (res.ok ? "✓ " : res.ok === false ? "⚠ " : "") + res.msg; },
  };
  const cal = await runCalibration(steps, sources, ui, { audio: AudioRemote.CFG });
  const prev = { face: {}, hand: {}, swipe: {}, audio: {}, report: [], ...(S.calibration || {}) };
  const merged = { at: cal.at, report: [...prev.report.filter(r => !cal.report.some(c => c.id === r.id)), ...cal.report] };
  for (const k of ["face", "hand", "swipe", "audio"]) merged[k] = { ...prev[k], ...(cal[k] || {}) };
  if (cal.report.length) await save({ calibration: merged });
  $("calStepNo").textContent = calControl.stop ? "Stopped: finished steps were saved" : "Calibration finished";
  $("calIcon").textContent = "✅"; $("calTitle").textContent = "Done"; $("calSay").textContent = "Steps marked ⚠ kept their default setting. The extension uses the new settings straight away.";
  $("calPhase").textContent = ""; $("calResult").textContent = ""; $("calMeterBox").hidden = true; $("calProg").style.width = "100%";
  $("calReport").replaceChildren(...cal.report.map(r => Object.assign(document.createElement("li"), { textContent: `${r.ok ? "✓" : r.ok === false ? "⚠" : "–"} ${r.icon} ${r.title}: ${r.msg}` })));
  $("calReport").hidden = false; $("calSkip").hidden = $("calStop").hidden = true; $("calDone").hidden = false;
}
$("calMine").onclick = () => startWizard(false);
$("calAll").onclick = () => startWizard(true);
$("calSkip").onclick = () => calControl && (calControl.skip = true);
$("calStop").onclick = () => calControl && (calControl.stop = true);
$("calDone").onclick = () => { $("wizard").hidden = true; calibrating = false; };
$("calReset").onclick = async () => { await save({ calibration: null, gazeModel: null }); applyCalibration(null); AudioRemote.apply(null); if (eng) eng.setGazeModel(null); };
addEventListener("keydown", e => { if (!calibrating || !calControl) return; if (e.key === "Escape") calControl.stop = true; if (e.key === "s" || e.key === "S") calControl.skip = true; });

/* ---------------- gaze calibration: full screen, 5 dots ---------------- */
$("gazeBtn").onclick = async () => {
  if (!eng) return;
  const box = $("gazeCal"); box.hidden = false;
  try { await box.requestFullscreen(); } catch {}
  await new Promise(r => setTimeout(r, 600));
  const dots = [0.5, 0.06, 0.94, 0.28, 0.72], samples = [];
  let cur = null;
  eng.onRaw = f => { if (cur !== null && f.gazeF && f.gazeF.blink < 0.45) samples.push({ f: f.gazeF, y: cur }); };
  for (const y of dots) {
    $("gazeDot").style.top = `${y * 100}%`; $("gazeDot").className = "";
    $("gazeMsg").style.top = y < 0.5 ? `calc(${y * 100}% + 30px)` : `calc(${y * 100}% - 50px)`;
    $("gazeMsg").textContent = "Look at the dot. Keep your head where it normally is.";
    cur = null; await new Promise(r => setTimeout(r, 1000));
    $("gazeDot").className = "collect"; cur = y; await new Promise(r => setTimeout(r, 1500));
  }
  cur = null; eng.onRaw = null;
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  box.hidden = true;
  const perDot = dots.map(y => samples.filter(s => s.y === y).length);
  if (perDot.filter(n => n >= 8).length < 4) { $("liveStatus").textContent = "Gaze calibration: not enough frames (face lost or lots of blinking). Try again."; return; }
  const m = fitGaze(samples);
  if (m.error > 0.22) { $("liveStatus").textContent = `Gaze calibration too rough (±${Math.round(m.error * 100)}%): your eyes barely moved between dots. Try again, maybe tipping your head slightly towards each dot.`; return; }
  await save({ gazeModel: m }); eng.setGazeModel(m);
  $("liveStatus").textContent = `Gaze calibrated: about ±${Math.round(m.error * 100)}% of the screen height.`;
};

/* ---------------- Anki ---------------- */
$("ankiBtn").onclick = async () => {
  $("ankiStatus").textContent = "Connecting… (check Anki for a popup)";
  const ac = async (action, params = {}) => { const r = await fetch("http://127.0.0.1:8765", { method: "POST", body: JSON.stringify({ action, version: 6, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error); return j.result; };
  try {
    const p = await ac("requestPermission");
    if (p.permission !== "granted") throw new Error("Anki refused: allow it in the Anki popup and try again");
    await ac("version"); const decks = await ac("deckNames");
    $("ankiStatus").innerHTML = `<span class="ok">✓ Connected (${decks.length} decks)</span>. Start a review in Anki, then use the Anki preset.`;
  } catch (e) { $("ankiStatus").innerHTML = `<span class="bad">${/fetch/i.test(e.message) ? "Can't reach Anki: open Anki desktop with AnkiConnect installed" : e.message}</span>`; }
};

render(); openUsed(S.map); showPerm();
if (location.hash.includes("debug")) window.__opts = { get eng() { return eng; }, get mic() { return mic; }, startLive, stopLive, startWizard };
