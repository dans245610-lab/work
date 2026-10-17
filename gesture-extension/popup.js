import { PRESETS, GESTURE, ACTION, loadSettings } from "./catalog.js";
const $ = id => document.getElementById(id);
$("preset").replaceChildren(...Object.entries(PRESETS).map(([k, p]) => Object.assign(document.createElement("option"), { value: k, textContent: p.name })));

async function render() {
  const s = await loadSettings(), { status = {}, last } = await chrome.storage.session.get(["status", "last"]);
  $("enabled").checked = s.enabled;
  $("watchBtn").textContent = s.watching ? "Pause" : "Resume"; $("watchBtn").disabled = !s.enabled;
  $("preset").value = s.preset; $("help").textContent = PRESETS[s.preset].help;
  $("cam").textContent = "camera: " + (s.enabled && (s.inputs.hands || s.inputs.face || s.inputs.gaze) ? status.camera || "starting" : "off");
  $("mic").textContent = "mic: " + (s.enabled && s.inputs.mic ? status.mic || "starting" : "off");
  $("face").textContent = "face: " + (status.face ? "✓" : "–");
  $("hand").textContent = "hand: " + (status.hand ? (GESTURE[status.hand]?.icon || "") + " " + status.hand : "–");
  $("last").textContent = last ? `${GESTURE[last.name]?.icon || ""} ${GESTURE[last.name]?.label || last.name} → ${ACTION[last.action] || last.action}${last.result && last.result !== "ok" ? ` (${last.result})` : ""}` : "–";
  const err = status.error && s.enabled ? (status.error === "permission" ? "Camera/mic permission needed: open Settings and press “Allow camera & microphone”." : status.error) : "";
  $("err").hidden = !err; $("err").textContent = err;
}
$("enabled").onchange = e => chrome.storage.local.set({ enabled: e.target.checked });
$("watchBtn").onclick = async () => { const s = await loadSettings(); chrome.storage.local.set({ watching: !s.watching }); };
$("preset").onchange = e => { const p = PRESETS[e.target.value]; chrome.storage.local.set(p.map ? { preset: e.target.value, map: p.map } : { preset: e.target.value }); };
$("opts").onclick = () => chrome.runtime.openOptionsPage();
chrome.storage.onChanged.addListener(render);
render();
