// Hand poses and hand motions from MediaPipe hand landmarks (21 points). Pure functions, no camera needed.
//
//   classifyHand(landmarks, aspect) → pose name or null
//     "palm"      open hand, all five fingers out
//     "four"      four fingers up, thumb tucked
//     "three"     index + middle + ring
//     "two"       index + middle (peace / V)
//     "one"       index only (pointing)
//     "ok"        thumb and index tip touching, other three up
//     "rock"      index + pinky (horns)
//     "callme"    thumb + pinky (shaka / call me)
//     "thumbUp"   sideways fist, thumb pointing up
//     "thumbDown" sideways fist, thumb pointing down
//     "fist"      closed hand (reported, but off by default: it's how hands rest)
//   makePoseTrigger(onPose)  → update(pose, now, pos): fires a pose once after it's held still for holdMs
//   makeSwipeDetector(onSwipe) → update(pos | null, now): fires "swipeLeft" / "swipeRight" (from your point of view)
//
// Everything is measured as distance ratios relative to the hand's own size, so it works at any distance and
// with either hand. Thresholds were set on ~9,000 real hand-landmark samples (an ASL alphabet dataset).
const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]];   // [tip, pip] for index, middle, ring, pinky

export const POSE_CFG = {
  extended: 1.2, curled: 1.05,          // finger tip-to-wrist ÷ pip-to-wrist
  thumbOut: 1.0,                        // thumb tip to pinky knuckle ÷ palm: tucked thumbs stay below ~0.7
  okTouch: 0.35,                        // thumb tip to index tip ÷ palm for the OK ring
  thumbReach: 0.62, thumbVertical: 0.45, thumbSlope: 1.0, sideways: 1.0,
};

export function handPoints(lm, aspect = 4 / 3) { return lm.map(p => [(p.x ?? p[0]) * aspect, p.y ?? p[1]]); }

export function classifyHand(lm, aspect = 4 / 3) {
  const P = handPoints(lm, aspect), C = POSE_CFG;
  const palm = d(P[0], P[9]);
  if (palm < 1e-4) return null;
  const r = FINGERS.map(([tip, pip]) => d(P[0], P[tip]) / d(P[0], P[pip]));
  const up = r.map(v => v > C.extended), down = r.map(v => v < C.curled);
  const [I, M, R, K] = up, [i, m, rr, k] = down;           // K = pinky up, k = pinky down
  const thumbOut = d(P[4], P[17]) / palm > C.thumbOut;
  if (I && M && R && K) return thumbOut ? "palm" : "four";
  if (M && R && K && !I && d(P[4], P[8]) / palm < C.okTouch) return "ok";
  if (I && M && R && k) return "three";
  if (I && M && rr && k) return "two";
  if (I && m && rr && k) return "one";
  if (I && K && m && rr) return "rock";
  if (K && i && m && rr && thumbOut && d(P[4], P[5]) / palm > 0.6) return "callme";
  if (i && m && rr && k) {
    // Thumbs up/down = a fist held sideways (knuckles stacked vertically) with the thumb sticking out vertically.
    // "Sideways" is what separates it from an upright fist with the thumb alongside (like the ASL letter A).
    const ax = P[9][0] - P[0][0], ay = P[9][1] - P[0][1];
    const reach = d(P[4], P[5]) / palm;
    const dx = P[4][0] - P[2][0], dy = P[4][1] - P[2][1];
    if (Math.abs(ax) > C.sideways * Math.abs(ay) && reach > C.thumbReach &&
        Math.abs(dy) > C.thumbVertical * palm && Math.abs(dy) > C.thumbSlope * Math.abs(dx))
      return dy < 0 ? "thumbUp" : "thumbDown";
    return "fist";
  }
  return null;
}

// Centre of the palm in normalised image coordinates (for motion and stillness).
export function palmCenter(lm) {
  let x = 0, y = 0; for (const i of [0, 5, 9, 13, 17]) { x += lm[i].x ?? lm[i][0]; y += lm[i].y ?? lm[i][1]; }
  return { x: x / 5, y: y / 5 };
}

// A pose must be held (and held still) for holdMs, then fires once; it re-arms after the hand leaves that pose
// for releaseMs. So a held thumbs-up rates one card, not ten, and a hand sweeping past doesn't count as a pose.
export function makePoseTrigger(onPose, { holdMs = 300, releaseMs = 300, stillTol = 0.06 } = {}) {
  let cand = null, since = 0, anchor = null, fired = null, goneSince = 0;
  return function update(pose, now, pos) {
    if (pose !== cand) { cand = pose; since = now; anchor = pos; }
    else if (pos && anchor && Math.hypot(pos.x - anchor.x, pos.y - anchor.y) > stillTol) { since = now; anchor = pos; }
    if (fired && pose !== fired) { if (!goneSince) goneSince = now; if (now - goneSince >= releaseMs) fired = null; }
    else if (fired) goneSince = 0;
    if (pose && !fired && now - since >= holdMs) { fired = pose; goneSince = 0; onPose(pose); }
  };
}

// Horizontal swipe: the palm travels ≥ minTravel of the frame width within windowMs, mostly sideways.
// The camera image isn't mirrored, so the hand moving towards image-left is moving to *your* right.
export function makeSwipeDetector(onSwipe, { windowMs = 450, minTravel = 0.22, cooldownMs = 700 } = {}) {
  let hist = [], quietUntil = 0;
  return function update(pos, now) {
    if (!pos) { hist = []; return; }
    hist.push({ ...pos, t: now });
    while (hist.length && now - hist[0].t > windowMs) hist.shift();
    if (now < quietUntil || hist.length < 3) return;
    const a = hist[0], dx = pos.x - a.x, dy = pos.y - a.y;
    if (Math.abs(dx) >= minTravel && Math.abs(dx) > 2 * Math.abs(dy)) {
      onSwipe(dx < 0 ? "swipeRight" : "swipeLeft");
      hist = []; quietUntil = now + cooldownMs;
    }
  };
}
