// @ts-check
// Local server for working on the app: serves public/ like Vercel does and
// runs the /api handlers. With MOCK=1, the API answers from dev/mock.js
// (made-up circles, nothing on chain) so screens can be checked offline.
//
//   node dev/server.js            real API, using env settings
//   MOCK=1 node dev/server.js     mock API

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff": "font/woff", ".json": "application/json", ".png": "image/png", ".txt": "text/plain", ".webmanifest": "application/manifest+json" };
const REWRITES = { "/app": "/app.html", "/join": "/app.html", "/": "/index.html" };
const mock = process.env.MOCK ? await import("./mock.js") : null;

/** @param {string} path */
async function file(path) {
  const clean = normalize(path).replace(/^(\.\.[/\\])+/, "");
  for (const p of [clean, `${clean}.html`]) {
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
  const path = REWRITES[/** @type {keyof typeof REWRITES} */ (url.pathname)] ?? url.pathname;
  const f = await file(path);
  if (!f) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": f.type, "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'" });
  res.end(f.body);
}).listen(PORT, () => console.log(`Contri on http://localhost:${PORT}${mock ? " (mock API)" : ""}`));
