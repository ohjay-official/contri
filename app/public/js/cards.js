// @ts-check
// How it works: the steps of a circle as cards turning on a horizontal
// cylinder. One card rests in front, the next ones fold away above and below
// and roll off the screen, and the front card leans toward the pointer. Each
// card has real thickness (thin slices stacked a fraction of a pixel apart), a
// video front and a blurred back with the step's details.

const space = /** @type {HTMLElement | null} */ (document.querySelector(".card-space"));
if (space) cards(space);

/** @param {HTMLElement} space */
function cards(space) {
  const stage = /** @type {HTMLElement} */ (space.parentElement);
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const STEPS = [
    { title: "Start a circle", line: "01 · START A CIRCLE", sub: "AMOUNT · MEMBERS · HOW OFTEN" },
    { title: "Everyone pays in", line: "02 · EVERYONE PAYS IN", sub: "FROM ANY EXCHANGE OR WALLET" },
    { title: "The pot pays out", line: "03 · THE POT PAYS OUT", sub: "TO WHOEVER'S TURN IT IS" },
    { title: "Swap turns", line: "04 · SWAP TURNS", sub: "BUY AN EARLIER TURN" },
    { title: "Deposits come back", line: "05 · DEPOSITS COME BACK", sub: "WHEN THE LAST TURN IS PAID" },
  ];
  const N = STEPS.length;
  const LAYERS = [-1.47, -0.73, 0, 0.73, 1.47];
  const D = 1350;
  let cardW = 336, cardH = 211;
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  let progress = 0;
  // Dragging (or swiping) moves the cards by hand; a tap jumps to the next one.
  let drag = /** @type {{ y: number, p: number, moved: boolean } | null} */ (null);
  let target = -1;

  const chip = (/** @type {number} */ i) => `<svg class="cc-chip" viewBox="0 0 60 60" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M20 8H40V14C40.0016 14.5299 40.2128 15.0377 40.5875 15.4125C40.9623 15.7872 41.4701 15.9984 42 16H59V24H42C41.4701 24.0016 40.9623 24.2128 40.5875 24.5875C40.2128 24.9623 40.0016 25.4701 40 26V52H20V8ZM18 8H8.00039C4.47435 8 1.56576 10.6083 1.08 14H18V8ZM1 16V24V26V34V36V44H18V36H1V34H18V26H1V24H18V16H1ZM1.08 46C1.56576 49.3917 4.47435 52 8.00039 52H18V46H1.08ZM42 14V8H52.0004C55.5264 8 58.4342 10.6084 58.92 14H42ZM59 26H42V34H59V26ZM59 36H42V44H59V36ZM52.0004 52H42V46H58.92C58.4342 49.3916 55.5264 52 52.0004 52Z" fill="url(#cc-g${i})"/><defs><linearGradient id="cc-g${i}" x1="30" y1="8" x2="30" y2="52" gradientUnits="userSpaceOnUse"><stop stop-color="white"/><stop offset="1" stop-color="#999999"/></linearGradient></defs></svg>`;

  const els = STEPS.map((step, i) => {
    const card = document.createElement("div");
    card.className = "cc";
    for (const [n, z] of LAYERS.entries()) {
      const layer = document.createElement("div");
      layer.style.transform = `translateZ(${z}px)${n === 0 ? " rotateX(180deg)" : ""}`;
      if (n === LAYERS.length - 1) {
        layer.className = "cc-face cc-front";
        const v = document.createElement("video");
        v.src = `/media/card${i + 1}.mp4`;
        v.poster = `/media/card${i + 1}.jpg`;
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.autoplay = !still;
        v.setAttribute("playsinline", "");
        layer.append(v);
        const top = document.createElement("div");
        top.className = "cc-top";
        top.innerHTML = `${chip(i)}<span class="cc-brand">Contri</span><span class="cc-step">${step.title}</span><span class="cc-rings"><i></i><i></i></span>`;
        layer.append(top);
      } else if (n === 0) {
        layer.className = "cc-face cc-back";
        layer.innerHTML = `<div class="cc-blur"></div><div class="cc-stripe"></div><div class="cc-details"><div class="cc-num">${step.line}</div><div class="cc-sub">${step.sub}</div></div>`;
        /** @type {HTMLElement} */ (layer.querySelector(".cc-blur")).style.backgroundImage = `url(/media/card${i + 1}.jpg)`;
      } else {
        layer.className = "cc-slice";
      }
      card.append(layer);
    }
    space.append(card);
    return card;
  });

  const resize = () => {
    const w = innerWidth, h = stage.clientHeight || innerHeight;
    let cw = Math.round(w * 0.16 + 130) * Math.min(1, Math.max(0.65, h / 850));
    cw = Math.min(336, Math.max(150, Math.round(cw)));
    cardW = cw;
    cardH = Math.round(cw / 1.5925);
    space.style.width = `${cardW}px`;
    space.style.height = `${cardH}px`;
    for (const c of els) {
      c.style.width = `${cardW}px`;
      c.style.height = `${cardH}px`;
    }
  };
  resize();
  addEventListener("resize", resize, { passive: true });
  addEventListener("mousemove", (e) => {
    mouse.tx = Math.max(-1, Math.min(1, (e.clientX - innerWidth / 2) / (innerWidth / 2)));
    mouse.ty = Math.max(-1, Math.min(1, (e.clientY - innerHeight / 2) / (innerHeight / 2)));
  });
  document.addEventListener("mouseleave", () => (mouse.tx = mouse.ty = 0));

  const ss = (/** @type {number} */ t) => t * t * (3 - 2 * t);

  const scene = /** @type {HTMLElement} */ (stage.closest(".card-scene") ?? stage);
  scene.addEventListener("pointerdown", (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest("a, button")) return;
    drag = { y: e.clientY, p: progress, moved: false };
    target = -1;
  });
  addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 6) drag.moved = true;
    // A finger scrolls the page; only a mouse drags the cards.
    if (e.pointerType === "mouse") progress = drag.p - dy / (cardH + 36);
  });
  addEventListener("pointercancel", () => (drag = null));
  addEventListener("pointerup", () => {
    if (!drag) return;
    target = drag.moved ? Math.round(progress) : Math.round(progress) + 1;
    drag = null;
  });
  // Buttons for the steps, and the step showing now.
  const go = (/** @type {number} */ by) => (target = (target >= 0 ? target : Math.round(progress)) + by);
  document.querySelector(".cs-prev")?.addEventListener("click", () => go(-1));
  document.querySelector(".cs-next")?.addEventListener("click", () => go(1));
  const counter = document.querySelector(".cs-count");
  const label = document.querySelector(".cs-step");
  let shown = -1;

  const render = () => {
    if (drag) {
      // held by the pointer
    } else if (target !== -1) {
      progress += (target - progress) * 0.12;
      if (Math.abs(target - progress) < 0.001) {
        progress = target;
        target = -1;
      }
    } else if (!still) progress += 0.009;
    mouse.x += (mouse.tx - mouse.x) * 0.08;
    mouse.y += (mouse.ty - mouse.y) * 0.08;
    const h = stage.clientHeight || innerHeight;
    const rounded = Math.round(progress);
    const diff = progress - rounded;
    // A brief rest with each card in front, then on to the next.
    const active = drag || target !== -1 ? progress : rounded + (Math.sign(diff) * Math.pow(Math.abs(diff) * 2, 4.2)) / 2;
    const front = ((Math.round(active) % N) + N) % N;
    if (front !== shown && counter && label) {
      shown = front;
      counter.textContent = `0${front + 1} / 0${N}`;
      label.textContent = STEPS[front].title;
    }
    for (let i = 0; i < N; i++) {
      const card = els[i];
      let offset = i - active;
      while (offset > N / 2) offset -= N;
      while (offset < -N / 2) offset += N;
      const abs = Math.abs(offset), sign = Math.sign(offset);
      if (abs > 3) {
        card.style.visibility = "hidden";
        continue;
      }
      card.style.visibility = "visible";
      const gap = 36, peek = -55;
      let y = 0, z = 0, rot = 0;
      if (abs <= 1) {
        const e = ss(abs);
        y = -sign * e * (cardH + gap);
        z = 400 + e * (220 - 400);
        rot = e * 132;
      } else if (abs <= 2) {
        const e = ss(abs - 1);
        const yEnd = (h / 2 - peek) / (D / (D + 60)) - cardH / 2;
        y = -sign * (cardH + gap + e * (yEnd - cardH - gap));
        z = 220 + e * (-60 - 220);
        rot = 132 + e * (175 - 132);
      } else {
        const e = ss(Math.min(abs - 2, 1));
        const y2 = (h / 2 - peek) / (D / (D + 60)) - cardH / 2;
        const y3 = (h / 2 + 100) / (D / (D + 250)) + cardH / 2;
        y = -sign * (y2 + e * (y3 - y2));
        z = -60 + e * (-250 + 60);
        rot = 175 + e * (195 - 175);
      }
      const centre = Math.max(0, 1 - abs);
      const rx = -sign * rot + -mouse.y * 12 * centre;
      const ry = mouse.x * 15 * centre;
      card.style.zIndex = String(Math.round(z));
      card.style.transform = `translateY(${y.toFixed(2)}px) translateZ(${z.toFixed(2)}px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) rotateZ(-3deg)`;
    }
  };

  let onScreen = true;
  new IntersectionObserver(([e]) => (onScreen = e.isIntersecting)).observe(stage);
  const tick = () => {
    if (onScreen && !document.hidden) render();
    requestAnimationFrame(tick);
  };
  render();
  requestAnimationFrame(tick);
}
