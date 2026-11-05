// Opens the live site in a real browser (Chromium, phone-sized) and goes
// through every screen a member sees, the way a member would: the site pages,
// signing in with a key on this device, home and the private balance, live
// circles, a circle, an invite link, starting a circle, the add-money and
// private-balance screens with real 1Click deposit addresses, moving money
// out, and settings. Nothing is paid or signed for money.
//
// Fails on anything a member would hit: a script error, a blocked resource
// (Content Security Policy), a failed request, an error notice, or a screen
// that doesn't render. Screenshots go to the folder given as the second
// argument.
//
// Usage: node scripts/live-browser.mjs https://contri.ng [out-dir]

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const base = (process.argv[2] || "https://contri.ng").replace(/\/$/, "");
const out = process.argv[3] || "live-shots";
mkdirSync(out, { recursive: true });

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({ proxy });
let failed = 0;

/** @param {import("playwright").BrowserContextOptions} [opts] */
async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: Boolean(proxy), ...opts });
  const page = await ctx.newPage();
  /** @type {string[]} */
  const problems = [];
  page.on("pageerror", (e) => problems.push(`script error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("requestfailed", (r) => {
    // A video the browser stops fetching (the page moved on, or it only needed the start) isn't a fault.
    if (r.resourceType() === "media" && r.failure()?.errorText === "net::ERR_ABORTED") return;
    problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`);
  });
  page.on("response", (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`));
  return { ctx, page, problems };
}

/**
 * One screen: run `go`, then report problems seen since the last screen.
 * @param {{ page: import("playwright").Page, problems: string[] }} s @param {string} name @param {() => Promise<unknown>} go
 */
async function screen(s, name, go) {
  s.problems.length = 0;
  let error = "";
  try {
    await go();
    await s.page.waitForTimeout(400);
    const notice = await s.page.locator(".notice.error").first().textContent({ timeout: 300 }).catch(() => null);
    if (notice) error = `error notice: ${notice}`;
  } catch (e) {
    error = e instanceof Error ? e.message.split("\n")[0] : String(e);
  }
  await s.page.screenshot({ path: `${out}/${name}.png`, fullPage: true }).catch(() => null);
  const problems = [...s.problems, ...(error ? [error] : [])];
  if (problems.length) failed++;
  console.log(`${problems.length ? "FAIL" : "ok  "} ${name}`);
  for (const p of problems) console.log(`       ${p}`);
}

// ---- The site ----
const site = await open();
for (const [name, path] of [["site-home", "/"], ["site-how", "/how-it-works"], ["site-privacy", "/privacy"], ["site-terms", "/terms"], ["site-404", "/no-such-page"]]) {
  await screen(site, name, async () => {
    const r = await site.page.goto(base + path);
    if (path === "/no-such-page") site.problems.splice(0); // the 404 itself is expected
    else if (!r?.ok()) throw new Error(`HTTP ${r?.status()}`);
    await site.page.waitForSelector("h1");
  });
}
for (const [name, scheme] of [["site-home-dark", "dark"]]) {
  const dark = await open({ colorScheme: /** @type {"dark"} */ (scheme) });
  await screen(dark, name, () => dark.page.goto(base + "/").then(() => dark.page.waitForSelector("h1")));
  await dark.ctx.close();
}
await site.ctx.close();

// ---- The app, as a new member with a key on this device ----
const m = await open();
const { page } = m;
await screen(m, "app-unlock", async () => {
  await page.goto(base + "/app");
  await page.waitForSelector("text=Open Contri");
});
await screen(m, "app-recovery-code", async () => {
  await page.click("summary:has-text('Other ways in')");
  await page.click("text=Keep my key on this device instead");
  await page.waitForSelector("text=Write down your recovery code");
});
await screen(m, "app-home", async () => {
  await page.click("text=I've written it down");
  await page.waitForSelector("h1:has-text('Your circles')");
  await page.waitForSelector(".loading", { state: "detached", timeout: 30_000 });
  await page.waitForFunction(() => /In your private balance: \$/.test(document.body.innerText), null, { timeout: 30_000 });
});
await screen(m, "app-explore", async () => {
  await page.goto(base + "/app#/explore");
  await page.waitForSelector("h1");
  await page.waitForFunction(() => !document.querySelector(".loading"), null, { timeout: 30_000 });
  await page.waitForSelector("text=/Circle \\d+/", { timeout: 30_000 });
});
await screen(m, "app-circle", async () => {
  await page.goto(base + "/app#/c/0");
  await page.waitForSelector(".ring", { timeout: 30_000 });
});
const invite = process.env.INVITE || "0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
await screen(m, "app-invite", async () => {
  await page.goto(base + "/join#" + invite);
  await page.waitForSelector("text=You're invited to a savings circle", { timeout: 30_000 });
  if (page.url().includes(invite.split(".")[1])) throw new Error("the invite secret stayed in the address bar");
  await page.reload();
  await page.waitForSelector("text=You're invited to a savings circle", { timeout: 30_000 });
});
await screen(m, "app-invite-broken", async () => {
  await page.goto(base + "/join#nonsense");
  await page.waitForSelector(".notice.error");
  if (!new URL(page.url()).pathname.startsWith("/app")) throw new Error("a broken invite didn't go to the app");
  await page.locator(".notice.error").evaluate((el) => el.remove()); // expected here
});
await screen(m, "app-new", async () => {
  await page.goto(base + "/app#/new");
  await page.fill("input[placeholder='Yaba traders']", "Live check");
  await page.fill("input[placeholder='5']", "1");
  await page.selectOption("select >> nth=0", "2");
  await page.click("button:has-text('Continue')");
  await page.waitForSelector("h1:has-text('Create Live check')", { timeout: 30_000 });
});
await screen(m, "app-fund-address", async () => {
  await page.click("button:has-text('Get a deposit address')");
  await page.waitForSelector(".deposit .code-block", { timeout: 30_000 });
});
await screen(m, "app-private-add", async () => {
  await page.click("text=Privately, through your private balance");
  await page.click("a:has-text('Add to your private balance')");
  await page.waitForSelector("h1:has-text('Add to your private balance')");
  await page.waitForFunction(() => /In your private balance: \$/.test(document.body.innerText), null, { timeout: 30_000 });
  await page.fill("input[inputmode='decimal']", "3");
  await page.click("button:has-text('Get a deposit address')");
  await page.waitForSelector(".deposit .code-block", { timeout: 30_000 });
});
await screen(m, "app-move-out", async () => {
  await page.goto(base + "/app#/cash/0");
  await page.waitForSelector("h1:has-text('Move money out')", { timeout: 30_000 });
  await page.click("text=An exchange or wallet");
  await page.waitForSelector("text=Send to");
});
await screen(m, "app-private-cash", async () => {
  await page.goto(base + "/app#/private/cash");
  await page.waitForSelector("h1:has-text('Cash out your private balance')", { timeout: 30_000 });
});
await screen(m, "app-settings", async () => {
  await page.goto(base + "/app#/settings");
  await page.waitForSelector("h1:has-text('Your key')");
});
await m.ctx.close();
await browser.close();

console.log(failed ? `\n${failed} screen(s) had problems` : "\nevery screen is clean");
process.exit(failed ? 1 : 0);
