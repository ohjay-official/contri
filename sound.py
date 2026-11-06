# Music and sound effects for the film, synthesised and timed to cues.json.
import json, os, numpy as np
from scipy.signal import butter, sosfilt, fftconvolve
from scipy.io import wavfile

SR = 48000
cues = json.load(open("cues.json"))
END = cues["END"]; HOOK = cues["HOOK"]; TITLE = cues["TITLE"]; DIAG = cues["DIAG"]; CLOSE = cues["CLOSE"]
S = {s["clip"]: s for s in cues["S"]}
N = int((END + 0.5) * SR)
rng = np.random.default_rng(3)

def buf(): return np.zeros((N, 2))
def tt(d): return np.arange(int(d * SR)) / SR
def lp(x, f, o=2): return sosfilt(butter(o, f, "low", fs=SR, output="sos"), x, axis=0)
def hp(x, f, o=2): return sosfilt(butter(o, f, "high", fs=SR, output="sos"), x, axis=0)
def bp(x, lo, hi, o=2): return sosfilt(butter(o, [lo, hi], "band", fs=SR, output="sos"), x, axis=0)
def add(dst, sig, t, gain=1.0, pan=0.0):
    i = int(t * SR)
    if i >= len(dst) or i + len(sig) <= 0: return
    if sig.ndim == 1:
        l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        sig = np.stack([sig * l, sig * r], 1) * 1.414
    if i < 0: sig = sig[-i:]; i = 0
    n = min(len(sig), len(dst) - i)
    dst[i:i + n] += sig[:n] * gain
def env(n, a, d, curve=4.0):
    e = np.ones(n); na = max(1, int(a * SR)); e[:na] = np.linspace(0, 1, na)
    tail = np.arange(n - na) / SR; e[na:] = np.exp(-curve * tail / max(d, 1e-3)); return e
def hz(m): return 440 * 2 ** ((m - 69) / 12)

# Reverb: a decaying stereo noise tail.
def reverb(x, secs=2.6, mix=0.3, bright=6000):
    n = int(secs * SR); t = np.arange(n) / SR
    ir = rng.standard_normal((n, 2)) * np.exp(-3.2 * t / secs)[:, None]
    ir = lp(ir, bright); ir[:int(0.012 * SR)] = 0; ir /= np.sqrt((ir ** 2).sum(0))
    wet = np.stack([fftconvolve(x[:, c], ir[:, c])[:len(x)] for c in range(2)], 1)
    return x * (1 - mix) + wet * mix * 2.2

# ---------------- Instruments ----------------
def kick(g=1.0):
    t = tt(0.55); f = 46 + 110 * np.exp(-t * 32)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 6.5)
    click = hp(rng.standard_normal(len(t)), 2500) * np.exp(-t * 300) * 0.25
    return np.tanh((s + click) * 1.6) * g
def hat(open_=False):
    t = tt(0.35 if open_ else 0.08)
    s = hp(rng.standard_normal(len(t)), 8000, 4) * np.exp(-t * (14 if open_ else 70))
    return s * 0.35
def clap():
    t = tt(0.4); s = bp(rng.standard_normal(len(t)), 900, 4500)
    e = sum(np.exp(-np.clip(t - d, 0, None) * 60) * (t >= d) for d in (0, 0.011, 0.023)) + 0.6 * np.exp(-t * 11)
    return s * e * 0.5
def sub(m, d):
    t = tt(d); f = hz(m)
    s = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)
    return s * env(len(t), 0.01, d * 0.9, 1.5) * 0.55
def pluck(m, d=0.6):
    t = tt(d); f = hz(m)
    s = sum(np.sin(2 * np.pi * f * k * t) * (0.6 ** (k - 1)) for k in range(1, 5))
    return lp(s * env(len(t), 0.003, 0.35, 3), 3800) * 0.22
def pad(ms, d, bright=1400):
    t = tt(d); s = np.zeros((len(t), 2))
    for m in ms:
        for det, pan in ((-0.09, -0.7), (0.0, 0.0), (0.08, 0.7)):
            f = hz(m) * 2 ** (det / 12)
            ph = rng.uniform(0, 2 * np.pi)
            saw = 2 * ((f * t + ph / (2 * np.pi)) % 1) - 1
            l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
            s[:, 0] += saw * l; s[:, 1] += saw * r
    s = lp(s, bright, 2)
    a = min(1.2, d * 0.3); e = np.ones(len(t)); na = int(a * SR); e[:na] = np.linspace(0, 1, na) ** 2
    nr = int(min(1.5, d * 0.35) * SR); e[-nr:] *= np.linspace(1, 0, nr) ** 2
    return s * e[:, None] * (0.05 / np.sqrt(len(ms)))
def bell(m, d=2.5, g=0.25):
    t = tt(d); f = hz(m)
    s = np.sin(2 * np.pi * f * t) + 0.45 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 3) + 0.25 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t * 6)
    return s * env(len(t), 0.002, d * 0.5, 2.5) * g

# ---------------- Effects ----------------
def impact(g=1.0, low=1.0):
    t = tt(2.6)
    boom = np.sin(2 * np.pi * np.cumsum(38 + 70 * np.exp(-t * 9)) / SR) * np.exp(-t * 2.2) * low
    nz = lp(rng.standard_normal(len(t)), 1800) * np.exp(-t * 7) * 0.5
    crack = hp(rng.standard_normal(len(t)), 3000) * np.exp(-t * 60) * 0.35
    return np.tanh((boom + nz + crack) * 1.3) * g
def whoosh(d=0.7, g=0.5, up=True):
    n = int(d * SR); x = rng.standard_normal(n); out = np.zeros(n)
    seg = 1024
    for i in range(0, n, seg):
        p = i / n; c = 400 + (5200 if up else 2600) * (p if up else 1 - p) ** 1.4
        y = bp(x[max(0, i - 2048):i + seg], max(80, c * 0.55), min(20000, c * 1.6))
        out[i:i + seg] = y[-len(out[i:i + seg]):]
    e = np.sin(np.pi * np.linspace(0, 1, n)) ** 1.6
    return out * e * g
def riser(d=1.6, g=0.35):
    t = tt(d); p = t / d
    nz = whoosh(d, 1.0, True) * p ** 2
    tone = np.sin(2 * np.pi * np.cumsum(220 + 660 * p ** 2) / SR) * p ** 3 * 0.15
    return (nz + tone) * g
def reverse_swell(d=1.4, g=0.4):
    x = impact(1.0)[: int(d * SR)][::-1]
    return lp(x, 2500) * np.linspace(0, 1, len(x)) ** 2 * g
def click(g=0.5):
    t = tt(0.05)
    s = np.sin(2 * np.pi * 2300 * t) * np.exp(-t * 260) + hp(rng.standard_normal(len(t)), 4000) * np.exp(-t * 500) * 0.4
    return s * g
def key(g=0.18):
    t = tt(0.04)
    return bp(rng.standard_normal(len(t)), 1800, 7000) * np.exp(-t * 220) * g * rng.uniform(0.7, 1.1)
def coin(g=0.25, m=88):
    return bell(m, 0.9, g)

music = buf(); fxb = buf()
BEAT = 60 / 100; BAR = BEAT * 4

# ---------------- Hook ----------------
W0, WD = 0.25, 0.44
for i in range(4):
    add(fxb, impact(0.55 + 0.1 * i, 0.9), W0 + i * WD)
    add(fxb, whoosh(0.22, 0.25, True), W0 + i * WD - 0.18, pan=(-0.5 + i * 0.33))
RING0 = W0 + 4 * WD
# tense drone and ticking pulse under the ring
add(music, pad([41, 48, 53, 56], HOOK + 0.8 - RING0 + 0.4, 700) * 1.6, RING0 - 0.2)
for k in range(int((HOOK - RING0) / (BEAT / 2))):
    add(fxb, click(0.12), RING0 + k * BEAT / 2, pan=0.3 if k % 2 else -0.3)
for i in range(6):
    add(fxb, coin(0.12, 84 + (i % 3) * 2), RING0 + 0.55 + i * 0.12 + 0.6, pan=-0.6 + i * 0.24)
add(fxb, whoosh(0.5, 0.25, False), 4.0)
add(fxb, bell(77, 2.0, 0.15), 4.6)
add(fxb, reverse_swell(1.3, 0.45), HOOK + 0.15 - 1.3)
add(fxb, impact(1.0), HOOK + 0.15)
add(music, bell(65, 4, 0.12), HOOK + 0.15); add(music, bell(72, 4, 0.08), HOOK + 0.2); add(music, bell(77, 4, 0.06), HOOK + 0.25)

# ---------------- Groove ----------------
G0 = S["hero"]["start"]          # laptop rises
PROG = [(41, [53, 56, 60, 63]), (37, [53, 56, 61, 65]), (44, [51, 56, 60, 63]), (39, [51, 55, 58, 62])]  # Fm9 Db Ab Eb
add(music, pad([53, 56, 60, 65], G0 - (HOOK + 0.15) + 0.6, 1200), HOOK + 0.15)
add(fxb, riser(1.5, 0.4), G0 - 1.3)
add(fxb, whoosh(1.1, 0.55, True), G0 - 0.1)
add(fxb, impact(0.7, 0.8), G0 + 0.55)
diag_a, diag_b = DIAG, DIAG + 6.4
tv = S["tv"]["start"]
t = G0; bar = 0
while t < tv:
    ch = PROG[(bar // 2) % 4]
    in_diag = diag_a - 0.05 <= t < diag_b - 0.05
    if bar % 2 == 0:
        add(music, pad(ch[1], BAR * 2 + 0.6, 1600 if not in_diag else 900), t)
    for b in range(4):
        bt = t + b * BEAT
        if bt >= tv: break
        dense = bt > G0 + BAR * 2
        if not in_diag and bt > G0 + 0.5:
            add(music, kick(0.55 if dense else 0.4), bt)
            if dense:
                add(music, hat(), bt + BEAT / 2, 0.8, 0.25)
                add(music, hat(), bt + BEAT / 4 * 3, 0.35, -0.25)
                if b % 2 == 1: add(music, clap(), bt, 0.55)
        add(music, sub(ch[0] - 12 + 12, BEAT * 0.9), bt, 0.7 if not in_diag else 0.4)
        for s16 in range(2):
            m = ch[1][(b * 2 + s16) % 4] + 12
            add(music, pluck(m), bt + s16 * BEAT / 2, 0.6 if not in_diag else 0.45, -0.35 if s16 else 0.35)
    t += BAR; bar += 1

# ---------------- Transitions, clicks, typing ----------------
for s in cues["S"]:
    if s["clip"] == "hero": continue
    add(fxb, whoosh(0.55, 0.22, True), s["start"] - 0.25, pan=0.2)
for c in cues["CAPS"]:
    if c[2] == "side": add(fxb, whoosh(0.3, 0.07, True), c[0] - 0.08, pan=-0.6)
for name, s in S.items():
    p = f"events/{name}.json"
    if not os.path.exists(p): continue
    for e in json.load(open(p)):
        tv_ = s["start"] + e["f"] / 30 - s["off"]
        if tv_ < s["start"] or tv_ >= s["end"]: continue
        if e["type"] == "click": add(fxb, click(0.45), tv_ + 4 / 30, pan=0.15)
        else: add(fxb, key(), tv_, pan=rng.uniform(-0.2, 0.2))

# Diagram: coins land, the pot pays out.
for i in range(5):
    add(fxb, coin(0.16, 84 + i), DIAG + 0.9 + i * 0.42 + 0.55, pan=-0.6 + i * 0.3)
last = DIAG + 0.9 + 4 * 0.42 + 0.55
add(fxb, impact(0.6, 0.7), last)
add(fxb, whoosh(0.6, 0.35, True), last + 0.35)
add(music, bell(77, 3, 0.16), last + 1.05); add(music, bell(81, 3, 0.12), last + 1.12); add(music, bell(84, 3, 0.1), last + 1.19)
add(fxb, riser(1.0, 0.3), diag_b - 1.0)

# Proof into the TV: lift, then let it breathe.
pr = S["proof"]["start"]
add(fxb, riser(S["proof"]["end"] - pr, 0.3), pr)
add(music, pad([53, 56, 60, 63, 67], CLOSE - tv + 0.8, 1300) * 1.2, tv)
add(fxb, impact(0.5, 0.6), tv)
add(fxb, whoosh(0.9, 0.4, False), CLOSE - 0.2)
# Close: final hit and a held chord.
add(fxb, impact(0.9), CLOSE + 0.5)
add(music, pad([41, 48, 53, 56, 60, 65], END - CLOSE, 1800) * 1.4, CLOSE + 0.4)
for k, m in enumerate([65, 72, 77, 80, 84]):
    add(music, bell(m, 4, 0.08), CLOSE + 0.5 + k * 0.09, pan=-0.5 + k * 0.25)
add(music, sub(29, 4.0) * 1.2, CLOSE + 0.5)

# ---------------- Mix ----------------
music = reverb(music, 2.4, 0.22)
fxb = reverb(fxb, 1.8, 0.16, 8000)
mix = music * 0.5 + fxb * 1.0
fade = int(1.0 * SR); mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
mix = hp(mix, 25)
mix = np.tanh(mix * 1.1) / 1.1
mix /= np.abs(mix).max() / 0.95
wavfile.write("sound.wav", SR, (mix * 32767).astype(np.int16))
print("ok", len(mix) / SR)
