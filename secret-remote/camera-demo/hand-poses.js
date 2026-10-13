// Hand poses from MediaPipe hand landmarks (21 points). Pure functions, no camera needed.
//   classifyHand(landmarks, aspect) → "palm" | "thumbUp" | "thumbDown" | null
// Uses distance ratios from the wrist, so it works at any distance and with either hand.
const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]];   // [tip, pip] for index, middle, ring, pinky

export const POSE_CFG = { extended: 1.2, curled: 1.05, thumbReach: 0.62, thumbVertical: 0.45, thumbSlope: 1.0, sideways: 1.0 };

export function classifyHand(lm, aspect = 4 / 3) {
  const P = lm.map(p => [(p.x ?? p[0]) * aspect, p.y ?? p[1]]);   // to square pixels so distances are true
  const palm = d(P[0], P[9]);
  if (palm < 1e-4) return null;
  const ratios = FINGERS.map(([tip, pip]) => d(P[0], P[tip]) / d(P[0], P[pip]));
  if (ratios.every(r => r > POSE_CFG.extended)) return "palm";
  if (ratios.every(r => r < POSE_CFG.curled)) {
    // Thumbs up/down = a fist held sideways (knuckles stacked vertically) with the thumb sticking out vertically.
    // "Sideways" is what separates it from an upright fist with the thumb alongside (like the ASL letter A).
    const ax = P[9][0] - P[0][0], ay = P[9][1] - P[0][1];
    const reach = d(P[4], P[5]) / palm;                  // thumb tip away from the index knuckle = thumb sticking out
    const dx = P[4][0] - P[2][0], dy = P[4][1] - P[2][1];
    if (Math.abs(ax) > POSE_CFG.sideways * Math.abs(ay) && reach > POSE_CFG.thumbReach &&
        Math.abs(dy) > POSE_CFG.thumbVertical * palm && Math.abs(dy) > POSE_CFG.thumbSlope * Math.abs(dx))
      return dy < 0 ? "thumbUp" : "thumbDown";
  }
  return null;
}

// Turns per-frame poses into events: a pose must hold for holdMs, then fires once; it re-arms after the hand
// leaves that pose for releaseMs. So a held thumbs-up rates one card, not ten.
export function makePoseTrigger(onPose, { holdMs = 250, releaseMs = 300 } = {}) {
  let cand = null, since = 0, fired = null, goneSince = 0;
  return function update(pose, now) {
    if (pose !== cand) { cand = pose; since = now; }
    if (fired && pose !== fired) { if (!goneSince) goneSince = now; if (now - goneSince >= releaseMs) fired = null; }
    else if (fired) goneSince = 0;
    if (pose && !fired && now - since >= holdMs) { fired = pose; goneSince = 0; onPose(pose); }
  };
}
