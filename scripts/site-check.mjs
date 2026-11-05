// Checks the live site the way a visitor's browser would reach it, so a
// broken route or a missing file shows up after the deploy, not on someone's
// phone. Read-only: nothing is signed, paid or stored.
//
//  1. Every page, and every address people are sent to (invite links, old
//     .html names, www, trailing slashes), lands on the right page.
//  2. Every file those pages load (styles, fonts, icons, the manifest and the
//     icons it names, the social preview image, every JavaScript module the
//     app imports, followed import by import) answers 200 with the right type.
//  3. The security headers are on every page.
//  4. Every API route answers, and refuses what it should.
//
// Prints one line per check and exits 1 if any fails.
// Usage: node scripts/site-check.mjs https://contri.ng

const base = (process.argv[2] || "https://contri.ng").replace(/\/$/, "");
let failed = 0;
/** @param {boolean} ok @param {string} what @param {string} [detail] */
const check = (ok, what, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `  (${detail})` : ""}`);
};
/** A request, tried up to 3 times if the network drops (not on an HTTP error, which is the answer). */
async function get(path, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(path.startsWith("http") ? path : base + path, { redirect: "manual", signal: AbortSignal.timeout(20_000), ...init });
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
const post = (path, body) => get(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---- 1. Pages and the addresses that lead to them ----
const PAGES = { "/": "index", "/how-it-works": "how-it-works", "/privacy": "privacy", "/terms": "terms", "/app": "app", "/join": "app" };
const html = {};
for (const [path, name] of Object.entries(PAGES)) {
  const r = await get(path);
  const text = await r.text();
  html[path] = text;
  const isApp = name === "app";
  const right = isApp ? text.includes('src="/js/app/main.js"') : !text.includes('src="/js/app/main.js"') && text.includes("<title>");
  check(r.status === 200 && right, `page ${path}`, `${r.status}${right ? "" : ", wrong page"}`);
  const csp = r.headers.get("content-security-policy") ?? "";
  check(csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'"), `CSP on ${path}`);
  check(r.headers.get("x-content-type-options") === "nosniff" && r.headers.get("referrer-policy") === "no-referrer", `security headers on ${path}`);
}
check(/<a href="#|\/app#\/new|\/app#\/explore/.test(html["/"]), "home links into the app");

const REDIRECTS = [
  ["/index.html", "/"], ["/app.html", "/app"], ["/privacy.html", "/privacy"], ["/terms.html", "/terms"],
  ["/how-it-works.html", "/how-it-works"], ["/join/", "/join"], ["/privacy/", "/privacy"],
];
for (const [from, to] of REDIRECTS) {
  const r = await get(from);
  const loc = r.headers.get("location") ?? "";
  check([301, 307, 308].includes(r.status) && new URL(loc, base).pathname === to, `${from} redirects to ${to}`, `${r.status} ${loc}`);
}
const host = new URL(base).host;
if (!host.startsWith("www.") && !host.endsWith(".vercel.app")) {
  const r = await get(`https://www.${host}/join`);
  check([301, 307, 308].includes(r.status) && (r.headers.get("location") ?? "").startsWith(`https://${host}/join`), `www.${host} redirects to ${host}`, `${r.status}`);
}
const missing = await get("/no-such-page");
const missingText = await missing.text();
check(missing.status === 404 && missingText.includes("contri.css"), "unknown pages get Contri's own 404 page", `${missing.status}`);

// ---- 2. Every file the pages load ----
/** @type {Map<string, string>} path -> expected content type prefix */
const files = new Map();
const TYPES = { css: "text/css", js: "javascript", svg: "image/svg+xml", png: "image/png", woff: "font/woff", webmanifest: "manifest+json" };
/** @type {Set<string>} */
const links = new Set();
const typeOf = (p) => TYPES[/** @type {keyof typeof TYPES} */ (p.split(".").pop())] ?? "";
for (const text of Object.values(html)) {
  for (const m of text.matchAll(/(?:href|src|content)="(\/[^"#?]*\.(?:css|js|svg|png|woff|webmanifest))"/g)) files.set(m[1], typeOf(m[1]));
  for (const m of text.matchAll(/content="https?:\/\/[^/"]+(\/[^"]+\.png)"/g)) files.set(m[1], "image/png");
  for (const m of text.matchAll(/<a [^>]*href="(\/[^"#?]*)"/g)) links.add(m[1]);
}
for (const link of links) {
  const r = await get(link);
  check(r.status === 200, `link ${link}`, String(r.status));
}
// The modules the app imports, followed through every import.
const queue = ["/js/app/main.js"];
const seen = new Set();
while (queue.length) {
  const path = /** @type {string} */ (queue.shift());
  if (seen.has(path)) continue;
  seen.add(path);
  files.set(path, "javascript");
  const r = await get(path);
  const text = await r.text();
  for (const m of text.matchAll(/(?:import|export)\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"|import\(\s*"(\.{1,2}\/[^"]+)"\s*\)/g)) {
    queue.push(new URL(m[1] ?? m[2], base + path).pathname);
  }
}
check(seen.size >= 20, `the app's modules were all found`, `${seen.size} modules`);
// What the stylesheet and manifest load.
const css = await (await get("/css/contri.css")).text();
for (const m of css.matchAll(/url\(["']?(\/[^"')]+)["']?\)/g)) files.set(m[1], typeOf(m[1]));
const manifest = await (await get("/manifest.webmanifest")).json().catch(() => null);
check(Boolean(manifest?.name && manifest?.start_url && manifest?.icons?.length), "manifest parses");
for (const icon of manifest?.icons ?? []) files.set(new URL(icon.src, base + "/").pathname, icon.type ?? "image/png");
const startUrl = manifest ? new URL(manifest.start_url, base + "/").pathname : "";
if (startUrl) check((await get(startUrl)).status === 200, `manifest start_url ${startUrl}`);

for (const [path, type] of files) {
  const r = await get(path);
  const ct = r.headers.get("content-type") ?? "";
  check(r.status === 200 && (!type || ct.includes(type)), `file ${path}`, `${r.status} ${ct}`);
}

// ---- 3. The API ----
const config = await get("/api/config");
const cfg = await config.json().catch(() => ({}));
check(config.status === 200 && Boolean(cfg.contractId) && cfg.relaying === true, "GET /api/config", JSON.stringify(cfg));

// The relayer pays every member's gas: if it runs dry, nothing works.
if (cfg.relayer) {
  const rpcUrl = cfg.network === "testnet" ? "https://rpc.testnet.fastnear.com" : "https://rpc.mainnet.fastnear.com";
  const acc = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: cfg.relayer } }) })
    .then((r) => r.json()).catch(() => null);
  const near = acc?.result ? Number(BigInt(acc.result.amount) / 10n ** 20n) / 10_000 : NaN;
  check(near >= 0.25, `relayer ${cfg.relayer} can pay for gas`, `${near} NEAR; top it up below 0.25`);
}

const rpc = await post("/api/rpc", { calls: [
  { contract: "contri", method: "get_config" },
  { contract: "contri", method: "get_circles", args: { from_index: 0, limit: 5 } },
  { contract: "contri", method: "get_circle", args: { circle_id: 0 } },
  { contract: "contri", method: "nft_token", args: { token_id: "0:0" } },
  { contract: "intents", method: "current_salt" },
  { contract: "intents", method: "mt_balance_of", args: { account_id: "0".repeat(64), token_id: cfg.tokenId } },
] });
const rpcBody = await rpc.json().catch(() => []);
check(rpc.status === 200 && Array.isArray(rpcBody), "POST /api/rpc", String(rpc.status));
["get_config", "get_circles", "get_circle", "nft_token", "current_salt", "mt_balance_of"].forEach((m, i) => check(rpcBody[i] && "ok" in rpcBody[i], `  view ${m}`, rpcBody[i]?.error ?? ""));
const refusedView = await post("/api/rpc", { calls: [{ contract: "intents", method: "simulate_intents", args: {} }] });
const refusedBody = await refusedView.json().catch(() => []);
check(Boolean(refusedBody[0]?.error), "  views outside the allowlist are refused");

const relay = await post("/api/relay", { signed: [] });
check(relay.status === 400, "POST /api/relay refuses an empty request", String(relay.status));
const swap = await post("/api/swap", { action: "nope" });
check(swap.status === 400, "POST /api/swap refuses an unknown action", String(swap.status));
const status = await post("/api/swap", { action: "status", depositAddress: "0x" + "0".repeat(40) });
check(status.status === 200 || status.status === 502, "POST /api/swap status answers", String(status.status));
const keeper = await get("/api/keeper");
check(keeper.status === 200, "GET /api/keeper", String(keeper.status));
const tooBig = await post("/api/relay", { pad: "x".repeat(70_000) });
check(tooBig.status === 413, "oversized requests are refused", String(tooBig.status));

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
