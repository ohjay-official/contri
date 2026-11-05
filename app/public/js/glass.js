// @ts-check
// The privacy page's glass card and its menu.
//
// The card is a window onto a refracted copy of the background video: every
// frame, a canvas the size of the viewport is placed so its pixels line up
// with the real video behind the card, the current frame is drawn into it, and
// an SVG filter bends it at the card's edges. The card's rounded, clipped box
// does the rest.

const video = /** @type {HTMLVideoElement | null} */ (document.getElementById("bg-video"));
const card = /** @type {HTMLElement | null} */ (document.querySelector("[data-glass-card]"));
const holder = /** @type {HTMLElement | null} */ (card?.querySelector(".dup") ?? null);
const canvas = /** @type {HTMLCanvasElement | null} */ (card?.querySelector(".dup__image") ?? null);
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (video && card && holder && canvas) {
  const ctx = canvas.getContext("2d");
  // The copy is sized to the viewport, not the card: the filter shifts each
  // colour channel by a different amount, so the copy's own edges show hard
  // bands; at viewport size they fall outside the card. It stays at 1x on
  // high-density screens: the filter's cost grows with pixels, and a soft
  // refraction gains nothing from more of them.
  const frame = () => {
    const rect = card.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    if (ctx && rect.width && rect.height && video.videoWidth && video.videoHeight && rect.bottom > 0 && rect.top < vh) {
      holder.style.left = `${-rect.left}px`;
      holder.style.top = `${-rect.top}px`;
      holder.style.width = `${vw}px`;
      holder.style.height = `${vh}px`;
      if (canvas.width !== vw || canvas.height !== vh) {
        canvas.width = vw;
        canvas.height = vh;
      }
      const cover = Math.max(vw / video.videoWidth, vh / video.videoHeight);
      const sw = vw / cover, sh = vh / cover;
      const sx = (video.videoWidth - sw) / 2, sy = (video.videoHeight - sh) / 2;
      try {
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, vw, vh);
      } catch {
        // A frame that can't be decoded yet; the next one will do.
      }
    }
    if (!still) requestAnimationFrame(frame);
  };
  if (still) video.addEventListener("loadeddata", frame, { once: true });
  requestAnimationFrame(frame);
}

// ---------- The menu ----------

const menu = document.getElementById("menu");
const open = /** @type {HTMLButtonElement | null} */ (document.getElementById("menu-open"));
const close = /** @type {HTMLButtonElement | null} */ (document.getElementById("menu-close"));
if (menu && open && close) {
  /** @param {boolean} on */
  const setMenu = (on) => {
    menu.classList.toggle("is-open", on);
    open.setAttribute("aria-expanded", String(on));
    (on ? close : open).focus({ preventScroll: true });
  };
  open.addEventListener("click", () => setMenu(true));
  close.addEventListener("click", () => setMenu(false));
  document.getElementById("menu-backdrop")?.addEventListener("click", () => setMenu(false));
  for (const a of menu.querySelectorAll(".menu__link")) a.addEventListener("click", () => setMenu(false));
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.classList.contains("is-open")) setMenu(false);
  });
}
