// (Extension copy: the analysis loop runs on lib/ticker.js, because hidden offscreen pages never get animation frames.)
// AudioRemote: sounds → named gestures, on-device (Web Audio only, no libraries, nothing recorded or sent).
//
//   const mic = await AudioRemote.start({ onGesture(name), onLevel(rms, floor, threshold), onSound(kind) })
//   mic.onRaw = frame => {}     // every analysed frame: { t, audio: { rms, floor, hz, tonal, pitch } }  (used by calibration)
//   mic.stop()
//   AudioRemote.CFG             // thresholds (calibration writes here)
//   AudioRemote.planSteps(ids)  // calibration steps for the sound gestures in `ids` (same shape as camera-demo/calibration.js)
//
// Gestures
//   tap1, tap2, tap3   desk taps / knocks (thud or knock), counted within patternMs; fires when the window closes
//   click              pen click / finger snap (bright, high-frequency transient)
//   whistle            a steady whistled note (≥ 0.25 s)
//   whistleUp/Down     a whistle that slides up / down in pitch
//
// Taps: RMS onset against an adaptive noise floor, classified by spectral centroid ~20 ms after the onset, and only
// accepted if the sound dies away quickly (speech, music and a door slam's rumble don't), so talking isn't a tap.
// Whistles: "tonality" = share of the 500–4000 Hz power within ±2 bins of the strongest peak. A whistle is one pure
// tone (tonality ≈ 0.6–0.9); speech, music and noise spread across harmonics (≈ 0.1–0.3).
import { everyFrame } from "./ticker.js";

const CFG = {
  k: 3.5, absMin: 0.012, debounceMs: 180, patternMs: 650, riseRatio: 1.6, floorAlpha: 0.02, classifyDelayMs: 20,
  decayFromMs: 90, decayToMs: 160, decay: 0.4,   // a tap must have died down to < 40% of its peak 90–160 ms later
  threshold: 0, thudMaxHz: 900, clickMinHz: 2800,
  whistleLoHz: 500, whistleHiHz: 4000, tonal: 0.45, whistleMinLevel: 0.004, whistleMinMs: 250, whistleMaxMs: 3000, whistleGapMs: 90, glide: 0.15,
};

// Pure per-frame analysis of an analyser's spectrum (dB array) → centroid, tonality, pitch. Exported for tests.
export function analyseSpectrum(freqDb, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  let num = 0, den = 0;
  for (let i = 2; i < freqDb.length; i++) { const m = Math.pow(10, freqDb[i] / 10); num += m * i * binHz; den += m; }   // power-weighted centroid
  const lo = Math.max(2, Math.floor(CFG.whistleLoHz / binHz)), hi = Math.min(freqDb.length - 1, Math.ceil(CFG.whistleHiHz / binHz));
  let best = lo, total = 0;
  for (let i = lo; i <= hi; i++) { total += Math.pow(10, freqDb[i] / 10); if (freqDb[i] > freqDb[best]) best = i; }
  let near = 0; for (let i = Math.max(lo, best - 2); i <= Math.min(hi, best + 2); i++) near += Math.pow(10, freqDb[i] / 10);
  return { hz: den > 0 ? num / den : 0, tonal: total > 0 ? near / total : 0, pitch: best * binHz };
}
const classify = hz => (hz < CFG.thudMaxHz ? "thud" : hz < CFG.clickMinHz ? "knock" : "click");

async function start(h = {}) {
  // Voice processing would smooth away the sharp transients we want (and can warp whistles), so turn it all off.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") await ctx.resume();
  const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const timeBuf = new Float32Array(analyser.fftSize), freqBuf = new Float32Array(analyser.frequencyBinCount);
  const settings = stream.getAudioTracks()[0].getSettings ? stream.getAudioTracks()[0].getSettings() : {};
  const emit = g => h.onGesture && h.onGesture(g);
  let floor = 0.003, prevRms = 0, lastHit = -1e9, pending = null, burst = null, raf = 0;
  let wh = null, whistleAt = -1e9;   // current whistle candidate { start, last, pitches }; start of the last one held ≥ 120 ms
  const SUSTAINED_MS = 120;          // knocks and pings ring at one pitch too, but die away well before this
  const thr = () => Math.max(CFG.threshold, floor * CFG.k, CFG.absMin);
  const api = { onRaw: null, settings, noiseSuppressionHonored: settings.noiseSuppression !== true, get floor() { return floor; }, get threshold() { return thr(); },
    stop() { stopLoop(); stream.getTracks().forEach(t => t.stop()); ctx.close(); } };

  function tick() {
    analyser.getFloatTimeDomainData(timeBuf); analyser.getFloatFrequencyData(freqBuf);
    let s = 0; for (let i = 0; i < timeBuf.length; i++) s += timeBuf[i] * timeBuf[i];
    const rms = Math.sqrt(s / timeBuf.length), now = performance.now(), T = thr();
    const spec = analyseSpectrum(freqBuf, ctx.sampleRate, analyser.fftSize);

    // --- whistles
    // A whistle holds its loudness; a ringing knock is tonal too but fades fast, so it drops out here.
    const tonalNow = spec.tonal >= CFG.tonal && rms >= Math.max(CFG.whistleMinLevel, floor * 2) && (!wh || rms >= wh.peak * 0.25);
    if (tonalNow) {
      if (!wh) wh = { start: now, last: now, pitches: [], peak: rms };
      wh.last = now; wh.pitches.push(spec.pitch); wh.peak = Math.max(wh.peak, rms);
      if (now - wh.start >= SUSTAINED_MS) whistleAt = wh.start;
    } else if (wh && now - wh.last > CFG.whistleGapMs) {
      const dur = wh.last - wh.start, p = wh.pitches, q = Math.max(1, Math.floor(p.length / 4));
      if (dur >= CFG.whistleMinMs && dur <= CFG.whistleMaxMs) {
        const med = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
        const ratio = med(p.slice(-q)) / med(p.slice(0, q));
        emit(ratio > 1 + CFG.glide ? "whistleUp" : ratio < 1 - CFG.glide ? "whistleDown" : "whistle");
        h.onSound && h.onSound("whistle");
      }
      wh = null;
    }

    // --- taps and clicks
    if (pending) {
      const age = now - pending.t;
      if (age <= 30) pending.peak = Math.max(pending.peak, rms);
      // classify ~20 ms after the onset, when the tap sits inside the analyser's FFT window
      if (!pending.kind && age >= CFG.classifyDelayMs) pending.kind = classify(spec.hz);
      if (age >= CFG.decayFromMs) pending.late = Math.max(pending.late, rms);
    }
    if (pending && now - pending.t > CFG.decayToMs) {
      const { kind, peak, late } = pending; pending = null;
      if (late >= peak * CFG.decay) { h.onSound && h.onSound("sustained sound (ignored)"); }
      else acceptHit(kind || "thud", now);
    }
    const whistling = wh && now - wh.start >= SUSTAINED_MS;
    const isHit = !whistling && !pending && rms > T && rms > prevRms * CFG.riseRatio && now - lastHit > CFG.debounceMs;
    if (isHit) { lastHit = now; pending = { t: now, peak: rms, late: 0, kind: null }; }
    else if (rms < T) floor += CFG.floorAlpha * (rms - floor);   // only learn the floor from quiet frames
    prevRms = rms;
    h.onLevel && h.onLevel(rms, floor, T);
    if (api.onRaw) api.onRaw({ t: now, audio: { rms, floor, hz: spec.hz, tonal: spec.tonal, pitch: spec.pitch, voiced: tonalNow } });
  }
  function acceptHit(kind, now) {
    h.onSound && h.onSound(kind);
    if (!burst) {
      const b = burst = { count: 0, kind, start: now };
      setTimeout(() => {
        burst = null;
        if (whistleAt >= b.start - 400 && whistleAt <= b.start + 300) return;   // that "tap" was a whistle starting
        emit(b.kind === "click" ? "click" : "tap" + Math.min(3, b.count));
      }, CFG.patternMs);
    }
    burst.count++;
  }
  const stopLoop = everyFrame(tick);
  return api;
}

/* ---------- calibration steps (same interface as camera-demo/calibration.js; source: "audio") ---------- */
const r3 = x => Math.round(x * 1000) / 1000, pct = x => `${Math.round(x * 100)}%`, clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const fail = msg => ({ ok: false, msg });
const A = frames => frames.filter(f => f.audio).map(f => ({ t: f.t, ...f.audio }));
// Peaks of loud bursts: rms above gate; each burst ends after 80 ms of quiet. Returns [{ t, peak, hz }].
function bursts(fs, gate) {
  const out = []; let cur = null;
  for (const f of fs) {
    if (f.rms > gate) { if (!cur) cur = { t: f.t, peak: 0, hz: [], quietSince: 0 }; if (f.rms > cur.peak) cur.peak = f.rms; cur.hz.push(f.hz); cur.quietSince = 0; }
    else if (cur) { if (!cur.quietSince) cur.quietSince = f.t; if (f.t - cur.quietSince > 80) { out.push({ t: cur.t, peak: cur.peak, hz: median(cur.hz.slice(0, 3)) }); cur = null; } }
  }
  if (cur) out.push({ t: cur.t, peak: cur.peak, hz: median(cur.hz.slice(0, 3)) });
  return out;
}
const meterRms = f => (f.audio ? Math.min(1, Math.sqrt(f.audio.rms / 0.3)) : 0);

const quiet = {
  id: "quiet", source: "audio", icon: "🤫", title: "Quiet room", say: "Stay quiet for a few seconds so the background noise can be measured.", ms: 2500, meter: meterRms,
  analyse(frames, ctx) {
    const fs = A(frames); if (fs.length < 5) return fail("No sound from the microphone.");
    ctx.floor = median(fs.map(f => f.rms)); ctx.quietTonal = fs.filter(f => f.tonal >= CFG.tonal).length / fs.length;
    return { ok: true, msg: `Background level ${r3(ctx.floor)}.${ctx.quietTonal > 0.2 ? " There's a steady tone in the room (fan, fridge?); whistles may misfire." : ""}`, audio: {} };
  },
};
const taps = {
  id: "taps", source: "audio", icon: "👆", title: "Desk taps", say: "Tap the desk 5 times, the way you will while reviewing. Leave a second between taps.", ms: 7000, meter: meterRms,
  analyse(frames, ctx) {
    const fs = A(frames); if (fs.length < 5) return fail("No sound from the microphone.");
    const floor = ctx.floor ?? median(fs.map(f => f.rms)), b = bursts(fs, Math.max(floor * 4, CFG.absMin));
    if (b.length < 3) return fail(`Heard ${b.length} tap${b.length === 1 ? "" : "s"}; need at least 3. Tap a bit harder or move the laptop closer.`);
    const threshold = r3(Math.max(median(b.map(x => x.peak)) * 0.45, floor * 4));
    ctx.tapHz = b.map(x => x.hz);
    const out = { threshold }, clickish = b.filter(x => x.hz >= CFG.clickMinHz).length / b.length;
    let note = "";
    if (clickish > 0.5) {   // e.g. tapping with a fingernail on glass: move the click line above these taps
      out.clickMinHz = Math.round(Math.min(9000, Math.max(...ctx.tapHz) * 1.25));
      note = ` Your taps are bright (${Math.round(median(ctx.tapHz))} Hz), so pen clicks must now be above ${out.clickMinHz} Hz.`;
    }
    return { ok: true, msg: `Heard ${b.length} taps. Tap trigger set to ${r3(threshold)} (${Math.round(threshold / floor)}× the background).${note}`, audio: out };
  },
};
const clicks = {
  id: "clicks", source: "audio", icon: "🖊", title: "Pen click / snap", say: "Click a pen (or snap your fingers) 3 times.", ms: 5000, meter: meterRms,
  analyse(frames, ctx) {
    const fs = A(frames), floor = ctx.floor ?? median(fs.map(f => f.rms));
    const b = bursts(fs, Math.max(floor * 3, CFG.absMin * 0.6));
    if (b.length < 2) return fail("Didn't hear the clicks. Click closer to the microphone.");
    const lowClick = Math.min(...b.map(x => x.hz)), highTap = ctx.tapHz ? Math.max(...ctx.tapHz) : CFG.thudMaxHz;
    if (lowClick <= highTap * 1.1) return fail(`Your clicks (${Math.round(lowClick)} Hz) sound like your taps (up to ${Math.round(highTap)} Hz). Try a sharper click or a snap.`);
    const line = CFG.clickMinHz, clickHz = Math.round(median(b.map(x => x.hz)));
    // Only move the line if your clicks or taps actually cross it (knocks from other surfaces sit in between).
    if (lowClick > line * 1.1 && highTap < line) return { ok: true, msg: `Clicks are ${clickHz} Hz, taps up to ${Math.round(highTap)} Hz: both on the right side of the ${line} Hz line.`, audio: {} };
    const clickMinHz = Math.round(Math.max(Math.sqrt(lowClick * highTap), lowClick * 0.8));   // just under your clicks, never into your taps
    return { ok: true, msg: `Clicks are ${clickHz} Hz, taps up to ${Math.round(highTap)} Hz. Moved the line between them to ${clickMinHz} Hz.`, audio: { clickMinHz } };
  },
};
// Double-tap speed: how long a single tap waits for a possible second tap (shorter = snappier for fast tappers).
const rhythm = {
  id: "rhythm", source: "audio", icon: "✌", title: "Double taps", say: "Double-tap the desk 3 times (like a double-click), with a pause between each pair.", ms: 7000, meter: meterRms,
  analyse(frames, ctx) {
    const fs = A(frames), floor = ctx.floor ?? median(fs.map(f => f.rms));
    const b = bursts(fs, Math.max(CFG.threshold || 0, floor * 4, CFG.absMin));
    const gaps = []; for (let i = 1; i < b.length; i++) { const g = b[i].t - b[i - 1].t; if (g < 900) { gaps.push(g); i++; } }
    if (gaps.length < 2) return fail(`Heard ${gaps.length} double tap${gaps.length === 1 ? "" : "s"}; need 2 or more. Make the two taps of each pair quick, with a clear pause between pairs.`);
    const slow = Math.max(...gaps), fast = Math.min(...gaps);
    const patternMs = Math.round(clamp(slow * 1.6 + 100, 350, 900)), debounceMs = Math.round(clamp(fast * 0.6, 100, 180));
    return { ok: true, msg: `Your double taps are ${Math.round(fast)}–${Math.round(slow)} ms apart. A single tap now waits ${patternMs} ms (default ${DEFAULTS.patternMs}).`, audio: { patternMs, debounceMs } };
  },
};

// Whistle segments: runs of whistle-like frames (≤ 90 ms gaps) lasting ≥ 200 ms, with their pitch slide (end ÷ start).
function whistles(fs) {
  const out = []; let cur = null;
  for (const f of fs) {
    if (f.voiced) { if (!cur || f.t - cur.last > 90) { if (cur) out.push(cur); cur = { start: f.t, last: f.t, p: [] }; } cur.last = f.t; cur.p.push(f.pitch); }
  }
  if (cur) out.push(cur);
  return out.filter(w => w.last - w.start >= 200 && w.p.length >= 4).map(w => { const q = Math.max(1, Math.floor(w.p.length / 4)); return { ms: w.last - w.start, ratio: median(w.p.slice(-q)) / median(w.p.slice(0, q)) }; });
}
function slide(dir) {
  const up = dir === "up";
  return {
    id: "whistle" + (up ? "Up" : "Down"), source: "audio", icon: up ? "⤴️" : "⤵️", title: `Whistle sliding ${dir}`, say: `Whistle a note that slides ${dir}, twice.`, ms: 6000,
    meter: f => (f.audio && f.audio.voiced ? Math.min(1, f.audio.pitch / 3000) : 0),
    analyse(frames, ctx) {
      const ws = whistles(A(frames));
      if (!ws.length) return fail("Didn't hear a whistle. Whistle a little louder, or skip.");
      const right = ws.filter(w => (up ? w.ratio > 1 : w.ratio < 1));
      if (!right.length) return fail(`Those whistles went ${up ? "down" : "up"}, not ${dir}.`);
      const amount = Math.min(...right.map(w => Math.abs(w.ratio - 1)));
      ctx["glide" + dir] = amount;
      const steady = ctx.steadyDrift ?? 0.03, other = ctx["glide" + (up ? "down" : "up")];
      if (amount < steady * 1.5 + 0.03) return fail(`Your slide (${pct(amount)}) is too close to your steady note's wobble (${pct(steady)}). Slide further.`);
      const smallest = other === undefined ? amount : Math.min(amount, other);
      const glide = r3(clamp((steady + smallest) / 2, 0.05, 0.4));
      return { ok: true, msg: `Your ${dir} slide changes pitch by ${pct(amount)}. Slides now count above ${pct(glide)}; steady notes below.`, audio: { glide } };
    },
  };
}

const whistle = {
  id: "whistle", source: "audio", icon: "🎵", title: "Whistle", say: "Whistle a steady note for about a second, twice.", ms: 6000,
  meter: f => (f.audio ? Math.min(1, f.audio.tonal) : 0),
  analyse(frames, ctx) {
    const fs = A(frames), floor = ctx.floor ?? 0.003;
    const loud = fs.filter(f => f.rms > Math.max(CFG.whistleMinLevel * 0.5, floor * 2));
    const tones = loud.map(f => f.tonal).sort((a, b) => b - a), top = tones.slice(0, Math.max(3, Math.floor(tones.length * 0.3)));
    if (top.length < 6) return fail("Didn't hear a whistle. Whistle a little louder, or skip if you can't whistle.");
    const level = median(top);
    if (level < 0.3) return fail(`That didn't sound like a pure whistle (tonality ${pct(level)}). Try a clearer note.`);
    const tonal = r3(Math.max(0.3, Math.min(0.6, level * 0.65)));
    const ws = whistles(fs); ctx.steadyDrift = ws.length ? Math.max(...ws.map(w => Math.abs(w.ratio - 1))) : undefined;
    return { ok: true, msg: `Your whistle is ${pct(level)} pure tone. Whistles count above ${pct(tonal)}.${ctx.steadyDrift !== undefined ? ` A steady note wobbles ${pct(ctx.steadyDrift)}.` : ""}`, audio: { tonal } };
  },
};

function planSteps(ids) {
  const g = new Set(ids), steps = [];
  const anyTap = ["tap1", "tap2", "tap3", "click"].some(x => g.has(x)), anyWhistle = ["whistle", "whistleUp", "whistleDown"].some(x => g.has(x));
  if (!anyTap && !anyWhistle) return steps;
  steps.push(quiet);
  if (anyTap) steps.push(taps);
  if (g.has("tap2") || g.has("tap3")) steps.push(rhythm);
  if (g.has("click")) steps.push(clicks);
  if (anyWhistle) steps.push(whistle);
  if (g.has("whistleUp")) steps.push(slide("up"));
  if (g.has("whistleDown")) steps.push(slide("down"));
  return steps;
}

const DEFAULTS = { ...CFG };
// Reset to defaults, then apply a saved calibration's audio part.
function apply(cal) { Object.assign(CFG, DEFAULTS); if (cal && cal.audio) Object.assign(CFG, cal.audio); }

export const AudioRemote = { start, CFG, apply, planSteps, analyseSpectrum, _test: { bursts, whistles, quiet, taps, rhythm, clicks, whistle, slide } };
