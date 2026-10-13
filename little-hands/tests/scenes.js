// Simulated signers for the tests. Hands are built from real hand-shape landmarks (js/handshape-data.js)
// and moved through each sign in front of a simulated face/body. Evaluated inside the page (#debug mode).
window.__setup = async () => {
  window.__noCam = true;
  const { SHAPES } = await import("/js/handshape-data.js");
  const mix = (base, parts) => { const P = SHAPES[base].map(p => [...p]); for (const [letter, ids] of parts) for (const i of ids) P[i] = [...SHAPES[letter][i]]; return P; };
  const T = [1, 2, 3, 4], IDX = [5, 6, 7, 8], PINK = [17, 18, 19, 20];
  const LIB = {
    fist: SHAPES.S, flatO: SHAPES.O, flat: SHAPES.B, C: SHAPES.C, W: SHAPES.W, Y: SHAPES.Y, index: mix("S", [["D", IDX]]), two: SHAPES.U,
    open5: mix("B", [["L", T]]), ILY: mix("S", [["B", IDX], ["B", PINK], ["L", T]]), closed2: SHAPES.O,
  };
  const hand = (shape, { at, anchor = [0, 5, 9, 13, 17], scale = 70, flip = false, rot = 0 } = {}) => {
    const P = LIB[shape], c = Math.cos(rot), s = Math.sin(rot);
    const raw = P.map(([x, y]) => { const fx = flip ? -x : x; return { x: (fx * c - y * s) * scale, y: (fx * s + y * c) * scale }; });
    const ax = anchor.reduce((a, i) => a + raw[i].x, 0) / anchor.length, ay = anchor.reduce((a, i) => a + raw[i].y, 0) / anchor.length;
    const pts = raw.map(p => ({ x: p.x - ax + at.x, y: p.y - ay + at.y, z: 0 }));
    const world = P.map(([x, y, z]) => ({ x: flip ? -x : x, y, z }));
    const center = [0, 5, 9, 13, 17].reduce((a, i) => ({ x: a.x + pts[i].x / 5, y: a.y + pts[i].y / 5 }), { x: 0, y: 0 });
    return { pts, world, center, palm: Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y) };
  };
  const BODY = { eyes: { x: 500, y: 300 }, mouth: { x: 500, y: 360 }, nose: { x: 500, y: 330 }, unit: 60, chin: { x: 500, y: 396 }, forehead: { x: 500, y: 246 }, chest: { x: 500, y: 620 }, shoulderW: 300 };
  const osc = (t, f) => Math.sin(t * 2 * Math.PI * f);
  const tap = (t, f = 1.5) => Math.max(0, osc(t, f));
  window.__BODY = BODY;
  window.__SCENES = {
    milk: t => [hand(Math.floor(t / 0.35) % 2 ? "fist" : "open5", { at: { x: 650, y: 650 } })],
    more: t => { const d = 12 + tap(t, 1.4) * 120; return [hand("flatO", { at: { x: 500 - d, y: 620 }, anchor: [4] }), hand("flatO", { at: { x: 500 + d, y: 620 }, anchor: [4], flip: true })]; },
    eat: t => [hand("flatO", { at: { x: 500, y: 360 + tap(t) * 130 }, anchor: [4, 8, 12] })],
    drink: () => [hand("C", { at: { x: 500, y: 365 }, anchor: [4, 8] })],
    water: t => [hand("W", { at: { x: 500, y: 396 + tap(t) * 110 }, anchor: [8] })],
    alldone: t => { const f = Math.floor(t / 0.3) % 2 === 1; return [hand("open5", { at: { x: 380, y: 560 }, flip: f }), hand("open5", { at: { x: 620, y: 560 }, flip: !f })]; },
    please: t => [hand("flat", { at: { x: 500 + Math.cos(t * 5) * 70, y: 620 + Math.sin(t * 5) * 70 } })],
    thanks: t => { const ph = (t % 1.4) / 1.4; return [hand("flat", { at: { x: 500 + ph * 120, y: 396 + ph * 260 }, anchor: [12] })]; },
    yes: t => [hand("fist", { at: { x: 650, y: 600 + osc(t, 1.6) * 30 } })],
    no: t => [hand(Math.floor(t / 0.3) % 2 ? "closed2" : "two", { at: { x: 650, y: 600 } })],
    mommy: t => [hand("open5", { at: { x: 500, y: 396 + tap(t) * 110 }, anchor: [4] })],
    daddy: t => [hand("open5", { at: { x: 500, y: 246 + tap(t) * 110 }, anchor: [4] })],
    baby: t => { const x = osc(t, 0.9) * 60; return [hand("flat", { at: { x: 470 + x, y: 640 }, rot: 1.4 }), hand("flat", { at: { x: 540 + x, y: 680 }, rot: 1.4 })]; },
    iloveyou: () => [hand("ILY", { at: { x: 650, y: 560 } })],
    hurt: t => { const d = 50 + tap(t, 1.4) * 50; return [hand("index", { at: { x: 500 - d, y: 600 }, anchor: [8], rot: 1.57 }), hand("index", { at: { x: 500 + d, y: 600 }, anchor: [8], rot: -1.57 })]; },
    help: t => { const y = 680 - Math.min(1, Math.max(0, (t % 2) - 0.5)) * 150; return [hand("fist", { at: { x: 500, y: y - 60 } }), hand("flat", { at: { x: 505, y }, rot: 1.57 })]; },
    sleep: t => { const ph = Math.min(1, (t % 1.6) / 1.0); return [hand(ph < 0.6 ? "open5" : "flatO", { at: { x: 500, y: 300 + ph * 90 } })]; },
    bath: t => { const y = 620 + osc(t, 1.4) * 40; return [hand("fist", { at: { x: 450, y } }), hand("fist", { at: { x: 550, y } })]; },
    book: t => { const a = ((t % 1.6) / 1.6) * 1.1; return [hand("flat", { at: { x: 490, y: 620 }, anchor: [0], rot: -a }), hand("flat", { at: { x: 510, y: 620 }, anchor: [0], rot: a, flip: true })]; },
    play: t => { const x = osc(t, 1.6) * 40; return [hand("Y", { at: { x: 400 + x, y: 600 } }), hand("Y", { at: { x: 600 + x, y: 600 }, flip: true })]; },
    // Wrong versions that must not pass.
    "eat@chest": t => [hand("flatO", { at: { x: 500, y: 620 + tap(t) * 130 }, anchor: [4, 8, 12] })],
    "daddy@chin": t => [hand("open5", { at: { x: 500, y: 396 + tap(t) * 110 }, anchor: [4] })],
    "please-tiny": t => [hand("flat", { at: { x: 500 + Math.cos(t * 5) * 4, y: 620 + Math.sin(t * 5) * 4 } })],
    "mommy-fist": t => [hand("fist", { at: { x: 500, y: 396 + tap(t) * 110 }, anchor: [4] })],
    "mommy-still": () => [hand("open5", { at: { x: 500, y: 520 }, anchor: [4] })],
    "more-apart": t => { const d = 120 + tap(t, 1.4) * 60; return [hand("flatO", { at: { x: 500 - d, y: 620 }, anchor: [4] }), hand("flatO", { at: { x: 500 + d, y: 620 }, anchor: [4], flip: true })]; },
  };
};

// Plays a scene for up to `secs` seconds on the given sign; reports whether the app marked it done.
window.__runScene = (scene, signId, secs) => new Promise(resolve => {
  window.__open(signId);
  const before = (window.__test.progress[signId] || { times: 0 }).times;
  const t0 = performance.now() / 1000;
  let lastHint = "";
  const step = () => {
    const t = performance.now() / 1000 - t0;
    window.__feed(window.__SCENES[scene](t), window.__BODY);
    const c = window.__test.comps;
    if (c) lastHint = ["shape", "place", "move"].map(k => `${k}:${c[k].ok ? "✓" : "✗"} ${c[k].hint}`).join(" | ");
    const done = (window.__test.progress[signId] || { times: 0 }).times > before;
    if (done || t > secs) { window.__home(); resolve({ pass: done, at: t, lastHint }); }
    else requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
});
