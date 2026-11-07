// @ts-check
// The site's pages (not the app): the hero ring and its typed word, sections
// fading in as they scroll into view, and the FAQ opening one answer at a time.

document.documentElement.classList.add("js");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- Sections fade up once, as they come into view ----------

const faders = document.querySelectorAll("[data-fade]");
const showAll = () => { for (const el of faders) el.classList.add("in"); };
// Automated browsers (screenshots, link previews, AI screeners) and printouts
// get every section at once: they don't scroll, so nothing would fade in.
addEventListener("beforeprint", showAll);
if (still || navigator.webdriver || !("IntersectionObserver" in window)) {
  showAll();
} else {
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        seen.unobserve(e.target);
      }
    },
    { threshold: 0.2 },
  );
  for (const el of faders) seen.observe(el);
}

// ---------- The FAQ opens one answer at a time ----------
// Browsers do that themselves for <details name="faq">; this does it for older ones.

if (!("name" in HTMLDetailsElement.prototype)) {
  for (const d of document.querySelectorAll("details[name]")) {
    d.addEventListener("toggle", () => {
      if (!(d instanceof HTMLDetailsElement) || !d.open) return;
      for (const other of document.querySelectorAll(`details[name="${d.getAttribute("name")}"]`)) {
        if (other !== d && other instanceof HTMLDetailsElement) other.open = false;
      }
    });
  }
}

// ---------- The hero: a ring of fins, and the word typing itself ----------

const frame = /** @type {HTMLElement | null} */ (document.querySelector(".vortex-frame"));
if (frame) hero(frame);

/** @param {HTMLElement} frame */
function hero(frame) {
  const canvas = /** @type {HTMLCanvasElement} */ (frame.querySelector(".vortex-ring"));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const glow = document.createElement("canvas");
  const gctx = /** @type {CanvasRenderingContext2D} */ (glow.getContext("2d"));
  const typed = /** @type {HTMLElement} */ (frame.querySelector(".typed"));
  const caret = /** @type {HTMLElement} */ (frame.querySelector(".caret"));
  const words = (typed.dataset.words ?? typed.textContent ?? "").split("|").map((w) => Array.from(w));

  const STRANDS = 196;
  const SAMPLES = 41;
  // The glow is drawn small and scaled up, which softens it like a blur filter
  // at a fraction of the cost. Phones (lite) also get a lower pixel ratio and
  // 30 frames a second, so the ring doesn't hold up taps.
  let W = 0, H = 0, u = 1, shift = 0, dpr = 1, lite = false;
  const gs = 0.12;
  // Pointer, eased: the ring leans a little toward it.
  let px = 0, py = 0, tx = 0, ty = 0;

  const size = () => {
    const r = frame.getBoundingClientRect();
    W = r.width;
    H = r.height;
    const phone = innerWidth < 768;
    u = phone ? W / 600 : Math.min(W / 1052, H / 754);
    shift = phone ? Math.max(0, (H - 754 * u) / 2) : 0;
    frame.style.setProperty("--u", `${u}px`);
    frame.style.setProperty("--shift", `${shift}px`);
    lite = phone;
    dpr = Math.min(lite ? 1.5 : 2, devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    glow.width = Math.max(1, Math.round(W * dpr * gs));
    glow.height = Math.max(1, Math.round(H * dpr * gs));
  };

  const smooth = (/** @type {number} */ e0, /** @type {number} */ e1, /** @type {number} */ x) => {
    const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return k * k * (3 - 2 * k);
  };

  /** @param {CanvasRenderingContext2D} c @param {number} cx @param {number} cy @param {number} r0 @param {number} r1 @param {[number, string][]} stops */
  const radial = (c, cx, cy, r0, r1, stops) => {
    const g = c.createRadialGradient(cx, cy, Math.max(0, r0), cx, cy, r1);
    for (const [at, color] of stops) g.addColorStop(at, color);
    return g;
  };

  /** A filled ring between two radii, squashed vertically by `sy`. */
  const annulus = (/** @type {CanvasRenderingContext2D} */ c, /** @type {number} */ cx, /** @type {number} */ cy, /** @type {number} */ r0, /** @type {number} */ r1, /** @type {number} */ sy) => {
    c.beginPath();
    c.ellipse(cx, cy, r1, r1 * sy, 0, 0, Math.PI * 2);
    c.ellipse(cx, cy, Math.max(0, r0), Math.max(0, r0) * sy, 0, Math.PI * 2, 0, true);
    c.fill("evenodd");
  };

  /** @param {number} t seconds */
  const draw = (t) => {
    px += (tx - px) * 0.05;
    py += (ty - py) * 0.05;
    const spin = 0.06 * t;
    const k = 0.42 * (1 + 0.12 * Math.sin(0.55 * t));
    const cx = W / 2 + 34 * u + px * 14 * u;
    const cy = -212 * u + shift + py * 10 * u;
    const ri = 435 * u, ro = 652 * u;
    const sy = 1.03 * (1 + 0.035 * py);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    // Light: a deep-red fill in the ring, an orange halo outside, a faint pink one inside.
    ctx.fillStyle = radial(ctx, cx, cy, ri, ro, [[0, "rgba(170,14,50,.35)"], [0.5, "rgba(120,8,14,.45)"], [1, "rgba(170,40,6,.4)"]]);
    annulus(ctx, cx, cy, ri, ro, sy);
    ctx.fillStyle = radial(ctx, cx, cy, ro - 16 * u, ro + 70 * u, [[0, "rgba(255,110,40,0)"], [0.19, "rgba(255,110,40,.42)"], [1, "rgba(255,110,40,0)"]]);
    annulus(ctx, cx, cy, ro - 16 * u, ro + 70 * u, sy);
    ctx.fillStyle = radial(ctx, cx, cy, ri - 70 * u, ri + 10 * u, [[0, "rgba(255,90,150,0)"], [0.85, "rgba(255,90,150,.09)"], [1, "rgba(255,90,150,0)"]]);
    annulus(ctx, cx, cy, ri - 70 * u, ri + 10 * u, sy);

    const body = radial(ctx, cx, cy, ri, ro, [[0, "#b01e50"], [0.12, "#9c1236"], [0.4, "#860c18"], [0.7, "#9c1a0a"], [0.9, "#c63c0e"], [1, "#e85a18"]]);
    const edge = radial(ctx, cx, cy, ri, ro, [[0, "rgba(255,130,185,.85)"], [0.08, "rgba(255,84,138,.95)"], [0.28, "rgba(255,56,80,.95)"], [0.55, "rgba(255,58,44,.95)"], [0.8, "rgb(255,92,36)"], [0.94, "rgb(255,122,44)"], [1, "rgb(255,150,70)"]]);

    const g = gs * dpr;
    gctx.setTransform(g, 0, 0, g, 0, 0);
    gctx.clearRect(0, 0, W, H);
    gctx.globalAlpha = 0.7;
    gctx.lineWidth = 5.3 * u;
    gctx.strokeStyle = radial(gctx, cx, cy, ri, ro, [[0, "rgb(255,110,170)"], [0.4, "rgb(255,60,60)"], [1, "rgb(255,140,60)"]]);

    // Fins, drawn in angular order from the top of the ring (off-screen), so
    // where the last one meets the first no seam shows.
    const step = (Math.PI * 2) / STRANDS;
    const first = Math.ceil((((-Math.PI / 2 - spin) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / step);
    const xs = new Float32Array(SAMPLES), ys = new Float32Array(SAMPLES), ws = new Float32Array(SAMPLES);
    const lx = new Float32Array(SAMPLES), ly = new Float32Array(SAMPLES), rx = new Float32Array(SAMPLES), ry = new Float32Array(SAMPLES);
    for (let n = 0; n < STRANDS; n++) {
      const i = (first + n) % STRANDS;
      const ui = i * step + spin;
      let visible = false;
      for (let j = 0; j < SAMPLES; j++) {
        const q = j / (SAMPLES - 1);
        const r = ri + (ro - ri) * q;
        const th = ui + k * Math.pow(1 - q, 4.2) + 0.05 * k * q * q + 0.02 * Math.sin(Math.PI * q) * Math.sin(3 * ui + 0.4 * t);
        xs[j] = cx + r * Math.cos(th);
        ys[j] = cy + r * Math.sin(th) * sy;
        ws[j] = (0.15 + 3.3 * smooth(0, 0.28, q) * (1 - 0.25 * q)) * u;
        if (ys[j] > -8 * u && xs[j] > -20 * u && xs[j] < W + 20 * u) visible = true;
      }
      if (!visible) continue;
      for (let j = 0; j < SAMPLES; j++) {
        const a = Math.max(0, j - 1), b = Math.min(SAMPLES - 1, j + 1);
        const dx = xs[b] - xs[a], dy = ys[b] - ys[a];
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        lx[j] = xs[j] + nx * ws[j];
        ly[j] = ys[j] + ny * ws[j];
        rx[j] = xs[j] - nx * ws[j];
        ry[j] = ys[j] - ny * ws[j];
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      ctx.moveTo(lx[0], ly[0]);
      for (let j = 1; j < SAMPLES; j++) ctx.lineTo(lx[j], ly[j]);
      for (let j = SAMPLES - 1; j >= 0; j--) ctx.lineTo(rx[j], ry[j]);
      ctx.closePath();
      ctx.fillStyle = body;
      ctx.fill();
      ctx.globalCompositeOperation = "lighter";
      ctx.beginPath();
      ctx.moveTo(lx[0], ly[0]);
      for (let j = 1; j < SAMPLES; j++) ctx.lineTo(lx[j], ly[j]);
      ctx.lineWidth = 1.45 * u;
      ctx.strokeStyle = edge;
      ctx.stroke();
      gctx.beginPath();
      gctx.moveTo(lx[0], ly[0]);
      for (let j = 1; j < SAMPLES; j++) gctx.lineTo(lx[j], ly[j]);
      gctx.stroke();
    }

    // The thin orange outer rim.
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 1.6 * u;
    ctx.strokeStyle = "rgba(255,120,50,.7)";
    ctx.beginPath();
    ctx.ellipse(cx, cy, ro, ro * sy, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Bloom: the edges again, small and blurred, added on top.
    gctx.globalAlpha = 1;
    gctx.lineWidth = 9 * u;
    gctx.strokeStyle = "rgba(255,110,40,.8)";
    gctx.beginPath();
    gctx.ellipse(cx, cy, ro, ro * sy, 0, 0, Math.PI * 2);
    gctx.stroke();
    gctx.lineWidth = 5 * u;
    gctx.strokeStyle = "rgba(255,90,160,.6)";
    gctx.beginPath();
    gctx.ellipse(cx, cy, ri, ri * sy, 0, 0, Math.PI * 2);
    gctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(glow, 0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";
  };

  // The word: types, holds with a blinking caret, deletes, types the next.
  // A pure function of time, like the ring.
  const plan = words.map((w) => ({ w, type: w.length * 0.1, pause: 0.15, hold: 2.6, del: w.length * 0.07, empty: 0.25 }));
  const cycle = plan.reduce((s, p) => s + p.type + p.pause + p.hold + p.del + p.empty, 0);
  const start = plan[0].type + plan[0].pause; // open on the first word, fully typed
  let shown = "";
  /** @param {number} t seconds */
  const type = (t) => {
    let at = (t + start) % cycle;
    let text = "", blink = false;
    for (const p of plan) {
      const span = p.type + p.pause + p.hold + p.del + p.empty;
      if (at >= span) { at -= span; continue; }
      if (at < p.type) text = p.w.slice(0, Math.min(p.w.length, Math.floor(at / 0.1) + 1)).join("");
      else if (at < p.type + p.pause) text = p.w.join("");
      else if (at < p.type + p.pause + p.hold) { text = p.w.join(""); blink = Math.floor((at - p.type - p.pause) / 0.55) % 2 === 1; }
      else if (at < p.type + p.pause + p.hold + p.del) text = p.w.slice(0, Math.max(0, p.w.length - Math.floor((at - p.type - p.pause - p.hold) / 0.07) - 1)).join("");
      else text = "";
      break;
    }
    if (text !== shown) typed.textContent = shown = text;
    caret.classList.toggle("off", blink);
  };

  size();
  // A resize clears the canvas; with reduced motion nothing redraws it, so draw once.
  addEventListener("resize", () => { size(); if (still) draw(0); }, { passive: true });
  if (still) {
    draw(0);
    return;
  }
  frame.addEventListener("pointermove", (e) => {
    const r = frame.getBoundingClientRect();
    tx = ((e.clientX - r.left) / r.width) * 2 - 1;
    ty = ((e.clientY - r.top) / r.height) * 2 - 1;
  });
  frame.addEventListener("pointerleave", () => (tx = ty = 0));

  let onScreen = true;
  new IntersectionObserver(([e]) => (onScreen = e.isIntersecting)).observe(frame);
  const t0 = performance.now();
  let last = 0;
  const loop = (/** @type {number} */ now) => {
    if (onScreen && !document.hidden && (!lite || now - last >= 1000 / 30)) {
      last = now;
      const t = (now - t0) / 1000;
      draw(t);
      type(t);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
