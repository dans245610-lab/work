import json, numpy as np, sys
L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
rows = [r for r in json.load(open('asl/landmarks.json')) if not r.get('miss')]

def feats(lm, wl, hand, w, h):
    P = np.array(lm, float) * np.array([w, h, w]); W = np.array(wl, float)
    if hand == 'Left': P[:, 0] *= -1; W[:, 0] *= -1
    P -= P[0]; P /= np.linalg.norm(P[9]) + 1e-9
    W -= W[0]; W /= np.linalg.norm(W[9]) + 1e-9
    return P, W

def vec(P, W): return np.concatenate([P[1:].ravel(), W[1:].ravel()])

data = [(feats(r['lm'], r['wl'], r['hand'], r['w'], r['h']), r['label']) for r in rows]
y = np.array([l for _, l in data])
rng = np.random.default_rng(0)
idx = rng.permutation(len(data)); nval = len(data) // 7
val, tr = idx[:nval], idx[nval:]
print('train', len(tr), 'val', len(val))

def rot(P, W, th):
    c, s = np.cos(th), np.sin(th); R = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    return P @ R.T, W @ R.T

Xval = np.array([vec(*data[i][0]) for i in val])
def batch_aug(ids):
    X = []
    for i in ids:
        P, W = data[i][0]
        P, W = rot(P, W, rng.normal(0, 0.2))
        P = P * rng.normal(1, 0.04, 3) + rng.normal(0, 0.02, P.shape)
        W = W * rng.normal(1, 0.04, 3) + rng.normal(0, 0.02, W.shape)
        X.append(vec(P, W))
    return np.array(X)

Xtr0 = np.array([vec(*data[i][0]) for i in tr])
mu, sd = Xtr0.mean(0), Xtr0.std(0) + 1e-6
H = int(sys.argv[1]) if len(sys.argv) > 1 else 128
D = Xtr0.shape[1]
W1 = rng.normal(0, np.sqrt(2 / D), (D, H)); b1 = np.zeros(H)
W2 = rng.normal(0, np.sqrt(2 / H), (H, 26)); b2 = np.zeros(26)
params = [W1, b1, W2, b2]; m = [np.zeros_like(p) for p in params]; v = [np.zeros_like(p) for p in params]
lr, wd, step = 2e-3, 1e-4, 0

def forward(X, train=False):
    Z = (X - mu) / sd
    h = np.maximum(Z @ W1 + b1, 0)
    if train:
        mask = (rng.random(h.shape) > 0.2) / 0.8; h = h * mask
    o = h @ W2 + b2
    o -= o.max(1, keepdims=True); p = np.exp(o); p /= p.sum(1, keepdims=True)
    return Z, h, p

for ep in range(80):
    perm = rng.permutation(tr)
    for s in range(0, len(perm), 128):
        ids = perm[s:s + 128]; X = batch_aug(ids); Y = y[ids]
        Z, h, p = forward(X, True)
        g = p.copy(); g[np.arange(len(Y)), Y] -= 1; g /= len(Y)
        gW2 = h.T @ g + wd * W2; gb2 = g.sum(0)
        gh = g @ W2.T; gh[h <= 0] = 0
        gW1 = Z.T @ gh + wd * W1; gb1 = gh.sum(0)
        step += 1
        for i, (p_, g_) in enumerate(zip(params, [gW1, gb1, gW2, gb2])):
            m[i] = 0.9 * m[i] + 0.1 * g_; v[i] = 0.999 * v[i] + 0.001 * g_ * g_
            p_ -= lr * (m[i] / (1 - 0.9 ** step)) / (np.sqrt(v[i] / (1 - 0.999 ** step)) + 1e-8)
    if ep == 50: lr /= 3
    if ep % 10 == 9 or ep == 79:
        _, _, pv = forward(Xval); acc = (pv.argmax(1) == y[val]).mean()
        print(f'epoch {ep+1} val acc {acc:.3f}')

_, _, pv = forward(Xval); pred = pv.argmax(1)
print('per-letter val acc:')
print(' '.join(f'{L[c]}:{(pred[y[val]==c]==c).mean():.2f}' for c in range(26)))
conf = np.zeros((26, 26), int)
for a, b in zip(y[val], pred): conf[a, b] += 1
off = [(conf[a, b], L[a], L[b]) for a in range(26) for b in range(26) if a != b]
print('top confusions (true->pred):', sorted(off, reverse=True)[:12])
np.savez('asl/model.npz', W1=W1, b1=b1, W2=W2, b2=b2, mu=mu, sd=sd)
