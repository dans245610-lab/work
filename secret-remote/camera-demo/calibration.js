// Calibration for every gesture: watch the user do each one, then set that gesture's thresholds from what was seen.
//
//   planSteps(gestureIds)              → the steps needed for those gestures (in a sensible order)
//   runCalibration(steps, sources, ui, extraTargets) → Promise<calibration>
//       sources = { camera, audio }: each has subscribe(frame => …) returning an unsubscribe fn; a step's `source`
//       picks one (default camera). extraTargets = { audio: AudioRemote.CFG } receives results under those keys.
//   applyCalibration(cal)              → reset to defaults, then apply a saved calibration
//
// A frame is what GestureCam.onRaw gives: { t, aspect, face: { brow, blinkL, …, yaw, pitch, roll } | null, hands: [{ lm, pose, pos }] }.
// Each step's analyse() is a pure function of the recorded frames, so it can be tested without a camera.
import { FaceRemote } from "./face-remote.js?v=8";
import { POSE_CFG, SWIPE_CFG, classifyHand, handFeatures } from "./hand-poses.js?v=8";

const DEFAULTS = { face: { ...FaceRemote.CFG }, hand: JSON.parse(JSON.stringify(POSE_CFG)), swipe: { ...SWIPE_CFG } };
export function applyCalibration(cal) {
  Object.assign(FaceRemote.CFG, DEFAULTS.face); Object.assign(POSE_CFG, JSON.parse(JSON.stringify(DEFAULTS.hand))); Object.assign(SWIPE_CFG, DEFAULTS.swipe);
  if (!cal) return;
  Object.assign(FaceRemote.CFG, cal.face || {}); Object.assign(POSE_CFG, cal.hand || {}); Object.assign(SWIPE_CFG, cal.swipe || {});
}

/* ---------- small maths ---------- */
const r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
const median = xs => quantile(xs, 0.5);
const range = xs => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
// Maxima of the stretches where x rises more than `gate` above base (each at least 2 frames long).
function peaks(xs, base, gate) {
  const out = []; let best = -1, len = 0;
  xs.forEach((x, i) => {
    if (x > base + gate) { len++; if (best < 0 || x > xs[best]) best = i; }
    else { if (len >= 2) out.push(best); best = -1; len = 0; }
  });
  if (len >= 2) out.push(best);
  return out;   // indices
}
function swings(xs, hyst) {
  if (xs.length < 2) return [];
  const tps = [xs[0]]; let dir = 0, ext = xs[0];
  for (const x of xs) {
    if (dir === 0) { if (Math.abs(x - tps[0]) >= hyst) { dir = Math.sign(x - tps[0]); ext = x; } }
    else if ((x - ext) * dir > 0) ext = x;
    else if (Math.abs(x - ext) >= hyst) { tps.push(ext); dir = -dir; ext = x; }
  }
  if (dir !== 0) tps.push(ext);
  return tps.slice(1).map((v, i) => Math.abs(v - tps[i]));
}
const fail = msg => ({ ok: false, msg });
const faceFrames = frames => frames.filter(f => f.face);
const firstHand = f => f.hands && f.hands[0];
function needFace(frames) { const ff = faceFrames(frames); return ff.length < Math.max(5, frames.length * 0.5) ? null : ff; }
function needHand(frames) { const hf = frames.filter(firstHand); return hf.length < Math.max(5, frames.length * 0.4) ? null : hf; }
const NO_FACE = "Couldn't see your face clearly. Face the camera with light on your face.";
const NO_HAND = "Couldn't see your hand. Hold it up in front of the camera, about a forearm away.";

/* ---------- step builders ---------- */
const FACE_KEYS = ["brow", "blinkL", "blinkR", "jaw", "frown", "smile", "pucker", "mouthL", "mouthR"];

const neutral = {
  id: "neutral", icon: "😐", title: "Relaxed face", say: "Look at the screen with a relaxed face. Keep still.", ms: 3000,
  meter: f => (f.face ? 0.5 : 0),
  analyse(frames, ctx) {
    const ff = needFace(frames); if (!ff) return fail(NO_FACE);
    ctx.base = {}; for (const k of FACE_KEYS) ctx.base[k] = quantile(ff.map(f => f.face[k]), 0.95);
    ctx.base.blinkMin = quantile(ff.map(f => Math.min(f.face.blinkL, f.face.blinkR)), 0.95);
    ctx.roll0 = median(ff.map(f => f.face.roll ?? 0));
    return { ok: true, msg: `Baseline recorded (${ff.length} frames).` };
  },
};

// A held expression: threshold halfway between your relaxed face and the weaker of your two attempts.
function expression(id, icon, title, say, key, cfgKey) {
  return {
    id, icon, title, say, ms: 5000, meter: f => (f.face ? f.face[key] : 0),
    analyse(frames, ctx) {
      const ff = needFace(frames); if (!ff) return fail(NO_FACE);
      const xs = ff.map(f => f.face[key]), base = ctx.base ? ctx.base[key] : quantile(xs, 0.2);
      const idx = peaks(xs, base, 0.08);
      if (!idx.length) return fail(`Didn't see it. Try a bigger ${title.toLowerCase()}, or skip this one.`);
      const top = idx.map(i => xs[i]).sort((a, b) => b - a).slice(0, 2), use = Math.min(...top);
      if (use - base < 0.12) return fail(`It barely registered (${r2(base)} → ${r2(use)}). Exaggerate it, or skip.`);
      const thr = r3(base + 0.5 * (use - base));
      return { ok: true, msg: `Trigger at ${r2(thr)} (relaxed ${r2(base)}, yours ${r2(use)}).`, face: { [cfgKey]: thr } };
    },
  };
}

const blink = {
  id: "blink", icon: "😑", title: "Eyes closed", say: "Close both eyes firmly for a moment, then open. Do it twice.", ms: 5000,
  meter: f => (f.face ? Math.min(f.face.blinkL, f.face.blinkR) : 0),
  analyse(frames, ctx) {
    const ff = needFace(frames); if (!ff) return fail(NO_FACE);
    const xs = ff.map(f => Math.min(f.face.blinkL, f.face.blinkR)), base = ctx.base ? ctx.base.blinkMin : quantile(xs, 0.2);
    const idx = peaks(xs, base, 0.1); if (!idx.length) return fail("Didn't see your eyes close.");
    const use = Math.min(...idx.map(i => xs[i]).sort((a, b) => b - a).slice(0, 2));
    if (use - base < 0.2) return fail(`Your eyes barely registered as closed (${r2(base)} → ${r2(use)}).`);
    const thr = r3(base + 0.5 * (use - base));
    return { ok: true, msg: `Eyes count as closed above ${r2(thr)} (open ${r2(base)}, closed ${r2(use)}).`, face: { blinkThreshold: thr } };
  },
};

function wink(side) {
  const L = side === "Left", key = L ? "blinkL" : "blinkR", other = L ? "blinkR" : "blinkL";
  return {
    id: "wink" + side, icon: "😉", title: `Wink ${side.toLowerCase()} eye`, say: `Wink your ${side.toLowerCase()} eye (keep the other open). Twice.`, ms: 5000,
    meter: f => (f.face ? f.face[key] : 0),
    analyse(frames, ctx) {
      const ff = needFace(frames); if (!ff) return fail(NO_FACE);
      const xs = ff.map(f => f.face[key]), base = ctx.base ? ctx.base[key] : quantile(xs, 0.2);
      const idx = peaks(xs, base, 0.1).sort((a, b) => xs[b] - xs[a]).slice(0, 2);
      if (!idx.length) return fail(`Didn't see your ${side.toLowerCase()} eye close.`);
      const use = Math.min(...idx.map(i => xs[i])), otherAt = Math.max(...idx.map(i => ff[i].face[other]));
      const sep = use - otherAt;
      if (sep < 0.25) return fail(`Both eyes closed together (${r2(use)} vs ${r2(otherAt)}). Many people can't wink cleanly; skip this one if so.`);
      const closed = r3(base + 0.5 * (use - base)), diff = r3(clamp(0.6 * sep, 0.15, 0.6));
      return { ok: true, msg: `Wink = this eye above ${r2(closed)} and ${r2(diff)} more closed than the other.`, face: { ["winkClosed" + side]: closed, ["winkDiff" + side]: diff } };
    },
  };
}

function headSwing(id, icon, title, say, axis, minSwings, cfgKey, lo, hi) {
  return {
    id, icon, title, say, ms: 5000, meter: f => (f.face ? Math.min(1, Math.abs((f.face[axis] ?? 0)) / 30) : 0),
    analyse(frames) {
      const ff = needFace(frames); if (!ff) return fail(NO_FACE);
      const sw = swings(ff.map(f => f.face[axis] ?? 0), 3).filter(s => s >= 3);
      if (sw.length < minSwings) return fail(`Saw ${sw.length} movement${sw.length === 1 ? "" : "s"}; need ${minSwings}. Make it a bit bigger.`);
      const deg = Math.round(clamp(0.55 * median(sw), lo, hi));
      const out = { [cfgKey]: deg }; if (id === "nod") out.nodMaxDeg = Math.round(clamp(1.6 * Math.max(...sw), 30, 60));
      return { ok: true, msg: `Your ${title.toLowerCase()} moves about ${Math.round(median(sw))}°. Trigger at ${deg}°.`, face: out };
    },
  };
}

const tilt = {
  id: "tilt", icon: "↔️", title: "Head tilt", say: "Tilt your head towards your left shoulder, hold a second, back to centre, then to your right.", ms: 7000,
  meter: (f, ctx) => (f.face ? Math.min(1, Math.abs((f.face.roll ?? 0) - (ctx.roll0 ?? 0)) / 30) : 0),
  analyse(frames, ctx) {
    const ff = needFace(frames); if (!ff) return fail(NO_FACE);
    const r0 = ctx.roll0 ?? median(ff.slice(0, 8).map(f => f.face.roll ?? 0));
    const d = ff.map(f => (f.face.roll ?? 0) - r0), left = Math.max(0, ...d.map(x => -x)), right = Math.max(0, ...d);
    if (left < 8 || right < 8) return fail(`Tilts were ${Math.round(left)}° left and ${Math.round(right)}° right. Each needs at least 8°.`);
    const deg = Math.round(clamp(0.6 * Math.min(left, right), 8, 30));
    return { ok: true, msg: `You tilt ${Math.round(left)}° left / ${Math.round(right)}° right. Trigger at ${deg}°.`, face: { tiltDeg: deg } };
  },
};

/* hands */
const feats = hf => hf.map(f => handFeatures(f.hands[0].lm, f.aspect)).filter(Boolean);
const medRatios = fs => [0, 1, 2, 3].map(i => median(fs.map(f => f.ratios[i])));
const share = (frames, pose) => { const hf = frames.filter(firstHand); return hf.length ? hf.filter(f => classifyHand(f.hands[0].lm, f.aspect) === pose).length / hf.length : 0; };
const pct = x => `${Math.round(x * 100)}%`;
const handMeter = pose => f => (firstHand(f) ? (f.hands[0].pose === pose ? 1 : 0.35) : 0);
const FINGER = ["index", "middle", "ring", "pinky"];

const handOpen = {
  id: "handOpen", icon: "🖐", title: "Open hand", say: "Hold up an open hand, palm to the camera, all five fingers spread. Keep it there.", ms: 2500, meter: handMeter("palm"),
  analyse(frames, ctx) {
    const hf = needHand(frames); if (!hf) return fail(NO_HAND);
    const fs = feats(hf), ratios = medRatios(fs);
    if (Math.min(...ratios) < 1.08) return fail(`Your ${FINGER[ratios.indexOf(Math.min(...ratios))]} finger didn't look straight. Spread your fingers and face the palm to the camera.`);
    ctx.open = { ratios, thumb: median(fs.map(f => f.thumbOut)), frames: hf };
    return { ok: true, msg: "Recorded your open hand." };
  },
};
const handFist = {
  id: "handFist", icon: "✊", title: "Fist", say: "Now make a fist, knuckles to the camera.", ms: 2500, meter: handMeter("fist"),
  analyse(frames, ctx) {
    const hf = needHand(frames); if (!hf) return fail(NO_HAND);
    const fs = feats(hf), ratios = medRatios(fs);
    ctx.fist = { ratios, frames: hf };
    if (!ctx.open) return { ok: true, msg: "Recorded your fist (do the open hand step too to set finger thresholds)." };
    const span = ratios.map((v, i) => ctx.open.ratios[i] - v), worst = span.indexOf(Math.min(...span));
    if (span[worst] < 0.1) return fail(`Couldn't tell your ${FINGER[worst]} finger open from closed. Curl it fully, or straighten it more in the open hand.`);
    // Calibration only ever loosens the defaults, for fingers that don't fully straighten or fold (stiff joints,
    // arthritis, long nails). Stricter-than-default lines never helped in testing, so they're not used.
    // "Folded" sits halfway between your fist and open hand: fingers folded in a sign are looser than in a fist.
    const D = { ext: 1.2, cur: 1.05 };
    const extended = ratios.map((v, i) => r3(clamp(v + 0.7 * span[i], 1.06, D.ext)));
    const curled = ratios.map((v, i) => r3(Math.min(Math.max(D.cur, v + 0.5 * span[i]), extended[i] - 0.05, 1.15)));
    return { ok: true, msg: "Finger thresholds set from your open hand and fist.", hand: { extended, curled } };
  },
  after: ctx => (ctx.open ? ` Now recognised: open hand ${pct(share(ctx.open.frames, "palm"))}, fist ${pct(share(ctx.fist.frames, "fist"))}.` : ""),
};
const handFour = {
  id: "handFour", icon: "4️⃣", title: "Four fingers, thumb tucked", say: "Four fingers up, thumb folded across your palm.", ms: 2500, meter: handMeter("four"),
  analyse(frames, ctx) {
    const hf = needHand(frames); if (!hf) return fail(NO_HAND);
    const tuck = median(feats(hf).map(f => f.thumbOut)); ctx.four = { frames: hf };
    if (!ctx.open) return { ok: true, msg: "Recorded." };
    if (ctx.open.thumb - tuck < 0.3) return fail(`Thumb out and thumb tucked looked alike (${r2(ctx.open.thumb)} vs ${r2(tuck)}). Fold the thumb right across the palm.`);
    return { ok: true, msg: `Thumb counts as "out" above ${r2((ctx.open.thumb + tuck) / 2)}.`, hand: { thumbOut: r3((ctx.open.thumb + tuck) / 2) } };
  },
  after: ctx => ` Now recognised: 4 fingers ${pct(share(ctx.four.frames, "four"))}${ctx.open ? `, open hand ${pct(share(ctx.open.frames, "palm"))}` : ""}.`,
};

const POSE_INFO = {
  one: ["☝️", "1 finger", "Point your index finger up, the rest folded, thumb tucked.", "Fold the other fingers fully."],
  two: ["✌️", "2 fingers", "Index and middle finger up (a V), the rest folded.", "Keep ring and pinky folded down."],
  three: ["3️⃣", "3 fingers", "Index, middle and ring finger up, pinky folded, thumb holding it.", "Fold the pinky right down."],
  thumbUp: ["👍", "Thumbs up", "Fist turned sideways, thumb pointing up.", "Turn the fist sideways so the knuckles stack vertically."],
  thumbDown: ["👎", "Thumbs down", "Fist turned sideways, thumb pointing down.", "Turn the fist sideways so the knuckles stack vertically."],
  ok: ["👌", "OK sign", "Thumb and index fingertip touching in a ring, other three fingers up.", "Make the ring tight and keep the other three straight."],
  rock: ["🤘", "Rock / horns", "Index and pinky up, middle and ring folded.", "Fold middle and ring fully."],
  callme: ["🤙", "Call me", "Thumb and pinky out, the other three folded.", "Stick the thumb out to the side."],
};
const POSE_NAMES = { palm: "open hand", four: "4 fingers", three: "3 fingers", two: "2 fingers", one: "1 finger", ok: "OK", rock: "rock", callme: "call me", thumbUp: "thumbs up", thumbDown: "thumbs down", fist: "fist" };
function poseCheck(pose) {
  const [icon, title, say, tip] = POSE_INFO[pose];
  return {
    id: "pose-" + pose, icon, title, say: say + " Hold it still.", ms: 2500, meter: handMeter(pose),
    analyse(frames) {
      const hf = needHand(frames); if (!hf) return fail(NO_HAND);
      const counts = {}; for (const f of hf) { const p = classifyHand(f.hands[0].lm, f.aspect) || "unclear"; counts[p] = (counts[p] || 0) + 1; }
      const frac = (counts[pose] || 0) / hf.length;
      if (frac >= 0.6) return { ok: true, msg: `Recognised ${pct(frac)} of the time.` };
      const [other] = Object.entries(counts).filter(([p]) => p !== pose).sort((a, b) => b[1] - a[1])[0] || ["unclear"];
      return fail(`Recognised only ${pct(frac)}; it mostly looked like ${POSE_NAMES[other] || other}. ${tip}`);
    },
  };
}

const swipe = {
  id: "swipe", icon: "👋", title: "Swipe", say: "Swipe your open hand sideways across the camera, left and right, a few times.", ms: 5000,
  meter: f => (firstHand(f) ? Math.min(1, Math.abs(f.hands[0].pos.x - 0.5) * 2) : 0),
  analyse(frames) {
    const pts = frames.filter(firstHand).map(f => ({ t: f.t, ...f.hands[0].pos }));
    if (pts.length < 6) return fail(NO_HAND);
    const win = SWIPE_CFG.windowMs, found = [];
    for (let k = 0; k < 2; k++) {
      let best = null;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length && pts[j].t - pts[i].t <= win; j++) {
        const dx = Math.abs(pts[j].x - pts[i].x), dy = Math.abs(pts[j].y - pts[i].y);
        if (dx > 2 * dy && (!best || dx > best.dx) && !found.some(s => pts[i].t < s.t1 + 300 && pts[j].t > s.t0 - 300)) best = { dx, t0: pts[i].t, t1: pts[j].t };
      }
      if (best) found.push(best);
    }
    const big = found.filter(s => s.dx >= 0.1);
    if (!big.length) return fail("Didn't see a clear sideways swipe. Move your whole open hand across the frame, quickly.");
    const travel = Math.min(...big.map(s => s.dx)), minTravel = r3(clamp(0.6 * travel, 0.12, 0.3));
    return { ok: true, msg: `Your swipes cover ${pct(travel)} of the frame. Trigger at ${pct(minTravel)}.`, swipe: { minTravel } };
  },
};

/* ---------- planning ---------- */
const EXPRESSIONS = {
  raise: ["🤨", "Eyebrow raise", "Raise your eyebrows high, then relax. Twice.", "brow", "browThreshold"],
  frown: ["😠", "Frown", "Frown: pull your eyebrows down and together, then relax. Twice.", "frown", "frownThreshold"],
  smile: ["😁", "Big smile", "Give a big smile, then relax. Twice.", "smile", "smileThreshold"],
  pucker: ["😗", "Pucker", "Pucker your lips like a kiss, then relax. Twice.", "pucker", "puckerThreshold"],
  jaw: ["😮", "Mouth open", "Open your mouth wide, then close. Twice.", "jaw", "jawThreshold"],
  mouthLeft: ["😏", "Mouth to your left", "Pull your mouth towards your left cheek, then relax. Twice.", "mouthL", "mouthLeftThreshold"],
  mouthRight: ["😏", "Mouth to your right", "Pull your mouth towards your right cheek, then relax. Twice.", "mouthR", "mouthRightThreshold"],
};
export const STEP_SECONDS = 1.5;   // "get ready" time before each step, on top of its recording time

export function planSteps(gestures) {
  const g = new Set(gestures), steps = [];
  const faceUsed = [...g].some(x => x in EXPRESSIONS || ["dblink", "longBlink", "winkLeft", "winkRight", "nod", "shake", "tiltLeft", "tiltRight"].includes(x));
  if (faceUsed) steps.push(neutral);
  for (const [id, [icon, title, say, key, cfgKey]] of Object.entries(EXPRESSIONS)) if (g.has(id)) steps.push(expression(id, icon, title, say, key, cfgKey));
  if (g.has("dblink") || g.has("longBlink")) steps.push(blink);
  if (g.has("winkLeft")) steps.push(wink("Left"));
  if (g.has("winkRight")) steps.push(wink("Right"));
  if (g.has("nod")) steps.push(headSwing("nod", "↕️", "Nod", "Nod yes, two or three times, like you normally would.", "pitch", 2, "nodDeg", 4, 15));
  if (g.has("shake")) steps.push(headSwing("shake", "↔️", "Shake", "Shake your head no, two or three times.", "yaw", 3, "shakeDeg", 5, 18));
  if (g.has("tiltLeft") || g.has("tiltRight")) steps.push(tilt);
  const poses = [...g].filter(x => x in POSE_INFO || ["palm", "four", "fist", "swipeLeft", "swipeRight"].includes(x));
  if (poses.length) { steps.push(handOpen, handFist); if (g.has("palm") || g.has("four")) steps.push(handFour); }
  for (const p of Object.keys(POSE_INFO)) if (g.has(p)) steps.push(poseCheck(p));
  if (g.has("swipeLeft") || g.has("swipeRight")) steps.push(swipe);
  return steps;
}
export const estimateSeconds = steps => Math.round(steps.reduce((s, st) => s + st.ms / 1000 + STEP_SECONDS + 1, 0));

/* ---------- runner ---------- */
// ui: { step(step, i, n), phase("ready"|"go", fraction), meter(x), result(step, res), control: { skip, stop } }
export async function runCalibration(steps, sources, ui, extraTargets = {}) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  if (sources.subscribe) sources = { camera: sources };
  const targets = { face: FaceRemote.CFG, hand: POSE_CFG, swipe: SWIPE_CFG, ...extraTargets };
  const ctx = {}, cal = { report: [] }; for (const k in targets) cal[k] = {};
  for (let i = 0; i < steps.length && !ui.control.stop; i++) {
    const step = steps[i]; ui.control.skip = false;
    ui.step(step, i, steps.length);
    const r0 = performance.now(), readyMs = STEP_SECONDS * 1000;   // wall-clock, so a busy CPU can't stretch it
    while (performance.now() - r0 < readyMs && !ui.control.skip && !ui.control.stop) { ui.phase("ready", 1 - (performance.now() - r0) / readyMs); await wait(100); }
    const source = sources[step.source || "camera"];
    const frames = [], unsub = source.subscribe(f => { frames.push(f); ui.meter(step.meter ? step.meter(f, ctx) : 0); });
    const t0 = performance.now();
    // On a slow computer few frames arrive, so keep recording (up to 2.5× longer) until there are enough to judge.
    const enough = () => frames.length >= 20 || performance.now() - t0 > step.ms * 2.5;
    while ((performance.now() - t0 < step.ms || !enough()) && !ui.control.skip && !ui.control.stop) { ui.phase("go", Math.min(1, (performance.now() - t0) / step.ms)); await wait(50); }
    unsub();
    if (ui.control.stop) break;
    let res;
    if (ui.control.skip) res = { ok: null, msg: "Skipped; kept the previous setting." };
    else {
      try { res = step.analyse(frames, ctx); } catch (e) { res = fail("Something went wrong analysing this step: " + e.message); }
      for (const k in targets) if (res[k]) { Object.assign(cal[k], res[k]); Object.assign(targets[k], res[k]); }
      if (res.ok && step.after) res.msg += step.after(ctx);
    }
    cal.report.push({ id: step.id, icon: step.icon, title: step.title, ok: res.ok, msg: res.msg });
    ui.result(step, res);
    await wait(1000);
  }
  cal.at = new Date().toISOString();
  return cal;
}

export const _test = { peaks, swings, neutral, expression, blink, wink, headSwing, tilt, handOpen, handFist, handFour, poseCheck, swipe };
