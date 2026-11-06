// Films the real site frame by frame on a controlled clock, so every
// animation (canvas, CSS, video) lands exactly on each 30 fps frame.
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
export const events = [];

export const FPS = 30;
export const DT = 1000 / FPS;
export const BASE = "http://localhost:8787";
export const CODE = process.env.CODE;

export async function open({ width = 1440, height = 900, scale = Number(process.env.SCALE ?? 1.25), mobile = false } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date("2026-11-05T12:00:00Z") });
  // Stop real time leaking in: the clock moves only when a frame is stepped.
  await page.clock.pauseAt(new Date("2026-11-05T12:00:01Z"));
  return { browser, ctx, page };
}

/** Advance every clock by one frame: timers and rAF, CSS animations, videos. */
export async function step(page, ms = DT) {
  await page.clock.runFor(ms);
  await page.evaluate((ms) => {
    for (const a of document.getAnimations()) {
      if (a.playState === "finished") continue;
      const was = a.currentTime ?? 0;
      a.pause();
      a.currentTime = was + ms;
    }
    const waits = [];
    for (const v of document.querySelectorAll("video")) {
      if (!v.src && !v.currentSrc) continue;
      const rate = v.playbackRate || 1;
      if (!v.paused) { v.pause(); v.dataset.filmPlaying = "1"; }
      if (v.dataset.filmPlaying === "1" && v.readyState >= 1) {
        const d = v.duration || 0;
        let t = v.currentTime + (ms / 1000) * rate;
        if (d && t >= d) t = v.loop ? t % d : d - 0.01;
        v.currentTime = t;
        waits.push(new Promise((r) => { v.addEventListener("seeked", r, { once: true }); setTimeout(r, 400); }));
      }
    }
    return Promise.all(waits);
  }, ms);
}

/** A clip: frames written to dir as JPEG. */
export class Clip {
  constructor(page, dir) {
    this.page = page; this.dir = dir; this.n = 0; this.events = [];
    this.name = dir.split("/").pop(); events.push(this);
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  }
  async shoot() {
    await this.page.screenshot({ path: `${this.dir}/${String(this.n++).padStart(5, "0")}.jpg`, type: "jpeg", quality: 90 });
  }
  /** Run `frames` frames, calling each(i) before stepping. */
  async run(frames, each) {
    for (let i = 0; i < frames; i++) {
      if (each) await each(i, frames);
      await step(this.page);
      await this.shoot();
    }
  }
  async hold(seconds) { await this.run(Math.round(seconds * FPS)); }
}

export const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const easeOut = (x) => 1 - Math.pow(1 - x, 3);

/** Scroll smoothly from the current position to y over seconds. */
export async function scrollTo(clip, y, seconds, curve = ease) {
  const from = await clip.page.evaluate(() => scrollY);
  const frames = Math.round(seconds * FPS);
  await clip.run(frames, async (i) => {
    const t = curve((i + 1) / frames);
    await clip.page.evaluate((v) => scrollTo(0, v), from + (y - from) * t);
  });
}

/** Type text into a field a character every other frame. */
export async function type(clip, locator, text) {
  await locator.click();
  for (const ch of text) {
    await locator.pressSequentially(ch);
    await step(clip.page); await clip.shoot();
    await step(clip.page); await clip.shoot();
  }
}

export function saveEvents() {
  mkdirSync("events", { recursive: true });
  for (const c of events.splice(0)) writeFileSync(`events/${c.name}.json`, JSON.stringify(c.events));
}
