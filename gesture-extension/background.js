// Background worker: keeps the offscreen engine running while enabled, turns gestures into browser actions,
// and shows a small confirmation on the page. Acts only while a Chrome window is in front.
import { DEFAULT_SETTINGS, PRESETS, GESTURE, ACTION, loadSettings } from "./catalog.js";

let settings = null;
const getSettings = async () => (settings = settings || await loadSettings());
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  settings = await loadSettings();
  updateBadge();
  if ("enabled" in changes) await syncEngine();
  else pushSettings();
});

/* ---------------- offscreen engine lifecycle ---------------- */
let optionsLive = 0;   // while the settings page has the camera (preview / calibration), the engine steps aside
async function hasOffscreen() { return (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length > 0; }
async function syncEngine() {
  const s = await getSettings(), want = s.enabled && optionsLive === 0, have = await hasOffscreen();
  if (want && !have) {
    try { await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA"], justification: "Camera and microphone gesture recognition, processed on this device." }); }
    catch (e) { if (!/single offscreen/i.test(e.message)) throw e; }
  } else if (!want && have) {
    await chrome.offscreen.closeDocument();
    await chrome.storage.session.set({ status: { camera: "off", mic: "off" } });
  }
}
async function pushSettings() { if (await hasOffscreen()) chrome.runtime.sendMessage({ to: "offscreen", type: "settings", settings: await getSettings() }).catch(() => {}); }
chrome.runtime.onStartup.addListener(() => { syncEngine(); updateBadge(); });
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") { await chrome.storage.local.set(DEFAULT_SETTINGS); chrome.runtime.openOptionsPage(); }
  settings = null; updateBadge(); syncEngine();
});
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "options-live") return;
  optionsLive++; syncEngine();
  port.onDisconnect.addListener(() => { optionsLive = Math.max(0, optionsLive - 1); syncEngine(); });
});

async function updateBadge() {
  const s = await getSettings();
  const [text, color] = !s.enabled ? ["", "#888"] : s.watching ? ["ON", "#2f8a5b"] : ["II", "#b45a1c"];
  chrome.action.setBadgeText({ text }); chrome.action.setBadgeBackgroundColor({ color });
}

/* ---------------- messages ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.from === "offscreen") {
    if (msg.type === "ready") pushSettings();
    else if (msg.type === "gesture") onGesture(msg.name);
    else if (msg.type === "gazeZone") onGazeZone(msg.dir);
    else if (msg.type === "status") chrome.storage.session.set({ status: msg.status });
    return;
  }
  if (msg.type === "runAction") { runAction(msg.action, msg.label || ACTION[msg.action], { force: true }).then(reply); return true; }
  if (msg.type === "simulateGesture") { onGesture(msg.name, { force: msg.force }).then(reply); return true; }
});
chrome.commands.onCommand.addListener(cmd => { if (cmd === "toggle-watching") runAction("toggleWatching", ACTION.toggleWatching, { force: true }); });

/* ---------------- gestures → actions ---------------- */
let lastActionAt = 0;
const log = async ev => chrome.storage.session.set({ last: { ...ev, t: Date.now() } });
async function onGesture(name, { force = false } = {}) {
  const s = await getSettings(), action = (s.map || {})[name] || "none", g = GESTURE[name] || { icon: "", label: name };
  const label = `${g.icon} ${ACTION[action] || action}`;
  if (action === "none") { await log({ name, action, result: "not mapped" }); return "not mapped"; }
  if (!s.watching && action !== "toggleWatching") { await log({ name, action, result: "paused" }); return "paused"; }
  if (Date.now() - lastActionAt < 350) return "cooldown";   // a gesture right after an action is far more likely a leftover
  const r = await runAction(action, label, { force });
  await log({ name, action, result: r });
  return r;
}

async function frontTab(force) {
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  if (!win || (!win.focused && !force)) return null;      // Chrome isn't the app in front: don't touch it
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return tab || null;
}

async function runAction(action, label, { force = false } = {}) {
  const s = await getSettings();
  if (action === "toggleWatching") {
    await chrome.storage.local.set({ watching: !s.watching });
    const tab = await frontTab(true); if (tab) page(tab, "toast", null, !s.watching ? "▶ Gestures on" : "⏸ Gestures paused", true);
    return !s.watching ? "resumed" : "paused";
  }
  const tab = await frontTab(force);
  if (!tab) return "Chrome not in front";
  lastActionAt = Date.now();
  const toast = s.toast;
  try {
    switch (action) {
      case "scrollDown": return page(tab, "scroll", 1, label, toast, s.scrollAmount);
      case "scrollUp": return page(tab, "scroll", -1, label, toast, s.scrollAmount);
      case "pageTop": return page(tab, "edge", -1, label, toast);
      case "pageBottom": return page(tab, "edge", 1, label, toast);
      case "nextTab": case "prevTab": {
        const tabs = await chrome.tabs.query({ windowId: tab.windowId });
        const i = tabs.findIndex(t => t.id === tab.id), next = tabs[(i + (action === "nextTab" ? 1 : -1) + tabs.length) % tabs.length];
        await chrome.tabs.update(next.id, { active: true }); page(next, "toast", null, label, toast); return "ok";
      }
      case "back": await chrome.tabs.goBack(tab.id).catch(() => {}); return "ok";
      case "forward": await chrome.tabs.goForward(tab.id).catch(() => {}); return "ok";
      case "reload": await chrome.tabs.reload(tab.id); return "ok";
      case "zoomIn": case "zoomOut": case "zoomReset": {
        const z = await chrome.tabs.getZoom(tab.id), steps = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
        const i = steps.findIndex(v => v >= z - 0.01), nz = action === "zoomReset" ? 1 : steps[Math.max(0, Math.min(steps.length - 1, i + (action === "zoomIn" ? 1 : -1)))];
        await chrome.tabs.setZoom(tab.id, nz); page(tab, "toast", null, `${label} (${Math.round(nz * 100)}%)`, toast); return "ok";
      }
      case "mediaToggle": return page(tab, "media", "toggle", label, toast);
      case "mediaForward": return page(tab, "media", 10, label, toast);
      case "mediaBack": return page(tab, "media", -10, label, toast);
      case "mediaMute": return page(tab, "media", "mute", label, toast);
    }
    if (action.startsWith("key:")) return page(tab, "key", action.slice(4), label, toast);
    if (action.startsWith("anki:")) { const r = await anki(action.slice(5)); page(tab, "toast", null, r.ok ? `${label}` : `⚠ ${r.msg}`, toast || !r.ok); return r.ok ? "ok" : r.msg; }
    return "unknown action";
  } catch (e) { return "error: " + e.message; }
}

// Page side, injected on demand into the active tab (chrome://, the Web Store and PDF viewer can't be scripted).
async function page(tab, kind, arg, label, toast, extra) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageAction, args: [kind, arg, label, !!toast, extra ?? null] });
    return res && res.result;
  } catch { return "can't act on this page"; }
}

/* ---------------- gaze scrolling ---------------- */
let gazeTab = null;
async function onGazeZone(dir) {
  const s = await getSettings();
  if (gazeTab && (!dir || !s.watching)) { await page({ id: gazeTab }, "gazeScroll", null, null, false); gazeTab = null; }
  if (!dir || !s.watching) return;
  const tab = await frontTab(false); if (!tab) return;
  gazeTab = tab.id;
  page(tab, "gazeScroll", dir === "down" ? 1 : -1, null, s.toast, s.gaze.speed);
}
chrome.tabs.onActivated.addListener(async () => { if (gazeTab) { await page({ id: gazeTab }, "gazeScroll", null, null, false); gazeTab = null; } });

/* ---------------- Anki desktop via AnkiConnect ---------------- */
let ankiState = { answerShown: false, cardId: null };
async function ac(action, params = {}) {
  let r; try { r = await fetch("http://127.0.0.1:8765", { method: "POST", body: JSON.stringify({ action, version: 6, params }) }); }
  catch { throw new Error("Can't reach Anki: open Anki desktop with AnkiConnect"); }
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}
async function anki(cmd) {
  try {
    if (cmd === "undo") { await ac("guiUndo"); ankiState = { answerShown: false, cardId: null }; return { ok: true }; }
    const card = await ac("guiCurrentCard");
    if (!card) return { ok: false, msg: "No card on screen in Anki: start a review" };
    if (card.cardId !== ankiState.cardId) ankiState = { answerShown: false, cardId: card.cardId };
    if (cmd === "next" && !ankiState.answerShown) { await ac("guiShowAnswer"); ankiState.answerShown = true; return { ok: true }; }
    const ease = cmd === "next" ? 3 : +cmd;
    await ac("guiShowAnswer");
    if (!(await ac("guiAnswerCard", { ease }))) return { ok: false, msg: "Anki didn't accept the rating" };
    ankiState.answerShown = false; return { ok: true };
  } catch (e) { return { ok: false, msg: e.message }; }
}

/* ---------------- runs inside the page ---------------- */
function pageAction(kind, arg, label, toast, extra) {
  const showToast = text => {
    let host = document.getElementById("__gesture_control_toast");
    if (!host) {
      host = document.createElement("div"); host.id = "__gesture_control_toast";
      host.style.cssText = "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;";
      host.attachShadow({ mode: "open" }).innerHTML = `<style>div{font:600 15px system-ui,sans-serif;color:#fff;background:rgba(25,28,35,.9);padding:8px 16px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.25);transition:opacity .25s;opacity:0}</style><div></div>`;
      document.documentElement.appendChild(host);
    }
    const el = host.shadowRoot.querySelector("div"); el.textContent = text; el.style.opacity = 1;
    clearTimeout(host._t); host._t = setTimeout(() => (el.style.opacity = 0), 1200);
  };
  // The element that really scrolls: the page, or (web apps like Gmail) the biggest scrollable box.
  const scroller = () => {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > innerHeight + 5) return doc;
    let best = doc, area = 0, n = 0;
    for (const e of document.querySelectorAll("body *")) {
      if (++n > 4000) break;
      if (e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) { const a = e.clientWidth * e.clientHeight; if (a > area) { area = a; best = e; } }
    }
    return best;
  };
  const media = () => {
    const all = [...document.querySelectorAll("video, audio")];
    return all.find(m => !m.paused) || all.filter(m => m.tagName === "VIDEO").sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] || all[0];
  };
  let result = "ok";
  if (kind === "scroll") scroller().scrollBy({ top: arg * innerHeight * (extra || 0.8), behavior: "smooth" });
  else if (kind === "edge") { const el = scroller(); el.scrollTo({ top: arg < 0 ? 0 : el.scrollHeight, behavior: "smooth" }); }
  else if (kind === "media") {
    const m = media();
    if (!m) { result = "no video on this page"; label = "⚠ No video on this page"; }
    else if (arg === "toggle") { if (m.paused) m.play(); else m.pause(); }
    else if (arg === "mute") m.muted = !m.muted;
    else m.currentTime = Math.max(0, m.currentTime + arg);
  } else if (kind === "key") {
    // Synthetic key events: apps that listen for keys (slides, AnkiWeb, games) react; the browser's own built-in
    // key behaviour (e.g. Space scrolling) doesn't run, because pages can't fake trusted keystrokes.
    const codes = { " ": ["Space", 32], ArrowRight: ["ArrowRight", 39], ArrowLeft: ["ArrowLeft", 37], ArrowDown: ["ArrowDown", 40], ArrowUp: ["ArrowUp", 38], Enter: ["Enter", 13], Escape: ["Escape", 27] };
    const [code, keyCode] = codes[arg] || ["Digit" + arg, 48 + +arg];
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
    for (const type of ["keydown", "keyup"]) target.dispatchEvent(new KeyboardEvent(type, { key: arg, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true }));
  } else if (kind === "gazeScroll") {
    if (window.__gcGaze) { cancelAnimationFrame(window.__gcGaze.raf); window.__gcGaze = null; }
    if (arg) {
      const el = scroller(), g = window.__gcGaze = { raf: 0, last: performance.now() };
      const step = now => { if (window.__gcGaze !== g) return; el.scrollBy(0, arg * (extra || 500) * Math.min(0.05, (now - g.last) / 1000)); g.last = now; g.raf = requestAnimationFrame(step); };
      g.raf = requestAnimationFrame(step);
      if (toast) showToast(arg > 0 ? "👀 scrolling down" : "👀 scrolling up");
    }
  }
  if (toast && label) showToast(label);
  return result;
}
