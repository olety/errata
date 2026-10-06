# Measure the rig (room/rig.ts, RIGS) from the plates' alpha channel. For each body collar: the peak of the top
# silhouette inside a search window, the collar run (columns whose top edge stays within `depth` of the peak), then the
# opening as the centroid of the darker interior paint in the collar box. For each head sprite: the lowest run of the
# bottom silhouette and its opening the same way. Writes the JSON and one overlay per plate for checking by eye.
# Usage: python3 -I measure-rig.py <plates/rig folder> <out.json>   (run from a scratch folder; overlays land there)
import sys, json
import numpy as np
from PIL import Image, ImageDraw
D = sys.argv[1].rstrip("/") + "/"
OUT = sys.argv[2]

def load(n):
    rgba = Image.open(D + n + ".png").convert("RGBA")
    im = np.array(rgba).astype(float)
    a = im[:, :, 3] > 128
    lum = 0.299 * im[:, :, 0] + 0.587 * im[:, :, 1] + 0.114 * im[:, :, 2]
    return rgba, a, lum

def bbox(a):
    xs = np.where(a.any(axis=0))[0]; ys = np.where(a.any(axis=1))[0]
    return [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]

def opening(a, lum, x0, x1, y0, y1, pct=30):
    box = a[y0:y1, x0:x1]; L = lum[y0:y1, x0:x1]
    thr = np.percentile(L[box], pct)
    ys, xs = np.where(box & (L <= thr))
    return float(xs.mean() + x0), float(ys.mean() + y0)

def collar(a, lum, lo, hi, depth=45, maxhalf=150):
    H, W = a.shape
    top = np.array([np.argmax(a[:, x]) if a[:, x].any() else H for x in range(W)], float)
    ts = np.convolve(top, np.ones(9) / 9, mode="same")
    x = lo + int(np.argmin(ts[lo:hi]))
    l = x
    while l > max(0, x - maxhalf) and ts[l - 1] < ts[x] + depth: l -= 1
    r = x
    while r < min(W - 1, x + maxhalf) and ts[r + 1] < ts[x] + depth: r += 1
    w = r - l
    ox, oy = opening(a, lum, l, r + 1, int(ts[x]), int(ts[x] + 0.5 * w))
    return {"peak": [x, float(ts[x])], "run": [l, r], "open": [ox, oy], "w": w}

def head(a, lum, depth=60):
    H, W = a.shape
    bot = np.array([H - 1 - np.argmax(a[::-1, x]) if a[:, x].any() else -1 for x in range(W)], float)
    bs = np.convolve(bot, np.ones(9) / 9, mode="same")
    x = int(np.argmax(bs))
    l = x
    while l > 0 and bs[l - 1] > bs[x] - depth: l -= 1
    r = x
    while r < W - 1 and bs[r + 1] > bs[x] - depth: r += 1
    w = r - l
    ox, oy = opening(a, lum, l, r + 1, int(bs[x] - 0.45 * w), int(bs[x]))
    return {"bottom": [x, float(bs[x])], "run": [l, r], "open": [ox, oy], "w": w}

WINDOWS = {
    "body-wyrm": [(480, 680, 45, 150), (745, 790, 30, 70), (1005, 1065, 30, 80)],
    "body-hydra": [(590, 790), (290, 480), (900, 1090), (40, 220), (1150, 1340)],
    "body-stag": [(180, 380)],
    "body-moth": [(700, 850)],
}
res = {}
for n, wins in WINDOWS.items():
    rgba, a, lum = load(n)
    H, W = a.shape
    cs = [collar(a, lum, w[0], w[1], *(w[2:] if len(w) > 2 else ())) for w in wins]
    res[n] = {"W": W, "H": H, "bbox": bbox(a), "collars": cs}
    bg = Image.new("RGBA", rgba.size, (255, 249, 238, 255)); bg.alpha_composite(rgba)
    d = ImageDraw.Draw(bg)
    for i, c in enumerate(cs):
        ox, oy = c["open"]; l, r = c["run"]
        d.rectangle([l, c["peak"][1], r, c["peak"][1] + 0.5 * c["w"]], outline=(0, 120, 255, 255), width=3)
        d.ellipse([ox - 12, oy - 12, ox + 12, oy + 12], fill=(255, 0, 0, 255))
        d.text((ox + 16, oy - 8), str(i), fill=(255, 0, 0, 255))
    bg.convert("RGB").resize((W // 2, H // 2)).save(n + "-measured.png")
for n in ["head-wyrm", "head-hydra", "head-stag", "head-moth"]:
    rgba, a, lum = load(n)
    H, W = a.shape
    h = head(a, lum)
    res[n] = {"W": W, "H": H, "bbox": bbox(a), **h}
    bg = Image.new("RGBA", rgba.size, (255, 249, 238, 255)); bg.alpha_composite(rgba)
    d = ImageDraw.Draw(bg)
    ox, oy = h["open"]; l, r = h["run"]
    d.rectangle([l, h["bottom"][1] - 0.45 * h["w"], r, h["bottom"][1]], outline=(0, 120, 255, 255), width=3)
    d.ellipse([ox - 12, oy - 12, ox + 12, oy + 12], fill=(255, 0, 0, 255))
    bg.convert("RGB").resize((W // 2, H // 2)).save(n + "-measured.png")
for n in ["owl-workshop", "heron"]:
    rgba, a, lum = load(n)
    H, W = a.shape
    res[n] = {"W": W, "H": H, "bbox": bbox(a)}
json.dump(res, open(OUT, "w"), indent=1)
for k, v in res.items():
    print(k, {kk: vv for kk, vv in v.items() if kk in ("collars", "open", "run", "bbox", "w")})
