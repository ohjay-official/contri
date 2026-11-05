// Staying unlocked, on every kind of browser people use: Android Chrome,
// Android Chrome in desktop mode, iPhone Safari, and Chrome, Edge, Firefox
// and Safari on computers. Each runs in its real engine (Chromium, WebKit,
// Firefox) with the device's screen, touch and user agent.
//
// For each: open Contri, unlock, then
//   1. the tab is dropped (a phone reloads it from the background),
//   2. the browser is closed and opened again,
// and Contri must still be unlocked on the same screen both times. Then
// Removing the key must lock it everywhere.
//
// Unlocking uses a key kept on this device: automated browsers outside
// Chromium can't hold a passkey. The unlocked session is sealed and kept by
// the same code either way (lib/session.js); the passkey path runs in the
// end-to-end test (test/e2e/browser.js).
//
// Usage: node scripts/live-sessions.mjs https://contri.ng [engines]
//   engines: comma-separated, default chromium,webkit,firefox

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, firefox, webkit } from "playwright";

const base = (process.argv[2] || "https://contri.ng").replace(/\/$/, "");
const engines = (process.argv[3] || "chromium,webkit,firefox").split(",");
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const ENGINES = { chromium, webkit, firefox };

const desktopUA = devices["Desktop Chrome"].userAgent;
const PROFILES = [
  { name: "Android phone, Chrome", engine: "chromium", device: devices["Pixel 7"] },
  { name: "Android phone, Chrome in desktop mode", engine: "chromium", device: { ...devices["Pixel 7"], userAgent: desktopUA, isMobile: false } },
  { name: "Computer, Chrome (Windows, Mac, Linux)", engine: "chromium", device: devices["Desktop Chrome"] },
  { name: "Computer, Edge", engine: "chromium", device: devices["Desktop Edge"] },
  { name: "iPhone, Safari", engine: "webkit", device: devices["iPhone 15"] },
  { name: "Mac, Safari", engine: "webkit", device: devices["Desktop Safari"] },
  { name: "Computer, Firefox", engine: "firefox", device: devices["Desktop Firefox"] },
].filter((p) => engines.includes(p.engine));

let failed = 0;
for (const p of PROFILES) {
  const dir = mkdtempSync(join(tmpdir(), "contri-"));
  const type = ENGINES[/** @type {keyof typeof ENGINES} */ (p.engine)];
  // Firefox has no mobile mode; drop what it can't take.
  const { defaultBrowserType, ...device } = /** @type {any} */ (p.device);
  if (p.engine === "firefox") delete device.isMobile;
  const open = () => type.launchPersistentContext(dir, { ...device, proxy, ignoreHTTPSErrors: Boolean(proxy) });
  /** @type {string[]} */
  const problems = [];
  const watch = (/** @type {import("playwright").Page} */ page) => page.on("pageerror", (e) => problems.push(`script error: ${e.message}`));
  /** @param {import("playwright").Page} page @param {string} what */
  const unlockedOnSettings = async (page, what) => {
    // Either settings (unlocked) or the passkey screen (locked); not whatever was showing before.
    // Your key opens without signing in too; unlocked, it offers the recovery code.
    const seen = await page.waitForSelector("button:has-text('Show my recovery code'), h1:text-is('Open Contri'), a:has-text('Open Contri to see your key')", { timeout: 30_000 }).then((e) => e.textContent());
    if (seen !== "Show my recovery code") problems.push(`${what}: shows "${seen}" instead of staying unlocked`);
  };
  /** @type {import("playwright").BrowserContext | null} */
  let ctx = null;
  try {
    ctx = await open();
    let page = ctx.pages()[0] ?? (await ctx.newPage());
    watch(page);
    await page.goto(base + "/app");
    await page.click("summary:has-text('Other ways in')");
    await page.click("text=Keep my key on this device instead");
    await page.click("text=I've written it down");
    await page.waitForSelector("h1:has-text('Your circles')", { timeout: 30_000 });
    await page.goto(base + "/app#/settings");
    await unlockedOnSettings(page, "after unlocking");

    // 1. The tab is dropped and opened again. (The new tab opens first: some
    // engines close a persistent browser when its last tab closes.)
    const next = await ctx.newPage();
    await page.close();
    page = next;
    watch(page);
    await page.goto(base + "/app#/settings");
    await unlockedOnSettings(page, "after the tab was dropped");

    // 2. The browser is closed and opened again.
    await ctx.close();
    ctx = await open();
    page = ctx.pages()[0] ?? (await ctx.newPage());
    watch(page);
    await page.goto(base + "/app#/settings");
    await unlockedOnSettings(page, "after the browser restarted");

    // Removing the key (the lock for a key kept on the device) locks it, here and in a new tab.
    await page.click("text=Remove my key from this device");
    await page.click("button:has-text('Remove it')");
    await page.waitForSelector("h1:has-text('Open Contri')", { timeout: 30_000 });
    const again = await ctx.newPage();
    await again.goto(base + "/app#/settings");
    const seen = await again.waitForSelector("button:has-text('Show my recovery code'), h1:text-is('Open Contri'), a:has-text('Open Contri to see your key')", { timeout: 30_000 }).then((e) => e.textContent());
    if (seen === "Show my recovery code") problems.push("after locking, a new tab still shows the recovery code button");
    await ctx.close();
  } catch (e) {
    problems.push(e instanceof Error ? e.message.split("\n")[0] : String(e));
    await ctx?.close().catch(() => null);
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // A browser still holding a file: the temporary folder is left behind.
  }
  if (problems.length) failed++;
  console.log(`${problems.length ? "FAIL" : "ok  "} ${p.name} (${p.engine})`);
  for (const x of problems) console.log(`       ${x}`);
}
console.log(failed ? `\n${failed} browser(s) didn't stay unlocked` : "\nunlocked through a dropped tab and a browser restart, everywhere");
process.exit(failed ? 1 : 0);
