// @ts-check
// The privacy page: its lens, and its menu.

// ---------- The privacy lens ----------
// The same circle twice: as its members see it, and as anyone on the
// blockchain sees it. The second sits inside a glass lens that follows the
// pointer (or a finger, or drifts by itself until touched) and magnifies a
// little, like a loupe.

const field = /** @type {HTMLElement | null} */ (document.querySelector(".lens-field"));
const lens = /** @type {HTMLElement | null} */ (field?.querySelector(".lens") ?? null);
const content = /** @type {HTMLElement | null} */ (lens?.querySelector(".lens-content") ?? null);
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (field && lens && content) {
  let x = 0.62, y = 0.45, tx = x, ty = y;
  let touched = false;
  const place = () => {
    const w = field.clientWidth, h = field.clientHeight;
    const r = lens.offsetWidth / 2;
    const px = x * w, py = y * h;
    lens.style.transform = `translate(${px - r}px, ${py - r}px)`;
    // A slight magnification around the lens's centre, like a loupe.
    content.style.transformOrigin = `${px}px ${py}px`;
    content.style.transform = `translate(${r - px}px, ${r - py}px) scale(1.12)`;
    content.style.width = `${w}px`;
    content.style.height = `${h}px`;
  };
  const point = (/** @type {PointerEvent} */ e) => {
    const b = field.getBoundingClientRect();
    tx = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width));
    ty = Math.min(1, Math.max(0, (e.clientY - b.top) / b.height));
    touched = true;
  };
  field.addEventListener("pointermove", point);
  field.addEventListener("pointerdown", (e) => {
    point(e);
    field.setPointerCapture(e.pointerId);
  });
  const loop = (/** @type {number} */ now) => {
    if (!touched && !still) {
      tx = 0.5 + 0.32 * Math.sin(now / 2600);
      ty = 0.5 + 0.26 * Math.sin(now / 1900 + 1);
    }
    x += (tx - x) * (still ? 1 : 0.12);
    y += (ty - y) * (still ? 1 : 0.12);
    place();
    if (!still) requestAnimationFrame(loop);
  };
  addEventListener("resize", place, { passive: true });
  requestAnimationFrame(loop);
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
