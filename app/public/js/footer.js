// @ts-check
// The footer: a small computer on a hill, in one five-second clip. On arrival
// the screen switches on and rests on its colour bars. The o in Contri is a
// power button: pressing it plays the rest of the clip (dusk, night, the
// screen collapsing to a point), and that last point of light flies up into
// the o. Pressing it again switches the scene back on. Nothing in the scene is
// drawn except a scanline on the screen glass, a few glints, and that dot.

const foot = /** @type {HTMLElement | null} */ (document.querySelector(".scene-foot"));
if (foot) scene(foot);

/** @param {HTMLElement} foot */
function scene(foot) {
  const video = /** @type {HTMLVideoElement} */ (foot.querySelector(".scene-video"));
  const fx = /** @type {HTMLCanvasElement} */ (foot.querySelector(".scene-fx"));
  const sky = /** @type {HTMLCanvasElement} */ (foot.querySelector(".scene-sky"));
  const button = /** @type {HTMLButtonElement} */ (foot.querySelector(".wordmark-power"));
  const o = /** @type {HTMLElement} */ (foot.querySelector(".power-o"));
  const ctx = /** @type {CanvasRenderingContext2D} */ (fx.getContext("2d"));
  const sctx = /** @type {CanvasRenderingContext2D} */ (sky.getContext("2d"));
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const phone = matchMedia("(max-width: 760px)");

  // Moments in the clip, in seconds, and places in its 1920x1080 frame.
  const ON = 0.6, IDLE = 2.3, LAUNCH = 4.72, FLIGHT = 0.78;
  const SCREEN = { x0: 806, y0: 505, x1: 1077, y1: 724 };
  const POINT = { x: 945, y: 594 };

  /** @type {"off-screen" | "online" | "switching-off" | "offline"} */
  let mode = "off-screen";
  let flightStart = -1;
  let litStart = -1;
  const glints = Array.from({ length: 22 }, (_, i) => ({ x: Math.random(), y: Math.random() * 0.42, phase: Math.random() * 6.28, speed: 1.2 + Math.random() * 1.6, i }));

  if (still) return; // the poster and the text, as they are

  video.src = (innerWidth <= 900 ? video.dataset.srcSmall : video.dataset.src) ?? "";

  /** Where a point of the clip's frame lands on the canvas (object-fit: cover, bottom-aligned). */
  const map = (/** @type {number} */ x, /** @type {number} */ y) => {
    const w = fx.clientWidth, h = fx.clientHeight;
    const s = Math.max(w / 1920, h / 1080);
    const ox = (w - 1920 * s) / 2, oy = h - 1080 * s;
    return { x: ox + x * s, y: oy + y * s, s };
  };

  const size = () => {
    const d = Math.min(2, devicePixelRatio || 1);
    fx.width = Math.round(fx.clientWidth * d);
    fx.height = Math.round(fx.clientHeight * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    sky.width = 64;
    sky.height = 64;
  };
  size();
  addEventListener("resize", size, { passive: true });

  const play = (/** @type {number} */ from) => {
    video.currentTime = from;
    video.play().catch(() => {});
  };

  new IntersectionObserver(
    ([e]) => {
      if (!e.isIntersecting || mode !== "off-screen") return;
      foot.classList.add("arrived");
      mode = "online";
      play(ON);
    },
    { threshold: 0.35 },
  ).observe(foot);

  button.addEventListener("click", () => {
    if (mode === "online") {
      mode = "switching-off";
      button.setAttribute("aria-pressed", "true");
      play(IDLE);
    } else if (mode === "offline") {
      mode = "online";
      button.setAttribute("aria-pressed", "false");
      play(ON);
    }
    // Clicks while it switches off are ignored.
  });

  const ease = (/** @type {number} */ t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const frame = (/** @type {number} */ now) => {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const t = video.currentTime;
    if (mode === "online" && t >= IDLE) {
      video.pause();
      if (t > IDLE + 0.05) video.currentTime = IDLE;
    }
    if (mode === "switching-off") {
      if (flightStart < 0 && t >= LAUNCH) flightStart = now;
      if (video.ended || t >= video.duration - 0.02) mode = "offline";
    }

    const w = fx.clientWidth, h = fx.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const night = Math.min(1, Math.max(0, (t - 2.7) / 1.7));

    // Glints in the sky: more of them as night falls.
    const count = Math.round(10 + 12 * night);
    for (const g of glints) {
      if (g.i >= count) break;
      const a = 0.5 + 0.5 * Math.sin(now / 1000 * g.speed + g.phase);
      const x = g.x * w, y = g.y * h, r = 2 + 3 * a;
      ctx.globalAlpha = 0.25 + 0.6 * a;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // A soft scanline sweeping down the screen glass while it's on.
    if (mode === "online" && t >= 1.9) {
      const a = map(SCREEN.x0, SCREEN.y0), b = map(SCREEN.x1, SCREEN.y1);
      const band = 52 * a.s;
      const p = ((now / 1800) % 1) * (b.y - a.y + band) - band;
      ctx.save();
      ctx.beginPath();
      ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.clip();
      const grad = ctx.createLinearGradient(0, a.y + p, 0, a.y + p + band);
      const flicker = 0.08 + 0.03 * Math.sin(now / 37);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(0.5, `rgba(255,255,255,${flicker})`);
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(a.x, a.y + p, b.x - a.x, band);
      ctx.restore();
    }

    // The last point of light, flying into the o.
    if (flightStart >= 0) {
      const k = Math.min(1, (now - flightStart) / (FLIGHT * 1000));
      const from = map(POINT.x, POINT.y);
      const fr = fx.getBoundingClientRect(), or = o.getBoundingClientRect();
      const to = { x: or.left + or.width / 2 - fr.left, y: or.top + or.height * 0.6 - fr.top };
      const ctrl = { x: (from.x + to.x) / 2 + 80, y: Math.min(from.y, to.y) - 120 };
      const e = ease(k);
      const x = (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * ctrl.x + e * e * to.x;
      const y = (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * ctrl.y + e * e * to.y;
      const r = 2 + 4 * Math.sin(Math.PI * k);
      const halo = ctx.createRadialGradient(x, y, 0, x, y, r * 6);
      halo.addColorStop(0, "rgba(255,255,255,0.9)");
      halo.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(x, y, r * 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      if (k >= 1) { flightStart = -1; litStart = now; }
    }
    if (litStart >= 0) {
      const k = Math.min(1, (now - litStart) / 900);
      foot.style.setProperty("--lit", String(0.9 * (1 - k)));
      if (k >= 1) litStart = -1;
    }

    // On phones, the sky behind the text follows the clip's own sky.
    if (phone.matches && video.readyState >= 2) {
      try { sctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight * 0.12, 0, 0, 64, 64); } catch {}
    }
  };
  requestAnimationFrame(frame);
}
