// node render.mjs [from] [to] [--stills t1,t2,...]
// Renders the stage in 6-second parts (parts/pNN.mp4), or stills to check.
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { readdirSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";

const STAGE = "http://localhost:8790/stage.html";
const manifest = {};
for (const d of readdirSync("frames")) manifest[d] = readdirSync(`frames/${d}`).length;

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.addInitScript((m) => { window.MANIFEST = m; }, manifest);
await page.goto(STAGE, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
const cues = await page.evaluate(() => ({ ...window.CUES, S: window.CUES.S, CAPS: window.CUES.CAPS }));
writeFileSync("cues.json", JSON.stringify(cues, null, 1));
const DUR = await page.evaluate(() => window.DURATION);
console.log("duration", DUR.toFixed(2));

const args = process.argv.slice(2);
if (args[0] === "--stills") {
  mkdirSync("stills", { recursive: true });
  for (const t of args[1].split(",").map(Number)) {
    await page.evaluate((t) => window.render(t), t);
    await page.screenshot({ path: `stills/t${t.toFixed(2)}.jpg`, type: "jpeg", quality: 92 });
  }
  await b.close(); process.exit(0);
}
const PART = 6;
const parts = Math.ceil(DUR / PART);
const from = Number(args[0] ?? 0), to = Number(args[1] ?? parts - 1);
mkdirSync("parts", { recursive: true });
for (let p = from; p <= to; p++) {
  const t0 = p * PART, t1 = Math.min(DUR, t0 + PART);
  const n = Math.round((t1 - t0) * 30);
  const tmp = `parts/p${String(p).padStart(2, "0")}.tmp.mp4`;
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", "30", "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-r", "30", tmp], { stdio: ["pipe", "inherit", "inherit"] });
  const started = Date.now();
  for (let i = 0; i < n; i++) {
    const t = t0 + i / 30;
    await page.evaluate((t) => window.render(t), t);
    const buf = await page.screenshot({ type: "jpeg", quality: 93 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  const code = await new Promise((r) => ff.on("close", r));
  if (code === 0) renameSync(tmp, tmp.replace(".tmp", ""));
  console.log(`part ${p} (${t0}-${t1.toFixed(1)}s) ${code === 0 ? "ok" : "FAILED"} ${Math.round((Date.now() - started) / 1000)}s`);
}
await b.close();
