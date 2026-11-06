// Read-only: loads every page of the live site at six widths in Chromium,
// WebKit and Firefox, and records console errors, CSP violations, failed
// requests, sideways scroll and broken links. Signs nothing, sends no money.
import { chromium, webkit, firefox } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const D = process.argv[2] ?? "https://contri.ng", O = process.argv[3] ?? "out/pages";
mkdirSync(O, { recursive: true });
const pages = ["/", "/how-it-works", "/privacy", "/terms", "/no-such-page", "/app", "/app#/explore", "/app#/help", "/app#/settings"];
const widths = [320, 375, 393, 768, 1024, 1440];
const report = [];
const links = new Set();
for (const [name, type] of [["chromium", chromium], ["webkit", webkit], ["firefox", firefox]]) {
  const browser = await type.launch();
  for (const w of widths) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 800 ? 800 : 900 }, ...(w < 800 && name !== "firefox" ? { isMobile: true, hasTouch: true } : {}) });
    let page = await ctx.newPage();
    const errors = [], failed = [];
    const watch = (pg) => {
      pg.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text().slice(0, 240)}`); });
      pg.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 240)}`));
      pg.on("requestfailed", (r) => { if (!/aborted|cancel/i.test(r.failure()?.errorText ?? "")) failed.push(`${r.url()} ${r.failure()?.errorText}`); });
      pg.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("no-such-page")) failed.push(`${r.status()} ${r.url()}`); });
    pg.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective} ${e.blockedURI}`)));
    };
    watch(page);
    for (const p of pages) {
      errors.length = 0; failed.length = 0;
      try { await page.goto(D + p, { waitUntil: "networkidle", timeout: 45000 }); } catch (e) { errors.push(`goto: ${String(e).slice(0, 160)}`); }
      let m;
      try {
        await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); } scrollTo(0, 0); });
        await page.waitForTimeout(600);
        m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: innerWidth, title: document.title, anchors: [...document.querySelectorAll("a[href]")].map((a) => a.href) }));
      } catch (e) {
        report.push({ browser: name, width: w, page: p, crashed: String(e).slice(0, 160), errors: [...new Set(errors)], failed: [...new Set(failed)] });
        await page.close().catch(() => {}); page = await ctx.newPage(); watch(page);
        continue;
      }
      m.anchors.forEach((h) => links.add(h));
      report.push({ browser: name, width: w, page: p, sideways: m.sw > m.vw + 1, title: m.title, errors: [...new Set(errors)], failed: [...new Set(failed)] });
      if (name === "chromium" && (w === 320 || w === 1440)) await page.screenshot({ path: `${O}/${w}${p.replace(/[/#]/g, "_")}.png` }).catch(() => {});
    }
    await ctx.close();
  }
  await browser.close();
}
// Every link once: status of same-site links, and that external ones resolve.
const linkReport = [];
for (const href of links) {
  if (!/^https?:/.test(href)) continue;
  try { const r = await fetch(href.split("#")[0], { method: "GET", redirect: "follow", signal: AbortSignal.timeout(20000), headers: { "user-agent": "Mozilla/5.0 (link check)" } }); linkReport.push(`${r.status} ${href}`); }
  catch (e) { linkReport.push(`ERR ${href} ${String(e).slice(0, 80)}`); }
}
writeFileSync(`${O}/pages.json`, JSON.stringify(report, null, 1));
writeFileSync(`${O}/links.txt`, linkReport.sort().join("\n") + "\n");
const bad = report.filter((r) => r.crashed || r.sideways || r.errors.length || r.failed.length);
console.log(`${report.length} page loads, ${bad.length} with sideways scroll, errors or failed requests`);
for (const r of bad) console.log(`${r.browser} ${r.width} ${r.page}: ${r.crashed ? "CRASHED " + r.crashed + " " : ""}sideways=${r.sideways} errors=${JSON.stringify(r.errors)} failed=${JSON.stringify(r.failed)}`);
console.log(linkReport.filter((l) => !/^200 /.test(l)).join("\n") || "every link answered 200");
