// @ts-check
// Local server for working on the app: serves public/ like Vercel does and
// runs the /api handlers. With MOCK=1, the API answers from dev/mock.js
// (made-up circles, nothing on chain) so screens can be checked offline.
//
// Routing and headers come from vercel.json, the file production uses, so a
// route or header that's wrong there is wrong here too, and tests catch it.
//
//   node dev/server.js            real API, using env settings
//   MOCK=1 node dev/server.js     mock API

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff": "font/woff", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".txt": "text/plain", ".webmanifest": "application/manifest+json" };
const VERCEL = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
/** @type {Record<string, string>} */
const REWRITES = Object.fromEntries((VERCEL.rewrites ?? []).map((/** @type {{ source: string, destination: string }} */ r) => [r.source, r.destination]));
/** @type {Record<string, string>} */
const HEADERS = Object.fromEntries((VERCEL.headers ?? []).find((/** @type {{ source: string }} */ h) => h.source === "/(.*)")?.headers.map((/** @type {{ key: string, value: string }} */ h) => [h.key, h.value]) ?? []);
// Production is served over HTTPS; locally these would break plain http.
delete HEADERS["Strict-Transport-Security"];
if (HEADERS["Content-Security-Policy"]) HEADERS["Content-Security-Policy"] = HEADERS["Content-Security-Policy"].replace(/; upgrade-insecure-requests/, "");
const mock = process.env.MOCK ? await import("./mock.js") : null;

/** @param {string} path */
async function file(path) {
  const clean = normalize(path).replace(/^(\.\.[/\\])+/, "");
  // cleanUrls: /privacy serves privacy.html, / serves index.html.
  for (const p of clean === "/" ? ["/index.html"] : [clean, `${clean}.html`]) {
    const full = join(ROOT, p);
    if (!full.startsWith(ROOT)) return null;
    try {
      if ((await stat(full)).isFile()) return { body: await readFile(full), type: TYPES[/** @type {keyof typeof TYPES} */ (extname(full))] ?? "application/octet-stream" };
    } catch {}
  }
  return null;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice(5);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? Buffer.concat(chunks) : undefined });
    let response;
    if (mock) response = await mock.handle(name, request);
    else {
      const mod = await import(`../api/${name.replace(/[^a-z]/g, "")}.js`).catch(() => null);
      const fn = mod?.[req.method ?? "GET"];
      response = fn ? await fn(request) : new Response("not found", { status: 404 });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  const path = REWRITES[url.pathname] ?? url.pathname;
  const f = await file(path);
  if (!f) {
    const notFound = await file("/404.html");
    res.writeHead(404, { ...HEADERS, "content-type": notFound?.type ?? "text/plain" });
    res.end(notFound?.body ?? "not found");
    return;
  }
  // Byte ranges, as Vercel serves them, so videos can seek.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range) {
    const size = f.body.length;
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { ...HEADERS, "content-type": f.type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    res.end(f.body.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { ...HEADERS, "content-type": f.type, "accept-ranges": "bytes" });
  res.end(f.body);
}).listen(PORT, () => {
  console.log(`Contri on http://localhost:${PORT}/app${mock ? " (mock API: made-up circles, nothing on chain)" : ""}`);
  if (mock) console.log(`To see a member's circles: Other ways in > Restore from a recovery code, and paste\n  ${mock.MEMBER_CODE}\nOr choose Keep my key on this device to start fresh and create a circle.`);
});
