import numpy as np, json
m = np.load('asl/model.npz')
r = lambda a: [float(f'{x:.4g}') for x in np.asarray(a).ravel()]
W = {k: r(m[k]) for k in ['W1', 'b1', 'W2', 'b2', 'mu', 'sd']}
H = m['b1'].shape[0]; D = m['mu'].shape[0]
js = f'''// ASL fingerspelling classifier.
// A small neural net (MLP, {D} -> {H} -> 26) over MediaPipe hand landmarks, trained on the
// Marxulia/asl_sign_languages_alphabets_v03 photo dataset (Hugging Face). Generated file: weights are data.
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const M = {json.dumps(W, separators=(',', ':'))};
const D = {D}, H = {H};

// Same normalisation as training: mirror left hands, centre on the wrist, scale by wrist->middle knuckle.
function normalise(pts, mirror) {{
  const o = pts[0];
  const out = pts.map(p => [(mirror ? -1 : 1) * (p[0] - o[0]), p[1] - o[1], p[2] - o[2]]);
  const s = Math.hypot(...out[9]) || 1;
  return out.map(p => p.map(v => v / s));
}}

export function classifyHand(lm, world, handed, w, h) {{
  if (!lm || !world) return {{ letter: null, conf: 0, second: null }};
  const mirror = handed === "Left";
  const P = normalise(lm.map(q => [q.x * w, q.y * h, q.z * w]), mirror);
  const Wl = normalise(world.map(q => [q.x, q.y, q.z]), mirror);
  const x = [];
  for (let i = 1; i < 21; i++) x.push(...P[i]);
  for (let i = 1; i < 21; i++) x.push(...Wl[i]);
  const hid = new Float32Array(H);
  for (let j = 0; j < H; j++) hid[j] = M.b1[j];
  for (let i = 0; i < D; i++) {{
    const z = (x[i] - M.mu[i]) / M.sd[i];
    if (!z) continue;
    for (let j = 0, row = i * H; j < H; j++) hid[j] += z * M.W1[row + j];
  }}
  const out = M.b2.slice();
  for (let j = 0; j < H; j++) {{
    const a = hid[j] > 0 ? hid[j] : 0;
    if (!a) continue;
    for (let c = 0, row = j * 26; c < 26; c++) out[c] += a * M.W2[row + c];
  }}
  const mx = Math.max(...out);
  let sum = 0;
  const p = out.map(v => (sum += Math.exp(v - mx), Math.exp(v - mx)));
  let best = 0, second = 1;
  for (let c = 0; c < 26; c++) p[c] /= sum;
  if (p[1] > p[0]) {{ best = 1; second = 0; }}
  for (let c = 2; c < 26; c++) {{
    if (p[c] > p[best]) {{ second = best; best = c; }} else if (p[c] > p[second]) second = c;
  }}
  return {{ letter: p[best] >= 0.45 ? LETTERS[best] : null, conf: p[best], second: LETTERS[second], probs: p }};
}}
'''
open('../asl.js', 'w').write(js)
print(len(js), 'bytes')
