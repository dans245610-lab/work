// Little Hands: app shell, lessons, quiz, camera lifecycle.
import { SIGNS, GROUPS, shapeOf, shapePic, diagram } from "./recognizer.js";
import { SIGN_INFO } from "./sign-info.js";
import { startCamera, stopCamera, loadModels, fitCanvas, track } from "./vision.js";

const $ = id => document.getElementById(id);
const DEBUG = location.hash.includes("debug");
const video = $("video"), canvas = $("fx"), ctx = canvas.getContext("2d");
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ================================================================ local storage (this browser only)
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc.: progress just isn't kept */ } },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};
let progress = store.get("lh.progress", {}) || {};
const settings = Object.assign({ sound: true, confetti: !reducedMotion }, store.get("lh.settings", {}));
const saveProgress = () => store.set("lh.progress", progress);

// ================================================================ home
function renderHome() {
  const learned = SIGNS.filter(s => progress[s.id]).length;
  $("progTxt").textContent = `${learned} / ${SIGNS.length} practised`;
  $("progFill").style.width = `${(learned / SIGNS.length) * 100}%`;
  $("progBar").setAttribute("aria-valuenow", String(learned));
  $("startAll").textContent = learned ? "Keep practising" : "Start practising";
  const groups = $("groups");
  groups.textContent = "";
  for (const g of GROUPS) {
    const sec = document.createElement("section");
    const h = document.createElement("h2"); h.textContent = g; sec.appendChild(h);
    const grid = document.createElement("div"); grid.className = "grid";
    for (const s of SIGNS.filter(x => x.group === g)) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "sign";
      b.setAttribute("aria-label", `${s.word}${progress[s.id] ? ", practised" : ""}`);
      b.innerHTML = `${progress[s.id] ? '<span class="done" aria-hidden="true">✓</span>' : ""}<div class="e" aria-hidden="true">${s.emoji}</div><div class="w"></div>${diagram(s)}`;
      b.querySelector(".w").textContent = s.word;
      b.onclick = () => openLesson(SIGNS.indexOf(s));
      grid.appendChild(b);
    }
    sec.appendChild(grid);
    groups.appendChild(sec);
  }
}

// ================================================================ camera + models
let models = null, modelsLoading = null, camOn = false, camStarting = null;
function showStatus(text, actions = []) {
  $("status").hidden = !text;
  $("statusTxt").textContent = text || "";
  const box = $("statusActions"); box.textContent = "";
  for (const [label, fn, primary] of actions) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = label; if (primary) b.className = "primary"; b.onclick = fn; box.appendChild(b);
  }
}
async function ensureCamera() {
  if (camOn) return;
  if (camStarting) return camStarting;
  camStarting = (async () => {
    showStatus("Starting your camera… Your browser may ask for permission.");
    await startCamera(video);
    if (!models) {
      showStatus("Loading hand and body tracking (first time only, then it works offline)…");
      modelsLoading = modelsLoading || loadModels();
      models = await modelsLoading;
    }
    camOn = true;
    $("camchip").hidden = false;
    showStatus(null);
  })().catch(e => {
    stopCamera(video);
    modelsLoading = null;
    showStatus(e.message || "Something went wrong starting the camera.", [["Try again", () => ensureCamera(), true], ["Back to all signs", goHome]]);
  }).finally(() => { camStarting = null; });
  return camStarting;
}
function turnCameraOff() {
  stopCamera(video);
  camOn = false;
  $("camchip").hidden = true;
}
$("stopCam").onclick = () => {
  turnCameraOff();
  showStatus("Camera is off.", [["Turn camera on", () => ensureCamera(), true], ["Back to all signs", goHome]]);
};
// Don't keep the camera running in a hidden tab.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && camOn) { turnCameraOff(); resumeOnShow = true; }
  else if (!document.hidden && resumeOnShow && document.body.classList.contains("live")) { resumeOnShow = false; ensureCamera(); }
});
let resumeOnShow = false;

// ================================================================ lessons + quiz
let idx = 0, quiz = null, hintShown = false, trace = [], body = null, bodyAt = 0, lastHands = [], comps = null, drawInfo = null, cooldown = 0, confetti = [];
let lastOk = {};

function openLesson(i, q = null) {
  idx = i; quiz = q; hintShown = false;
  document.body.classList.add("live");
  showSign();
  $("homeBtn").focus();
  if (!window.__noCam) ensureCamera();
}
function goHome() {
  document.body.classList.remove("live");
  quiz = null;
  turnCameraOff();
  showStatus(null);
  renderHome();
}
function showSign() {
  const s = SIGNS[idx], info = SIGN_INFO[s.id];
  trace = []; cooldown = 0; comps = null; lastOk = {};
  $("grp").textContent = quiz ? "Quiz" : s.group;
  $("emoji").textContent = s.emoji; $("word").textContent = s.word;
  $("gloss").textContent = `ASL: ${info.gloss}`;
  $("visual").innerHTML = diagram(s) + s.shapes.map(k => shapePic(k, 78)).join("");
  const how = $("how"); how.textContent = "";
  for (const t of s.how) { const li = document.createElement("li"); li.textContent = t; how.appendChild(li); }
  const vids = $("videos"); vids.textContent = "";
  for (const [href, name, note] of [[info.lifeprint, "ASL University (Lifeprint)", "video by a Deaf ASL teacher"], [info.savvy, "Signing Savvy", "ASL dictionary videos"]]) {
    const a = document.createElement("a");
    a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.innerHTML = `<span></span><small></small>`;
    a.querySelector("span").textContent = `▶ ${name}`;
    a.querySelector("small").textContent = `${note} ↗`;
    a.setAttribute("aria-label", `${name}: watch ${s.word} signed (opens in a new tab)`);
    vids.appendChild(a);
  }
  $("tip").textContent = s.tip;
  const hide = quiz && !hintShown;
  $("visual").hidden = hide; $("howWrap").hidden = hide; $("videoWrap").hidden = hide; $("gloss").hidden = hide;
  $("tipWrap").hidden = !!quiz;
  $("hintBtn").hidden = !hide; $("prevBtn").hidden = !!quiz;
  $("nextBtn").textContent = quiz ? "Skip →" : "Next →";
  $("quizbar").hidden = !quiz;
  if (quiz) { $("quizPos").textContent = `Sign ${quiz.i + 1} of ${quiz.list.length}`; $("quizScore").textContent = `⭐ ${quiz.score}`; }
  renderChecks();
}
function renderChecks() {
  const rows = [["shape", "Hand shape"], ["place", "Place"], ["move", "Movement"]];
  const box = $("checks");
  if (box.children.length !== 3) {
    box.textContent = "";
    for (const [, label] of rows) {
      const d = document.createElement("div"); d.className = "check";
      d.innerHTML = `<div class="dot" aria-hidden="true"></div><div class="k"></div><div class="h"></div>`;
      d.querySelector(".k").textContent = label; box.appendChild(d);
    }
  }
  rows.forEach(([k, label], i) => {
    const c = comps && comps[k], el = box.children[i], ok = !!(c && c.ok);
    el.classList.toggle("ok", ok);
    el.querySelector(".dot").textContent = ok ? "✓" : "";
    el.querySelector(".h").textContent = c ? c.hint : "Waiting for the camera…";
    if (comps && ok && !lastOk[k]) announce(`${label}: good`);
    lastOk[k] = ok;
  });
}
let announceTimer = 0;
function announce(text) { clearTimeout(announceTimer); announceTimer = setTimeout(() => { $("announce").textContent = text; }, 150); }
function coach(text) { if ($("coachTxt").textContent !== text) $("coachTxt").textContent = text; }

$("homeBtn").onclick = goHome;
$("prevBtn").onclick = () => { idx = (idx - 1 + SIGNS.length) % SIGNS.length; showSign(); };
$("nextBtn").onclick = () => nextSign(false);
$("hintBtn").onclick = () => { hintShown = true; showSign(); };
$("startAll").onclick = () => openLesson(Math.max(0, SIGNS.findIndex(s => !progress[s.id])));
$("quizBtn").onclick = () => {
  const done = SIGNS.filter(s => progress[s.id]);
  const pool = done.length >= 5 ? done : SIGNS;
  const list = [...pool].sort(() => Math.random() - 0.5).slice(0, 10).map(s => SIGNS.indexOf(s));
  openLesson(list[0], { list, i: 0, score: 0 });
};
document.addEventListener("keydown", e => { if (e.key === "Escape" && document.body.classList.contains("live") && !document.querySelector("dialog[open]")) goHome(); });

function nextSign(passed) {
  if (quiz) {
    if (passed) quiz.score++;
    quiz.i++;
    if (quiz.i >= quiz.list.length) {
      celebrate(`Quiz done: ${quiz.score} / ${quiz.list.length} ⭐`, "Back to all signs in a moment");
      announce(`Quiz finished. ${quiz.score} out of ${quiz.list.length}.`);
      setTimeout(goHome, 2600);
      return;
    }
    hintShown = false; idx = quiz.list[quiz.i];
  } else idx = (idx + 1) % SIGNS.length;
  showSign();
}

// ================================================================ success
let AC = null;
function chime() {
  if (!settings.sound) return;
  try {
    AC = AC || new AudioContext();
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const o = AC.createOscillator(), g = AC.createGain(), t = AC.currentTime + i * 0.09;
      o.type = "triangle"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
      o.connect(g); g.connect(AC.destination); o.start(t); o.stop(t + 0.65);
    });
  } catch { /* audio unavailable */ }
}
function celebrate(big, small) {
  const box = $("celebTxt"); box.textContent = big;
  const sm = document.createElement("small"); sm.textContent = small; box.appendChild(sm);
  $("celebrate").classList.remove("show"); void $("celebrate").offsetWidth; $("celebrate").classList.add("show");
  clearTimeout(celebrate.t); celebrate.t = setTimeout(() => $("celebrate").classList.remove("show"), 2200);
  if (!settings.confetti) return;
  const W = canvas.width, H = canvas.height;
  for (let i = 0; i < 140; i++) confetti.push({ x: W * (0.2 + Math.random() * 0.4), y: H * 0.45, vx: (Math.random() - 0.5) * W * 0.9, vy: -H * (0.4 + Math.random() * 0.7), r: Math.random() * 6, vr: (Math.random() - 0.5) * 12, s: 6 + Math.random() * 8, c: `hsl(${Math.random() * 360},80%,65%)`, t: 0 });
}
function onSuccess() {
  const s = SIGNS[idx];
  const p = progress[s.id] || { times: 0 };
  p.times++; p.last = Date.now(); progress[s.id] = p; saveProgress();
  chime();
  celebrate(`${s.emoji} ${s.word}!`, quiz ? "Nice one" : p.times === 1 ? "First time: well done" : `Signed ${p.times} times`);
  announce(`Well done, that was ${s.word}.`);
  cooldown = performance.now() / 1000 + 2.2;
  trace = [];
  if (quiz) setTimeout(() => nextSign(true), 1800);
}

// ================================================================ main loop
const noHand = { ok: false, hint: "Hold your hand up where the camera can see it" };
let fake = null;
function frame(ms) {
  const live = document.body.classList.contains("live");
  if (live) fitCanvas(canvas);
  const now = performance.now() / 1000;
  let res = null;
  if (fake) { res = fake; fake = null; }
  else if (live && camOn && models) { try { res = track(models, video, canvas, ms); } catch (e) { console.warn("tracking failed", e); } }
  if (res && live) {
    if (res.body) { body = res.body; bodyAt = now; } else if (now - bodyAt > 0.6) body = null;
    const hands = res.hands;
    for (const h of hands) h.sh = shapeOf(h);
    lastHands = hands;
    const s = SIGNS[idx];
    if (!hands.length) {
      comps = { shape: noHand, place: noHand, move: { ok: false, hint: "—" } }; drawInfo = null;
      coach("Hold your hand up so the camera can see it");
    } else {
      const f = s.frame(hands, body);
      trace.push({ t: now, ...f.rec });
      while (trace.length && now - trace[0].t > 3.5) trace.shift();
      const move = now < cooldown ? { ok: true, hint: "Lovely!" } : s.motion(trace);
      comps = { shape: f.shape, place: f.place, move };
      drawInfo = f.draw || null;
      const first = ["shape", "place", "move"].find(k => !comps[k].ok);
      coach(now < cooldown ? `🎉 ${s.word}!` : first ? comps[first].hint : "Perfect!");
      if (now >= cooldown && move.ok && comps.shape.ok !== false) onSuccess();
    }
    renderChecks();
  }
  if (live) draw();
  requestAnimationFrame(frame);
}

const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
function draw() {
  const W = canvas.width, H = canvas.height, dpr = Math.min(devicePixelRatio || 1, 2), now = performance.now() / 1000;
  ctx.clearRect(0, 0, W, H);
  for (const h of lastHands) {
    ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 3 * dpr; ctx.lineCap = "round";
    ctx.beginPath(); for (const [a, b] of BONES) { ctx.moveTo(h.pts[a].x, h.pts[a].y); ctx.lineTo(h.pts[b].x, h.pts[b].y); } ctx.stroke();
    ctx.fillStyle = "#e07a5f"; for (const i of [4, 8, 12, 16, 20]) { ctx.beginPath(); ctx.arc(h.pts[i].x, h.pts[i].y, 4 * dpr, 0, 7); ctx.fill(); }
  }
  if (drawInfo && drawInfo.to) {
    const { from, to, r, ok } = drawInfo, pulse = reducedMotion ? 1 : 1 + 0.08 * Math.sin(now * 5);
    ctx.strokeStyle = ok ? "rgba(79,157,118,0.95)" : "rgba(255,252,247,0.95)"; ctx.lineWidth = 4 * dpr;
    ctx.setLineDash(ok ? [] : [10 * dpr, 8 * dpr]);
    ctx.beginPath(); ctx.arc(to.x, to.y, r * pulse, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    if (!ok && from) {
      ctx.strokeStyle = "rgba(224,122,95,0.9)"; ctx.lineWidth = 3 * dpr; ctx.setLineDash([6 * dpr, 6 * dpr]);
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  const dt = 1 / 60;
  confetti = confetti.filter(c => (c.t += dt) < 2.4);
  for (const c of confetti) {
    c.vy += H * 1.6 * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.vx *= 0.985; c.r += c.vr * dt;
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.r); ctx.globalAlpha = Math.min(1, (2.4 - c.t) * 2);
    ctx.fillStyle = c.c; ctx.fillRect(-c.s / 2, -c.s / 4, c.s, c.s / 2); ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// ================================================================ dialogs
function openDialog(d) { if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", ""); }
function closeDialog(d) { if (typeof d.close === "function") d.close(); else d.removeAttribute("open"); }
$("welcomeOk").onclick = () => { store.set("lh.welcomed", true); closeDialog($("welcome")); };
$("settingsBtn").onclick = () => { $("setSound").checked = settings.sound; $("setConfetti").checked = settings.confetti; openDialog($("settings")); };
$("setSound").onchange = e => { settings.sound = e.target.checked; store.set("lh.settings", settings); };
$("setConfetti").onchange = e => { settings.confetti = e.target.checked; store.set("lh.settings", settings); };
$("clearProgress").onclick = () => {
  if (!confirm("Clear your practice progress on this device?")) return;
  progress = {}; store.remove("lh.progress"); renderHome();
};
$("settingsDone").onclick = () => closeDialog($("settings"));

// ================================================================ start
renderHome();
if (!store.get("lh.welcomed", false) && !DEBUG) openDialog($("welcome"));
requestAnimationFrame(frame);

// Offline support: cache the app (including the models) after the first visit.
if ("serviceWorker" in navigator && !DEBUG && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* offline mode just isn't available */ });
}

if (DEBUG) {
  window.__test = { SIGNS, shapeOf, get comps() { return comps; }, get idx() { return idx; }, get progress() { return progress; }, get camOn() { return camOn; } };
  window.__feed = (hands, b) => { fake = { hands, body: b }; };
  window.__open = id => openLesson(SIGNS.findIndex(s => s.id === id));
  window.__home = goHome;
}
