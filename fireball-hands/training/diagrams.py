import json, numpy as np
exec(open('train.py').read().split('data = ')[0])
m = np.load('asl/model.npz')
L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

def hand_frame(W):
    u = W[9] - W[0]; u /= np.linalg.norm(u)
    s = W[17] - W[5]; s -= u * (s @ u); s /= np.linalg.norm(s)
    n = np.cross(u, s)
    return np.stack([W @ s, -(W @ u), W @ n], 1)   # x across the knuckles, y up the hand (negative = up), z palm normal

groups = {l: [] for l in range(26)}
for r in rows:
    P, W = feats(r['lm'], r['wl'], r['hand'], r['w'], r['h'])
    x = vec(P, W)
    h = np.maximum(((x - m['mu']) / m['sd']) @ m['W1'] + m['b1'], 0); o = h @ m['W2'] + m['b2']
    p = np.exp(o - o.max()); p /= p.sum()
    if p.argmax() == r['label'] and p.max() > 0.95:
        ang = np.arctan2(P[9, 1], P[9, 0])          # image direction wrist -> middle knuckle
        groups[r['label']].append((hand_frame(W), ang, r['fn']))

# Which side of the palm do fingers curl toward? Use fists (S, A, E) to orient depth: palm side faces the viewer.
fist = np.array([F for l in (0, 4, 18) for F, _, _ in groups[l]])
palm_sign = np.sign(fist[:, [8, 12, 16, 20], 2].mean())
out = {}
for l, g in groups.items():
    A = np.array([F for F, _, _ in g])
    D = ((A[:, None] - A[None]) ** 2).sum((2, 3)) if len(A) < 400 else None
    i = int(np.argmin(D.sum(1)))                     # true medoid: the most typical real hand
    F = A[i].copy()
    F[:, 2] *= -palm_sign                            # make palm-side fingertips "closer" (smaller z)
    ang = np.angle(np.exp(1j * np.array([a for _, a, _ in g])).mean())   # typical tilt of the hand in the photos
    rot = np.radians({'G': 90, 'H': 90, 'P': 145, 'Q': 180}.get(L[l], 0))
    out[L[l]] = (F, rot, g[i][2], len(g), np.degrees(ang))

B = out['B'][0]
flip = B[4, 0] > B[20, 0]                            # right hand seen in a mirror: thumb on the left
js = {}
for l, (F, rot, fn, n, deg) in out.items():
    F = F.copy()
    if flip: F[:, 0] *= -1
    c, s_ = np.cos(rot if not flip else rot), np.sin(rot)
    if flip: s_ = -s_ if False else s_
    xy = F[:, :2] @ np.array([[c, s_], [-s_, c]])
    F[:, :2] = xy
    F -= F[0] * [1, 1, 0]
    F /= np.linalg.norm(F[9, :2]) or 1
    js[l] = [[round(float(v), 3) for v in q] for q in F]
    print(l, fn, n, f'tilt {deg:.0f}°', f'rot {np.degrees(rot):.0f}°')
js['J'] = js['I']   # J starts as an I; the diagram adds the motion arrow
print('flip', flip, 'palm_sign', palm_sign)
open('../diagrams.js', 'w').write(
  "// Hand-shape diagrams: for each letter, the landmarks of the most typical real hand in the training photos,\n"
  "// rotated to a palm-facing view (then tilted the way the letter is usually held), as seen in the mirrored preview.\n"
  "export const SHAPES = " + json.dumps(js, separators=(',', ':')) + ";\n")
