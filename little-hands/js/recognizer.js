// Sign recognition: hand shapes, places on the body, movements, and the 20 signs.
// Everything here is pure computation on landmarks; it never touches the camera or the network.
import { handSVG } from "./handsvg.js";

// ================================================================ hand shapes
// Measured from 3D hand landmarks; thresholds checked against ~2,700 real hand photos.
const W3 = (W, a, b) => Math.hypot(W[a].x - W[b].x, W[a].y - W[b].y, W[a].z - W[b].z);
function shapeOf(h) {
  const W = h.world;
  if (!W) return {};
  const palm = W3(W, 0, 9) || 1;
  const ext = [[5, 8], [9, 12], [13, 16], [17, 20]].map(([m, t]) => W3(W, 0, t) / (W3(W, 0, m) || 1));
  const up = ext.map(e => e > 1.58), m3 = (ext[0] + ext[1] + ext[2]) / 3;
  const gap = W3(W, 4, 8) / palm, thumbOut = W3(W, 4, 5) / palm > 0.55;
  const s = {
    fist: Math.max(...ext) < 1.15,
    flatO: m3 >= 1.0 && m3 <= 1.48 && gap < 0.6 && Math.max(...ext) < 1.6,
    C: m3 >= 1.3 && m3 <= 1.74 && gap >= 0.45 && !up.every(Boolean) && ext[2] > 1.25 && ext[3] > 1.15,
    flat: up.every(Boolean),
    W: up[0] && up[1] && up[2] && !up[3],
    Y: up[3] && !up[0] && !up[1] && !up[2] && thumbOut,
    ILY: up[0] && up[3] && !up[1] && !up[2] && thumbOut,
    index: up[0] && !up[1] && !up[2] && !up[3],
    two: up[0] && up[1] && !up[2] && !up[3],
    closed2: W3(W, 4, 8) / palm < 0.5 && W3(W, 4, 12) / palm < 0.55 && ext[2] < 1.35,
  };
  s.open5 = s.flat && thumbOut;
  s.openish = m3 > 1.45;
  s.open = m3;
  // Palm facing toward / away from the camera flips the winding of wrist→index→pinky on screen.
  const p = h.pts;
  s.twist = Math.sign((p[5].x - p[0].x) * (p[17].y - p[0].y) - (p[5].y - p[0].y) * (p[17].x - p[0].x));
  return s;
}
const SHAPE = {
  fist: { name: "fist", hint: "Make a fist", letter: "S" },
  flatO: { name: "fingertips together", hint: "Bunch all your fingertips onto your thumb", letter: "O" },
  flat: { name: "flat hand", hint: "Hold your hand flat, fingers together", letter: "B" },
  open5: { name: "open hand", hint: "Spread all five fingers wide", emoji: "🖐️" },
  C: { name: "C hand", hint: "Curve your hand into a C, like holding a cup", letter: "C" },
  W: { name: "W hand", hint: "Hold up three fingers: index, middle and ring", letter: "W" },
  Y: { name: "Y hand", hint: "Thumb and pinky out, other fingers folded", letter: "Y" },
  ILY: { name: "I-love-you hand", hint: "Thumb, index and pinky up; middle and ring folded", emoji: "🤟" },
  index: { name: "pointing finger", hint: "Point with your index finger", letter: "D" },
  two: { name: "two fingers", hint: "Index and middle fingers out together", letter: "U" },
};
const shapePic = (k, size = 70) => (SHAPE[k].letter ? handSVG(SHAPE[k].letter, { size }) : `<span style="font-size:${size * 0.6}px">${SHAPE[k].emoji}</span>`);

// ================================================================ geometry + motion helpers
const PLACE = { forehead: "forehead", eyes: "eyes", mouth: "mouth", chin: "chin", chest: "chest" };
const POINT = { thumb: [4], index: [8], middle: [12], tips: [4, 8, 12], cup: [4, 8], center: [0, 5, 9, 13, 17] };
const POINT_NAME = { thumb: "thumb", index: "index finger", middle: "fingertips", tips: "fingertips", cup: "hand", center: "hand" };
function pointOf(h, k) { const ids = POINT[k]; return { x: ids.reduce((s, i) => s + h.pts[i].x, 0) / ids.length, y: ids.reduce((s, i) => s + h.pts[i].y, 0) / ids.length }; }
function targetOf(body, place) {
  if (!body) return null;
  return place === "chest" ? { pt: body.chest, unit: body.shoulderW * 0.5 } : { pt: body[place], unit: body.unit };
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Taps: how many times a distance came back under `near` after being over `far`.
function arrivals(vals, near, far) {
  let n = 0, away = false;
  for (const v of vals) { if (v > far) away = true; else if (v < near && away) { n++; away = false; } }
  return n;
}
// Direction reversals of a signal, ignoring wiggles smaller than amp.
function reversals(vals, amp) {
  if (!vals.length) return 0;
  let hi = vals[0], lo = vals[0], dir = 0, n = 0;
  for (const v of vals) {
    if (dir === 0) { hi = Math.max(hi, v); lo = Math.min(lo, v); if (hi - v > amp) { dir = -1; lo = v; } else if (v - lo > amp) { dir = 1; hi = v; } }
    else if (dir === 1) { if (v > hi) hi = v; else if (hi - v > amp) { n++; dir = -1; lo = v; } }
    else { if (v < lo) lo = v; else if (v - lo > amp) { n++; dir = 1; hi = v; } }
  }
  return n;
}
// Total turning of a path, in degrees (a full circle is ~360).
function turning(pts, step = 0.06) {
  const s = [pts[0]];
  for (const p of pts) if (dist(p, s[s.length - 1]) >= step) s.push(p);
  let total = 0;
  for (let i = 2; i < s.length; i++) {
    const a1 = Math.atan2(s[i - 1].y - s[i - 2].y, s[i - 1].x - s[i - 2].x), a2 = Math.atan2(s[i].y - s[i - 1].y, s[i].x - s[i - 1].x);
    let d = a2 - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    total += d;
  }
  return Math.abs(total) * 180 / Math.PI;
}
const changes = states => { let n = 0, last = null; for (const s of states) { if (!s) continue; if (last && s !== last) n++; last = s; } return n; };
const holdTime = (tr, test) => { let t = 0; for (let i = tr.length - 1; i > 0 && test(tr[i]); i--) t += tr[i].t - tr[i - 1].t; return t; };
const recent = (tr, secs) => { const end = tr.length ? tr[tr.length - 1].t : 0; return tr.filter(r => end - r.t <= secs); };

function pickHand(hands, shapeKey) {
  if (!hands.length) return null;
  return hands.find(h => h.sh[shapeKey]) || hands[0];
}
function twoHands(hands) { return hands.length >= 2 ? [...hands].sort((a, b) => a.center.x - b.center.x).slice(0, 2) : null; }
const noHand = { ok: false, hint: "Hold your hand up where the camera can see it" };
const noBody = { ok: false, hint: "Sit back a little so your face and shoulders are in view" };
const shapeComp = (ok, k, both) => ({ ok, hint: ok ? `Nice ${SHAPE[k].name}` : (both ? "Both hands: " : "") + SHAPE[k].hint });

// ================================================================ sign builders
// One hand, a hand shape, at a place on the body; repeated taps (or a hold).
function atPlace({ shape, point, place, r = 1, taps = 0, hold = 0, placeHint }) {
  return {
    frame(hands, body) {
      const h = pickHand(hands, shape);
      if (!h) return { rec: { ok: false }, shape: noHand, place: noHand };
      const T = targetOf(body, place), P = pointOf(h, point), sOk = !!h.sh[shape];
      const d = T ? dist(P, T.pt) / T.unit : null;
      return {
        rec: { ok: sOk, d }, draw: T && { from: P, to: T.pt, r: r * T.unit, ok: d < r },
        shape: shapeComp(sOk, shape),
        place: !T ? noBody : { ok: d < r, hint: d < r ? `Right at your ${place}` : placeHint || `Bring your ${POINT_NAME[point]} to your ${place}` },
      };
    },
    motion(tr) {
      const vals = recent(tr, 3).filter(x => x.ok && x.d !== null).map(x => x.d);
      const n = taps ? arrivals(vals, r, r * 1.5) : 0;
      const held = holdTime(tr, x => x.ok && x.d !== null && x.d < r);
      if (taps && n >= taps) return { ok: true, hint: "Tapped!" };
      if (hold && held >= hold) return { ok: true, hint: "Held!" };
      if (taps) return { ok: false, hint: `Tap ${taps} times: ${Math.min(n, taps)} / ${taps}` + (hold ? ` (or hold still)` : "") };
      return { ok: false, hint: held > 0.1 ? `Hold it… ${Math.min(100, Math.round((held / hold) * 100))}%` : `Hold it there for a moment` };
    },
  };
}

// ================================================================ the 20 signs
const SIGNS = [
  { id: "milk", word: "Milk", emoji: "🍼", group: "Mealtime", shapes: ["fist", "open5"], dia: { place: "neutral", move: "squeeze", hands: 1 },
    how: ["Hold one hand in front of you.", "Squeeze it into a fist, then open it, as if milking a cow.", "Repeat a couple of times."],
    tip: "Sign it every time you offer a bottle or breastfeed, right before the milk arrives.",
    frame(hands) {
      const h = hands[0];
      if (!h) return { rec: { state: null }, shape: noHand, place: noHand };
      const state = h.sh.fist ? "closed" : h.sh.openish || h.sh.C ? "open" : null;
      return { rec: { state }, shape: { ok: !!state, hint: state ? (state === "closed" ? "Fist ✓ now open it" : "Open ✓ now squeeze") : "Squeeze into a fist, then open" }, place: { ok: true, hint: "In front of your chest is perfect" } };
    },
    motion(tr) { const n = changes(recent(tr, 3).map(r => r.state)); return { ok: n >= 3, hint: `Squeeze and open: ${Math.min(2, Math.floor((n + 1) / 2))} / 2` }; } },

  { id: "more", word: "More", emoji: "➕", group: "Mealtime", shapes: ["flatO"], dia: { place: "neutral", move: "tap2", hands: 2 },
    how: ["Bunch the fingertips of both hands onto your thumbs.", "Tap the fingertips of both hands together a few times."],
    tip: "The most useful mealtime sign: babies often learn it first. Sign it when offering seconds.",
    frame(hands) {
      const two = twoHands(hands);
      if (!two) return { rec: { ok: false }, shape: { ok: false, hint: "Use both hands" }, place: { ok: false, hint: "Hold both hands up in front of you" } };
      const ok = two[0].sh.flatO && two[1].sh.flatO, palm = (two[0].palm + two[1].palm) / 2;
      const d = dist(two[0].pts[4], two[1].pts[4]) / palm;
      return { rec: { ok, d }, shape: shapeComp(ok, "flatO", true), place: { ok: true, hint: "In front of your chest" } };
    },
    motion(tr) { const n = arrivals(recent(tr, 3).filter(r => r.ok).map(r => r.d), 0.9, 1.5); return { ok: n >= 2, hint: `Tap the fingertips together: ${Math.min(n, 2)} / 2` }; } },

  { id: "eat", word: "Eat", emoji: "🥄", group: "Mealtime", shapes: ["flatO"], dia: { place: "mouth", move: "tap", hands: 1 },
    how: ["Bunch your fingertips onto your thumb.", "Tap them to your mouth a couple of times, as if putting food in."],
    tip: "Use it at every meal and snack: “Time to eat!”", ...atPlace({ shape: "flatO", point: "tips", place: "mouth", r: 0.9, taps: 2 }) },

  { id: "drink", word: "Drink", emoji: "🥤", group: "Mealtime", shapes: ["C"], dia: { place: "mouth", move: "hold", hands: 1 },
    how: ["Shape your hand like a C, as if holding a cup.", "Bring it to your mouth and tip it, like taking a sip."],
    tip: "For cups and sippy cups; use Milk and Water for those specifically.", ...atPlace({ shape: "C", point: "cup", place: "mouth", r: 1.1, hold: 0.8 }) },

  { id: "water", word: "Water", emoji: "💧", group: "Mealtime", shapes: ["W"], dia: { place: "chin", move: "tap", hands: 1 },
    how: ["Hold up three fingers (a W).", "Tap your index finger against your chin twice."],
    tip: "Handy for drinks, and lovely at bath time and by the pool too.", ...atPlace({ shape: "W", point: "index", place: "chin", r: 1.0, taps: 2 }) },

  { id: "alldone", word: "All done", emoji: "🙌", group: "Mealtime", shapes: ["open5"], dia: { place: "neutral", move: "twist", hands: 2 },
    how: ["Hold both hands up, fingers spread, palms toward you.", "Twist them back and forth a few times."],
    tip: "Brilliant for the end of meals, baths and play. It replaces a lot of tray-throwing!",
    frame(hands) {
      const two = twoHands(hands);
      if (!two) return { rec: { ok: false }, shape: { ok: false, hint: "Use both hands" }, place: { ok: false, hint: "Hold both hands up, fingers spread" } };
      const ok = two.every(h => h.sh.openish);
      return { rec: { ok, a: two[0].sh.twist, b: two[1].sh.twist }, shape: shapeComp(ok, "open5", true), place: { ok: true, hint: "Up in front of you" } };
    },
    motion(tr) { const r = recent(tr, 3).filter(x => x.ok), n = changes(r.map(x => String(x.a))) + changes(r.map(x => String(x.b))); return { ok: n >= 3, hint: `Twist your hands: ${Math.min(3, n)} / 3` }; } },

  { id: "please", word: "Please", emoji: "🙏", group: "Manners", shapes: ["flat"], dia: { place: "chest", move: "circle", hands: 1 },
    how: ["Place a flat hand on your chest.", "Rub it round in a circle."],
    tip: "Model it whenever you ask your baby for something, and when they reach for something.",
    frame(hands, body) {
      const h = pickHand(hands, "flat");
      if (!h) return { rec: { ok: false }, shape: noHand, place: noHand };
      const T = targetOf(body, "chest"), ok = h.sh.flat || h.sh.open5;
      const d = T ? dist(h.center, T.pt) / T.unit : null;
      return { rec: { ok: ok && d !== null && d < 1.1, x: h.center.x / h.palm, y: h.center.y / h.palm }, draw: T && { from: h.center, to: T.pt, r: 1.1 * T.unit, ok: d < 1.1 },
               shape: shapeComp(ok, "flat"), place: !T ? noBody : { ok: d < 1.1, hint: d < 1.1 ? "On your chest" : "Put your flat hand on your chest" } };
    },
    motion(tr) {
      const pts = recent(tr, 3).filter(r => r.ok);
      const size = pts.length ? Math.min(Math.max(...pts.map(q => q.x)) - Math.min(...pts.map(q => q.x)), Math.max(...pts.map(q => q.y)) - Math.min(...pts.map(q => q.y))) : 0;
      const deg = pts.length > 5 && size >= 0.5 ? turning(pts) : 0;
      return { ok: deg >= 300, hint: size < 0.5 && pts.length > 5 ? "Make the circle bigger" : `Rub in a circle: ${Math.min(100, Math.round(deg / 3))}%` };
    } },

  { id: "thanks", word: "Thank you", emoji: "😊", group: "Manners", shapes: ["flat"], dia: { place: "chin", move: "away", hands: 1 },
    how: ["Touch the fingertips of a flat hand to your chin.", "Move your hand forward and down, toward the person you're thanking."],
    tip: "Say and sign it whenever someone gives your baby something.",
    frame(hands, body) {
      const h = pickHand(hands, "flat");
      if (!h) return { rec: { ok: false }, shape: noHand, place: noHand };
      const T = targetOf(body, "chin"), ok = h.sh.flat || h.sh.openish;
      const P = pointOf(h, "middle"), d = T ? dist(P, T.pt) / T.unit : null;
      return { rec: { ok, d }, draw: T && { from: P, to: T.pt, r: 1.3 * T.unit, ok: d < 1.3 },
               shape: shapeComp(ok, "flat"), place: !T ? noBody : { ok: d < 1.3, hint: d < 1.3 ? "Fingertips at your chin, now move away" : "Start with your fingertips at your chin" } };
    },
    motion(tr) {
      const r = recent(tr, 2).filter(x => x.ok && x.d !== null);
      const i = r.findIndex(x => x.d < 1.3), away = i >= 0 && r.slice(i).some(x => x.d > 2.6);
      return { ok: away, hint: i >= 0 ? "Now move your hand forward and down" : "Start at your chin, then move away" };
    } },

  { id: "yes", word: "Yes", emoji: "👍", group: "Manners", shapes: ["fist"], dia: { place: "neutral", move: "nod", hands: 1 },
    how: ["Make a fist.", "Nod it up and down from the wrist, like a head nodding."],
    tip: "Pair it with a nod and a smile; toddlers love answering with it.",
    frame(hands) {
      const h = pickHand(hands, "fist");
      if (!h) return { rec: { ok: false }, shape: noHand, place: noHand };
      return { rec: { ok: !!h.sh.fist, y: h.pts[9].y / h.palm }, shape: shapeComp(!!h.sh.fist, "fist"), place: { ok: true, hint: "In front of you" } };
    },
    motion(tr) { const n = reversals(recent(tr, 3).filter(r => r.ok).map(r => r.y), 0.22); return { ok: n >= 3, hint: `Nod your fist: ${Math.min(2, Math.floor((n + 1) / 2))} / 2` }; } },

  { id: "no", word: "No", emoji: "🙅", group: "Manners", shapes: ["two"], dia: { place: "neutral", move: "snap", hands: 1 },
    how: ["Hold your index and middle fingers out together, thumb out.", "Snap them shut onto your thumb, twice."],
    tip: "Gentler than shouting; pair it with a calm voice and a reason.",
    frame(hands) {
      const h = hands[0];
      if (!h) return { rec: { state: null }, shape: noHand, place: noHand };
      const state = h.sh.closed2 ? "shut" : h.sh.two ? "open" : null;
      return { rec: { state }, shape: { ok: !!state, hint: state ? (state === "open" ? "Two fingers ✓ now snap to your thumb" : "Shut ✓ now open again") : SHAPE.two.hint }, place: { ok: true, hint: "In front of you" } };
    },
    motion(tr) { const n = changes(recent(tr, 3).map(r => r.state)); return { ok: n >= 3, hint: `Snap: ${Math.min(2, Math.floor((n + 1) / 2))} / 2` }; } },

  { id: "mommy", word: "Mommy", emoji: "👩", group: "Family & feelings", shapes: ["open5"], dia: { place: "chin", move: "tap", hands: 1 },
    how: ["Spread all five fingers.", "Tap your thumb against your chin twice."],
    tip: "Sign it whenever Mom comes into the room or appears in photos.", ...atPlace({ shape: "open5", point: "thumb", place: "chin", r: 1.0, taps: 2, hold: 1.2, placeHint: "Bring your thumb to your chin" }) },

  { id: "daddy", word: "Daddy", emoji: "👨", group: "Family & feelings", shapes: ["open5"], dia: { place: "forehead", move: "tap", hands: 1 },
    how: ["Spread all five fingers.", "Tap your thumb against your forehead twice."],
    tip: "Same hand as Mommy, but up at the forehead.", ...atPlace({ shape: "open5", point: "thumb", place: "forehead", r: 1.1, taps: 2, hold: 1.2, placeHint: "Bring your thumb to your forehead" }) },

  { id: "baby", word: "Baby", emoji: "👶", group: "Family & feelings", shapes: ["flat"], dia: { place: "neutral", move: "rock", hands: 2 },
    how: ["Rest one forearm on the other, as if cradling a baby.", "Rock your arms gently side to side."],
    tip: "Point it out with dolls, other babies, and baby in the mirror.",
    frame(hands) {
      const two = twoHands(hands);
      if (!two) return { rec: { ok: false }, shape: { ok: false, hint: "Use both hands, arms cradled" }, place: { ok: false, hint: "Cradle your arms in front of you" } };
      const palm = (two[0].palm + two[1].palm) / 2, near = dist(two[0].center, two[1].center) / palm < 3;
      return { rec: { ok: near, x: (two[0].center.x + two[1].center.x) / 2 / palm }, shape: { ok: true, hint: "Both hands ✓" }, place: { ok: near, hint: near ? "Cradled ✓" : "Bring your hands closer, one arm resting on the other" } };
    },
    motion(tr) { const n = reversals(recent(tr, 3).filter(r => r.ok).map(r => r.x), 0.35); return { ok: n >= 3, hint: `Rock side to side: ${Math.min(3, n)} / 3` }; } },

  { id: "iloveyou", word: "I love you", emoji: "🤟", group: "Family & feelings", shapes: ["ILY"], dia: { place: "neutral", move: "hold", hands: 1 },
    how: ["Hold up your thumb, index finger and pinky.", "Fold your middle and ring fingers down. Hold it toward your baby."],
    tip: "Use it at bedtime, goodbyes and cuddles. It combines the letters I, L and Y.",
    frame(hands) {
      const h = pickHand(hands, "ILY");
      if (!h) return { rec: { ok: false }, shape: noHand, place: noHand };
      return { rec: { ok: !!h.sh.ILY }, shape: shapeComp(!!h.sh.ILY, "ILY"), place: { ok: true, hint: "Hold it up toward your baby" } };
    },
    motion(tr) { const t = holdTime(tr, r => r.ok); return { ok: t >= 1, hint: t > 0.1 ? `Hold it… ${Math.min(100, Math.round(t * 100))}%` : "Hold it still for a second" }; } },

  { id: "hurt", word: "Hurt", emoji: "🤕", group: "Family & feelings", shapes: ["index"], dia: { place: "neutral", move: "jab", hands: 2 },
    how: ["Point both index fingers at each other.", "Jab them toward each other a few times, near where it hurts."],
    tip: "Lets little ones show where something hurts, long before they can say it.",
    frame(hands) {
      const two = twoHands(hands);
      if (!two) return { rec: { ok: false }, shape: { ok: false, hint: "Use both hands, index fingers pointing" }, place: { ok: false, hint: "Point your index fingers at each other" } };
      const ok = two[0].sh.index && two[1].sh.index, palm = (two[0].palm + two[1].palm) / 2;
      const tips = dist(two[0].pts[8], two[1].pts[8]), wrists = dist(two[0].pts[0], two[1].pts[0]);
      const facing = tips < wrists && tips / palm < 2.5;
      return { rec: { ok: ok && facing, d: tips / palm }, shape: shapeComp(ok, "index", true), place: { ok: facing, hint: facing ? "Fingers facing ✓" : "Point the fingertips toward each other" } };
    },
    motion(tr) { const n = reversals(recent(tr, 3).filter(r => r.ok).map(r => r.d), 0.3); return { ok: n >= 3, hint: `Jab them together: ${Math.min(2, Math.floor((n + 1) / 2))} / 2` }; } },

  { id: "help", word: "Help", emoji: "🆘", group: "Family & feelings", shapes: ["fist", "flat"], dia: { place: "neutral", move: "lift", hands: 2 },
    how: ["Make a fist with one hand (thumb up) and rest it on the flat palm of the other.", "Lift both hands up together."],
    tip: "Teaches asking for help instead of getting frustrated: shoes, puzzles, climbing.",
    frame(hands) {
      const two = twoHands(hands);
      if (!two) return { rec: { ok: false }, shape: { ok: false, hint: "Use both hands: a fist on a flat palm" }, place: { ok: false, hint: "Rest your fist on your other palm" } };
      const fist = two.find(h => h.sh.fist), flat = two.find(h => h !== fist && (h.sh.flat || h.sh.openish));
      const ok = !!(fist && flat), palm = (two[0].palm + two[1].palm) / 2;
      const stacked = ok && fist.center.y < flat.center.y && Math.abs(fist.center.x - flat.center.x) / palm < 1.4 && (flat.center.y - fist.center.y) / palm < 1.8;
      return { rec: { ok: stacked, y: (two[0].center.y + two[1].center.y) / 2 / palm }, shape: { ok, hint: ok ? "Fist and flat hand ✓" : "One fist, one flat hand" },
               place: { ok: stacked, hint: stacked ? "Fist resting on your palm ✓" : "Rest the fist on top of the flat palm" } };
    },
    motion(tr) { const r = recent(tr, 1.6).filter(x => x.ok); const rise = r.length ? Math.max(...r.map(x => x.y)) - r[r.length - 1].y : 0; return { ok: rise >= 0.8, hint: `Lift them up together: ${Math.min(100, Math.round(rise / 0.008))}%` }; } },

  { id: "sleep", word: "Sleep", emoji: "😴", group: "Routines & play", shapes: ["open5", "flatO"], dia: { place: "eyes", move: "down", hands: 1 },
    how: ["Hold an open hand in front of your face.", "Draw it down to your chin while closing your fingers together, like eyes closing."],
    tip: "Part of a calm bedtime routine: sign it as you dim the lights.",
    frame(hands, body) {
      const h = hands[0];
      if (!h) return { rec: { ok: false }, shape: noHand, place: noHand };
      if (!body) return { rec: { ok: false }, shape: { ok: true, hint: "Hand ✓" }, place: noBody };
      const dy = (h.center.y - body.eyes.y) / body.unit, dx = Math.abs(h.center.x - body.eyes.x) / body.unit;
      const atFace = dx < 1.3 && dy > -0.8 && dy < 2.2;
      return { rec: { ok: atFace, dy, open: h.sh.open }, draw: { from: h.center, to: body.eyes, r: 1.2 * body.unit, ok: atFace },
               shape: { ok: true, hint: h.sh.openish ? "Open hand ✓ now close it as you move down" : "Start open, finish with fingers together" },
               place: { ok: atFace, hint: atFace ? "In front of your face ✓" : "Start with your hand in front of your eyes" } };
    },
    motion(tr) {
      const r = recent(tr, 2).filter(x => x.ok);
      const i = r.findIndex(x => x.dy < 0.6 && x.open > 1.4);
      const done = i >= 0 && r.slice(i).some(x => x.dy - r[i].dy > 0.8 && r[i].open - x.open > 0.25);
      return { ok: done, hint: i >= 0 ? "Now draw it down and close your fingers" : "Start open, in front of your eyes" };
    } },

  { id: "bath", word: "Bath", emoji: "🛁", group: "Routines & play", shapes: ["fist"], dia: { place: "chest", move: "rub", hands: 2 },
    how: ["Make two fists and hold them on your chest.", "Rub them up and down, like scrubbing."],
    tip: "Sign it on the way to the bath; it helps transitions feel predictable.",
    frame(hands, body) {
      const two = twoHands(hands);
      if (!two) return { rec: { ok: false }, shape: { ok: false, hint: "Use both hands, two fists" }, place: { ok: false, hint: "Both fists on your chest" } };
      const ok = two[0].sh.fist && two[1].sh.fist, T = targetOf(body, "chest");
      const mid = { x: (two[0].center.x + two[1].center.x) / 2, y: (two[0].center.y + two[1].center.y) / 2 }, d = T ? dist(mid, T.pt) / T.unit : null;
      const on = d !== null && d < 1.3, palm = (two[0].palm + two[1].palm) / 2;
      return { rec: { ok: ok && on, y: mid.y / palm }, draw: T && { from: mid, to: T.pt, r: 1.3 * T.unit, ok: on },
               shape: shapeComp(ok, "fist", true), place: !T ? noBody : { ok: on, hint: on ? "On your chest ✓" : "Bring both fists to your chest" } };
    },
    motion(tr) { const n = reversals(recent(tr, 3).filter(r => r.ok).map(r => r.y), 0.3); return { ok: n >= 3, hint: `Scrub up and down: ${Math.min(2, Math.floor((n + 1) / 2))} / 2` }; } },

  { id: "book", word: "Book", emoji: "📖", group: "Routines & play", shapes: ["flat"], dia: { place: "neutral", move: "open", hands: 2 },
    how: ["Press your flat palms together.", "Open them like the pages of a book, keeping the little-finger sides touching."],
    tip: "Great for story time; let your baby pick the book by signing.",
    frame(hands) {
      const two = twoHands(hands);
      if (!two) return { rec: { ok: false }, shape: { ok: false, hint: "Use both hands, flat" }, place: { ok: false, hint: "Palms together in front of you" } };
      const ok = two.every(h => h.sh.flat || h.sh.openish), palm = (two[0].palm + two[1].palm) / 2;
      return { rec: { ok, tips: dist(two[0].pts[8], two[1].pts[8]) / palm, wrists: dist(two[0].pts[0], two[1].pts[0]) / palm },
               shape: shapeComp(ok, "flat", true), place: { ok: true, hint: "In front of your chest" } };
    },
    motion(tr) {
      const r = recent(tr, 2).filter(x => x.ok);
      const i = r.findIndex(x => x.tips < 1.0);
      const opened = i >= 0 && r.slice(i).some(x => x.tips - r[i].tips > 1.2 && x.wrists < 2.0);
      return { ok: opened, hint: i >= 0 ? "Now open them like a book" : "Start with your palms pressed together" };
    } },

  { id: "play", word: "Play", emoji: "🧸", group: "Routines & play", shapes: ["Y"], dia: { place: "neutral", move: "shake", hands: 2 },
    how: ["Make Y hands with both hands: thumbs and pinkies out.", "Shake or twist them back and forth."],
    tip: "Sign it when it's playtime, or to ask if your baby wants to play.",
    frame(hands) {
      const two = twoHands(hands);
      if (!two) return { rec: { ok: false }, shape: { ok: false, hint: "Use both hands, Y shapes" }, place: { ok: false, hint: "Both Y hands up in front of you" } };
      const ok = two[0].sh.Y && two[1].sh.Y, palm = (two[0].palm + two[1].palm) / 2;
      return { rec: { ok, x: two[0].center.x / palm, a: two[0].sh.twist, b: two[1].sh.twist }, shape: shapeComp(ok, "Y", true), place: { ok: true, hint: "In front of you" } };
    },
    motion(tr) { const r = recent(tr, 3).filter(x => x.ok), n = Math.max(reversals(r.map(x => x.x), 0.3), changes(r.map(x => String(x.a))) + changes(r.map(x => String(x.b)))); return { ok: n >= 3, hint: `Shake them: ${Math.min(3, n)} / 3` }; } },
];
const GROUPS = ["Mealtime", "Manners", "Family & feelings", "Routines & play"];

// ================================================================ diagrams
const SPOT = { forehead: [60, 22], eyes: [60, 32], mouth: [60, 45], chin: [60, 53], chest: [60, 92], neutral: [60, 98] };
function diagram(s) {
  const [x, y] = SPOT[s.dia.place], m = s.dia.move;
  const arrow = (d) => `<path d="${d}" fill="none" stroke="#e07a5f" stroke-width="3" stroke-linecap="round" marker-end="url(#ar)"/>`;
  const glyph = {
    tap: `<path d="M${x + 16},${y - 7} q6,7 0,14 M${x + 23},${y - 11} q9,11 0,22" fill="none" stroke="#e07a5f" stroke-width="2.5" stroke-linecap="round"/>`,
    tap2: `<path d="M${x - 8},${y - 14} q8,-6 16,0" fill="none" stroke="#e07a5f" stroke-width="2.5" stroke-linecap="round"/><path d="M${x - 12},${y - 20} q12,-9 24,0" fill="none" stroke="#e07a5f" stroke-width="2.5" stroke-linecap="round"/>`,
    hold: `<circle cx="${x}" cy="${y}" r="13" fill="none" stroke="#e07a5f" stroke-width="2.5" stroke-dasharray="4 3"/>`,
    circle: arrow(`M${x + 14},${y} A14,14 0 1,1 ${x + 12},${y - 7}`),
    away: arrow(`M${x + 6},${y + 4} q16,10 30,26`),
    down: arrow(`M${x + 22},${y - 4} L${x + 22},${y + 20}`),
    nod: arrow(`M${x + 24},${y - 10} L${x + 24},${y + 8}`) + arrow(`M${x + 30},${y + 8} L${x + 30},${y - 10}`),
    rub: arrow(`M${x + 30},${y - 12} L${x + 30},${y + 8}`) + arrow(`M${x + 36},${y + 8} L${x + 36},${y - 12}`),
    rock: arrow(`M${x - 18},${y - 16} q18,-10 36,0`) + arrow(`M${x + 18},${y - 22} q-18,-10 -36,0`),
    shake: arrow(`M${x - 18},${y - 16} q18,-10 36,0`) + arrow(`M${x + 18},${y - 22} q-18,-10 -36,0`),
    twist: arrow(`M${x - 22},${y - 14} a10,10 0 1,1 8,-12`) + arrow(`M${x + 22},${y - 14} a10,10 0 1,0 -8,-12`),
    squeeze: `<text x="${x}" y="${y - 14}" font-size="13" text-anchor="middle">✊ ↔ 🖐️</text>`,
    snap: `<text x="${x}" y="${y - 14}" font-size="13" text-anchor="middle">✌️ → 👌</text>`,
    jab: arrow(`M${x - 26},${y - 14} l14,0`) + arrow(`M${x + 26},${y - 14} l-14,0`),
    lift: arrow(`M${x + 26},${y + 4} L${x + 26},${y - 22}`),
    open: arrow(`M${x - 4},${y - 16} q-12,-6 -22,4`) + arrow(`M${x + 4},${y - 16} q12,-6 22,4`),
  }[m] || "";
  const handGlyph = s.dia.hands === 2 ? "🙌" : "✋";
  return `<svg class="dia" viewBox="0 0 120 120" role="img" aria-label="Where to sign ${s.word}">
    <defs><marker id="ar" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#e07a5f"/></marker></defs>
    <path d="M14,120 C16,92 36,80 60,80 C84,80 104,92 106,120 Z" fill="#f2d7c2"/>
    <rect x="52" y="60" width="16" height="22" rx="6" fill="#f2d7c2"/>
    <circle cx="60" cy="38" r="22" fill="#f6dfcd"/>
    <circle cx="52" cy="34" r="2" fill="#6b5a50"/><circle cx="68" cy="34" r="2" fill="#6b5a50"/>
    <path d="M54,46 q6,4 12,0" fill="none" stroke="#c97b63" stroke-width="2" stroke-linecap="round"/>
    ${s.dia.place === "neutral" ? "" : `<circle cx="${x}" cy="${y}" r="7" fill="#81b29a" fill-opacity=".55" stroke="#4f9d76" stroke-width="2"/>`}
    <text x="${s.dia.place === "neutral" ? x : x - 1}" y="${s.dia.place === "neutral" ? y + 6 : y + 5}" font-size="${s.dia.place === "neutral" ? 22 : 14}" text-anchor="middle">${s.dia.place === "neutral" ? handGlyph : ""}</text>
    ${glyph}
  </svg>`;
}


export { SIGNS, GROUPS, SHAPE, shapeOf, shapePic, diagram, arrivals, reversals, turning };
