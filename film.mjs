// node film.mjs <clip>...   Films each named clip of the real site into frames/<clip>/.
import { open, Clip, BASE, FPS, step, scrollTo, ease, easeOut, saveEvents } from "./lib.mjs";

const CODE = "k7Fa-K87W-HGVX-zkao-Hb7C-dVPg-kKDQ-hZ29-VLDe-BVbD-fYn";

// A pointer drawn into the page, so clicks read on screen.
const CURSOR = `(() => {
  const c = document.createElement("div");
  c.id = "film-cursor";
  c.innerHTML = '<div class="r"></div><svg width="36" height="36" viewBox="0 0 24 24"><path d="M5 2.5 L5 19.5 L9.4 15.4 L12.3 21.6 L15.1 20.3 L12.3 14.3 L18.2 14.3 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const s = document.createElement("style");
  s.textContent = "#film-cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform;filter:drop-shadow(0 3px 6px rgba(0,0,0,.45))}#film-cursor svg{position:absolute;left:-5px;top:-3px}#film-cursor .r{position:absolute;left:-26px;top:-26px;width:52px;height:52px;border-radius:50%;border:2px solid rgba(255,140,90,.9);background:rgba(255,122,76,.18);opacity:0}";
  document.documentElement.append(s, c);
})()`;

async function cursorAt(page, x, y, ring = 0) {
  await page.evaluate(([x, y, ring]) => {
    if (!document.getElementById("film-cursor")) return;
    const c = document.getElementById("film-cursor");
    c.style.transform = `translate(${x}px, ${y}px)`;
    const r = c.querySelector(".r");
    r.style.opacity = ring > 0 ? String(1 - ring) : "0";
    r.style.transform = `scale(${0.4 + ring * 0.9})`;
  }, [x, y, ring]);
}

class Pointer {
  constructor(clip, x = 900, y = 700) { this.clip = clip; this.x = x; this.y = y; }
  async show() { await this.clip.page.evaluate(CURSOR); await cursorAt(this.clip.page, this.x, this.y); }
  async center(locator) {
    const b = await locator.boundingBox();
    return [b.x + Math.min(b.width / 2, 120), b.y + b.height / 2];
  }
  async move(locator, seconds = 0.6) {
    const [tx, ty] = await this.center(locator);
    const fx = this.x, fy = this.y, n = Math.round(seconds * FPS);
    await this.clip.run(n, async (i) => {
      const t = ease((i + 1) / n);
      // A slight arc, like a hand.
      const arc = Math.sin(t * Math.PI) * 30;
      this.x = fx + (tx - fx) * t; this.y = fy + (ty - fy) * t - arc;
      await this.clip.page.mouse.move(this.x, this.y);
      await cursorAt(this.clip.page, this.x, this.y);
    });
    this.x = tx; this.y = ty;
  }
  async click(locator, seconds = 0.6) {
    await this.move(locator, seconds);
    const page = this.clip.page;
    for (let i = 0; i < 4; i++) { await cursorAt(page, this.x, this.y, (i + 1) / 10); await step(page); await this.clip.shoot(); }
    this.clip.events.push({ type: "click", f: this.clip.n });
    await locator.click({ noWaitAfter: true, timeout: 5000 });
    for (let i = 4; i < 10; i++) { await cursorAt(page, this.x, this.y, (i + 1) / 10); await step(page); await this.clip.shoot(); }
    await cursorAt(page, this.x, this.y, 0);
  }
  async hide() { await this.clip.page.evaluate(() => document.getElementById("film-cursor")?.remove()); }
}

/** Step the clock without filming until a selector shows (data loading). */
async function settle(page, selector, max = 300) {
  for (let i = 0; i < max; i++) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) break;
    await step(page); await page.waitForTimeout(20);
  }
  for (let i = 0; i < 10; i++) await step(page);
}

async function typeIn(clip, locator, text) {
  await locator.focus();
  await locator.fill("");
  for (const ch of text) {
    clip.events.push({ type: "key", f: clip.n });
    await locator.pressSequentially(ch);
    await step(clip.page); await clip.shoot();
    await step(clip.page); await clip.shoot();
  }
}

const offset = (page, sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().top + scrollY, sel);

const clips = {
  async hero() {
    const { browser, page } = await open();
    await page.goto(BASE + "/", { waitUntil: "load" });
    for (let i = 0; i < 6; i++) await step(page);
    const clip = new Clip(page, "frames/hero");
    await clip.hold(6.8);
    await browser.close();
  },

  async scroll() {
    const { browser, page } = await open();
    await page.goto(BASE + "/", { waitUntil: "load" });
    for (let i = 0; i < 40; i++) await step(page);
    const clip = new Clip(page, "frames/scroll");
    const stops = [];
    for (const s of ["#security", "#ways", "#steps", "#proof", "#privacy", "#faq"]) stops.push((await offset(page, s)) - 110);
    await clip.hold(0.3);
    for (const y of stops) {
      await scrollTo(clip, y, 0.85);
      await clip.hold(0.75);
    }
    await browser.close();
  },

  async proof() {
    const { browser, page } = await open();
    await page.goto(BASE + "/", { waitUntil: "load" });
    const y = (await offset(page, "#proof")) - 60;
    await page.evaluate((y) => scrollTo(0, y), y);
    for (let i = 0; i < 60; i++) await step(page);
    const clip = new Clip(page, "frames/proof");
    await scrollTo(clip, y + 420, 4.5, (x) => x);
    await browser.close();
  },

  async tv() {
    const { browser, page } = await open();
    await page.goto(BASE + "/", { waitUntil: "load" });
    const y = (await offset(page, ".scene-foot")) - 900 * 0.35;
    await page.evaluate((y) => scrollTo(0, y), y);
    for (let i = 0; i < 30; i++) { await step(page); await page.waitForTimeout(30); }
    const clip = new Clip(page, "frames/tv");
    const end = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    await scrollTo(clip, end, 1.2, easeOut);
    await clip.hold(4.6);
    await browser.close();
  },

  async appA() {
    const { browser, ctx, page } = await open();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
    await page.goto(BASE + "/app#/", { waitUntil: "load" });
    await settle(page, "text=Create a passkey");
    const clip = new Clip(page, "frames/appA");
    const ptr = new Pointer(clip, 1000, 640);
    await ptr.show();
    await clip.hold(0.5);
    await ptr.click(page.getByRole("button", { name: "Create a passkey" }), 0.8);
    // The passkey resolves, then home.
    for (let i = 0; i < 200 && !(await page.getByText("Start a circle").first().isVisible().catch(() => false)); i++) { await step(page); await page.waitForTimeout(20); }
    await clip.hold(0.6);
    await ptr.click(page.getByText("Start a circle").first(), 0.6);
    await clip.hold(0.3);
    const inputs = page.locator("form input");
    await ptr.move(inputs.nth(0), 0.4);
    await typeIn(clip, inputs.nth(0), "Ikeja friends");
    await ptr.move(inputs.nth(1), 0.35);
    await typeIn(clip, inputs.nth(1), "5");
    const selects = page.locator("form select");
    await ptr.move(selects.nth(1), 0.4);
    const opts = await selects.nth(1).locator("option").allTextContents();
    await selects.nth(1).selectOption({ label: opts.find((o) => /week/i.test(o)) ?? opts[1] });
    await clip.hold(0.4);
    await ptr.click(page.getByRole("button", { name: "Continue" }), 0.6);
    await clip.hold(0.6);
    await browser.close();
    return true;
  },

  async appB() {
    // Continues from a fresh start of the same flow, unfilmed up to the deposit page.
    const { browser, ctx, page } = await open();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
    await page.goto(BASE + "/app#/", { waitUntil: "load" });
    await settle(page, "text=Create a passkey");
    await page.getByRole("button", { name: "Create a passkey" }).click();
    for (let i = 0; i < 200 && !(await page.getByText("Start a circle").first().isVisible().catch(() => false)); i++) { await step(page); await page.waitForTimeout(20); }
    await page.goto(BASE + "/app#/new"); await settle(page, "form input");
    const inputs = page.locator("form input");
    await inputs.nth(0).fill("Ikeja friends"); await inputs.nth(1).fill("5");
    const selects = page.locator("form select");
    const opts = await selects.nth(1).locator("option").allTextContents();
    await selects.nth(1).selectOption({ label: opts.find((o) => /week/i.test(o)) ?? opts[1] });
    await page.getByRole("button", { name: "Continue" }).click();
    await settle(page, "text=Get a deposit address");
    const clip = new Clip(page, "frames/appB");
    const ptr = new Pointer(clip, 900, 500);
    await ptr.show();
    await clip.hold(0.5);
    const net = page.getByText("USDT on BNB Smart Chain (BEP20)");
    const y = await net.evaluate((el) => el.getBoundingClientRect().top + scrollY - 220);
    await scrollTo(clip, y, 0.9);
    await ptr.click(page.getByText("USDT on Solana"), 0.6);
    await clip.hold(0.3);
    await ptr.click(page.getByText("USDT on BNB Smart Chain (BEP20)"), 0.5);
    const btn = page.getByRole("button", { name: "Get a deposit address" });
    const by = await btn.evaluate((el) => el.getBoundingClientRect().top + scrollY - 260);
    await scrollTo(clip, by, 0.6);
    // The app scrolls to the address on its own; here the film does that scroll, smoothly.
    await page.evaluate(() => { Element.prototype.scrollIntoView = function () {}; });
    await ptr.click(btn, 0.5);
    for (let i = 0; i < 100 && !(await page.getByRole("button", { name: "Copy address" }).isVisible().catch(() => false)); i++) { await step(page); await clip.shoot(); if (i > 12) break; }
    const ay = await page.getByRole("button", { name: "Copy address" }).evaluate((el) => el.getBoundingClientRect().top + scrollY - 380);
    await scrollTo(clip, ay, 0.8);
    await clip.hold(0.8);
    await ptr.move(page.getByRole("button", { name: "Copy address" }), 0.5);
    await clip.hold(0.4);
    // The payment arrives: unfilmed wait, then the screen it lands on.
    for (let i = 0; i < 400 && !(await page.getByText("Your money is here").isVisible().catch(() => false)); i++) { await step(page); await page.waitForTimeout(25); }
    await page.evaluate(() => scrollTo(0, 0));
    await step(page);
    await clip.hold(0.8);
    await ptr.click(page.getByRole("button", { name: /Create circle and pay/ }), 0.6);
    for (let i = 0; i < 400 && !(await page.getByText(/Share invite|Send on WhatsApp|Copy invite/).first().isVisible().catch(() => false)); i++) { await step(page); await page.waitForTimeout(25); }
    for (let i = 0; i < 10; i++) await step(page);
    // Production serves the invite from contri.ng; this film runs on a local copy.
    await page.evaluate(() => { for (const el of document.querySelectorAll("input, code, p, span, a")) { if (el.value?.includes("localhost:8787")) el.value = el.value.replace("http://localhost:8787", "https://contri.ng"); if (el.childElementCount === 0 && el.textContent.includes("localhost:8787")) el.textContent = el.textContent.replace("http://localhost:8787", "https://contri.ng"); } });
    const sy = await page.getByText(/Send on WhatsApp|Share invite/).first().evaluate((el) => Math.max(0, el.getBoundingClientRect().top + scrollY - 520));
    await page.evaluate((y) => scrollTo(0, y), sy);
    await clip.hold(0.6);
    await ptr.move(page.getByText(/Send on WhatsApp|Share invite/).first(), 0.6);
    await clip.hold(1.4);
    await browser.close();
  },

  async circle() {
    const { browser, page } = await open();
    await page.goto(BASE + "/app#/", { waitUntil: "load" });
    await settle(page, "text=Other ways in");
    await page.getByText("Other ways in").click();
    await page.getByText("Restore from a recovery code").click();
    await page.locator("textarea").fill(CODE);
    await page.getByRole("button", { name: "Restore" }).click();
    await settle(page, "text=Start a circle");
    // This phone holds both invites, and has named the members it knows.
    await page.evaluate(async () => {
      const w = await import("/js/app/wallet.js");
      const secret = w.encodeSecret(new Uint8Array(32).fill(5));
      await w.remember(0, { secret, circle: 0 });
      await w.remember(1, { secret, circle: 1 });
    });
    await page.goto(BASE + "/app#/c/0"); await settle(page, ".dial, svg circle, text=Members");
    for (let i = 0; i < 40; i++) await step(page);
    await page.evaluate(async () => {
      const w = await import("/js/app/wallet.js");
      const other = (n) => Array.from({ length: 64 }, (_, i) => ((n * 2654435761 + i * 40503 + (i * i * n) % 977) >>> 3) % 16).map((d) => d.toString(16)).join("");
      const names = { 10: "Adaeze", 11: "Bayo", 12: "Chioma", 13: "Emeka" };
      for (const [n, name] of Object.entries(names)) await w.setLabel(other(Number(n)), name);
    });
    await page.goto(BASE + "/app#/"); await settle(page, "text=Start a circle");
    await page.goto(BASE + "/app#/c/0"); await settle(page, "text=Members");
    for (let i = 0; i < 40; i++) await step(page);
    const clip = new Clip(page, "frames/circle");
    await clip.hold(2.2);
    const seat = await page.getByText("Your seat").evaluate((el) => el.getBoundingClientRect().top + scrollY - 260);
    await scrollTo(clip, seat, 0.9);
    await clip.hold(1.2);
    const swap = await page.getByText("Swap turns").evaluate((el) => el.getBoundingClientRect().top + scrollY - 200);
    await scrollTo(clip, swap, 0.9);
    const ptr = new Pointer(clip, 1100, 600);
    await ptr.show();
    await ptr.move(page.getByRole("button", { name: /Buy turn/ }), 0.8);
    await clip.hold(1.4);
    await browser.close();
  },

  async how() {
    const { browser, page } = await open();
    await page.goto(BASE + "/how-it-works", { waitUntil: "load" });
    for (let i = 0; i < 20; i++) { await step(page); await page.waitForTimeout(30); }
    const clip = new Clip(page, "frames/how");
    await clip.hold(2.2);
    const ptr = new Pointer(clip, 1000, 700); await ptr.show();
    await ptr.click(page.locator(".cs-next"), 0.6);
    await clip.hold(1.0);
    await ptr.click(page.locator(".cs-next"), 0.3);
    await clip.hold(1.2);
    await browser.close();
  },

  async privacy() {
    const { browser, page } = await open();
    await page.goto(BASE + "/privacy", { waitUntil: "load" });
    for (let i = 0; i < 30; i++) await step(page);
    const clip = new Clip(page, "frames/privacy");
    await clip.hold(5.2);
    await browser.close();
  },

  async explore() {
    const { browser, page } = await open();
    await page.goto(BASE + "/app#/explore", { waitUntil: "load" });
    for (let i = 0; i < 20; i++) { await step(page); await page.waitForTimeout(30); }
    const clip = new Clip(page, "frames/explore");
    await clip.hold(1.6);
    const y = await page.evaluate(() => { const el = document.querySelector(".explore-list"); return el ? el.getBoundingClientRect().top + scrollY - 120 : 900; });
    await scrollTo(clip, y, 1.2);
    await clip.hold(2.0);
    await browser.close();
  },

  async key() {
    const { browser, page } = await open();
    await page.goto(BASE + "/app#/settings", { waitUntil: "load" });
    for (let i = 0; i < 30; i++) { await step(page); await page.waitForTimeout(20); }
    const clip = new Clip(page, "frames/key");
    const ptr = new Pointer(clip, 300, 800); await ptr.show();
    await ptr.move(page.locator(".kcard-left"), 0.7);
    await clip.hold(0.7);
    await ptr.move(page.locator(".kcard-right"), 0.8);
    await clip.hold(1.4);
    await browser.close();
  },

  async help() {
    const { browser, page } = await open();
    await page.goto(BASE + "/app#/help", { waitUntil: "load" });
    for (let i = 0; i < 20; i++) { await step(page); await page.waitForTimeout(30); }
    const clip = new Clip(page, "frames/help");
    await clip.hold(1.2);
    await scrollTo(clip, 380, 1.6);
    await clip.hold(0.6);
    await browser.close();
  },
};

for (const name of process.argv.slice(2)) {
  const t0 = Date.now();
  try { await clips[name](); saveEvents(); console.log(name, "done", Math.round((Date.now() - t0) / 1000) + "s"); }
  catch (e) { console.log(name, "FAILED", e.message.split("\n")[0]); }
}
