// One command that checks Contri runs and does what the README says.
//
//   node app/scripts/verify.mjs          (from the repository root; Node 22, no install)
//   node app/scripts/verify.mjs --all    (also the contract's unit tests, if cargo is installed)
//
// 1. The app and server tests.
// 2. The app itself, offline: starts it against the made-up chain in
//    app/public/js/demo/mock.js, and checks the pages load.
// 3. A whole circle, end to end, offline: two new members top up, one creates a
//    circle, the other joins, both pay two rounds, each gets the pot. Every
//    payment is signed by the app's own signing code and passes Contri's real
//    relayer checks (app/server/relay.js) before it is applied.
// 4. The README's claims about mainnet, read from NEAR: the contract has no
//    keys (locked), its code hash is the one the README gives, and the
//    real-money circle finished with both pots paid. Skipped without internet.
//
// Prints PASS, FAIL or SKIP for each, and exits 1 if anything failed.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));
const results = [];
/** @param {string} name @param {"PASS" | "FAIL" | "SKIP"} status @param {string} detail */
const report = (name, status, detail) => {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(4)}  ${name}${detail ? `: ${detail}` : ""}`);
};
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. App and server tests ----
{
  const r = spawnSync(process.execPath, ["--test", "test/*.test.js"], { cwd: app, encoding: "utf8" });
  const pass = /# pass (\d+)/.exec(r.stdout)?.[1];
  const fail = /# fail (\d+)/.exec(r.stdout)?.[1];
  report("app and server tests", r.status === 0 ? "PASS" : "FAIL", `${pass ?? "?"} passed, ${fail ?? "?"} failed`);
}

// ---- 2. The app, offline ----
const port = 18_000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["dev/server.js"], { cwd: app, env: { ...process.env, MOCK: "1", PORT: String(port) }, stdio: "ignore" });
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  await sleep(200);
  up = await fetch(`${base}/app`).then((r) => r.ok, () => false);
}
try {
  if (!up) {
    report("the app starts offline", "FAIL", "the offline server didn't answer");
  } else {
    const pages = [];
    for (const path of ["/", "/app", "/demo", "/how-it-works", "/privacy", "/terms", "/js/app/main.js", "/js/demo/mock.js"]) {
      const r = await fetch(base + path);
      if (!r.ok) pages.push(`${path} ${r.status}`);
    }
    report("the app starts offline and every page loads", pages.length ? "FAIL" : "PASS", pages.join(", "));
    await wholeCircle();
  }
} finally {
  server.kill();
}

// ---- 3. A whole circle, end to end ----
async function wholeCircle() {
  const { actions, findEvent } = await import("../public/js/lib/contri.js");
  const { signIntents } = await import("../public/js/lib/intents.js");
  const { signerFromSeed } = await import("../public/js/lib/keys.js");
  const { randomBytes } = await import("../public/js/lib/bytes.js");
  const { checkPayload } = await import("../server/relay.js");
  /** @param {string} path @param {object} [body] */
  const api = async (path, body) => {
    const r = await fetch(base + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  const step = [];
  try {
    const cfg = await api("/api/config");
    const a = actions(cfg.contractId, cfg.tokenId);
    const ada = await signerFromSeed(randomBytes(32));
    const bayo = await signerFromSeed(randomBytes(32));
    // The relayer's own checks, with its rules for this contract and token.
    const relayCfg = /** @type {any} */ ({ contractId: cfg.contractId, tokenId: cfg.tokenId, intentsId: cfg.intentsId, relayerKey: "" });
    /** @param {any} who @param {object[]} intents */
    const send = async (who, intents) => {
      const [salt] = (await api("/api/rpc", { calls: [{ contract: "intents", method: "current_salt" }] })).map((/** @type {any} */ x) => x.ok);
      const signed = await signIntents(who, intents, { recipient: cfg.intentsId, salt });
      const signer = await checkPayload(signed, relayCfg);
      if (signer !== who.accountId) throw new Error("the relayer's checks didn't accept the member's own signature");
      return api("/api/relay", { signed: [signed] });
    };
    /** @param {string} account */
    const balance = async (account) => BigInt((await api("/api/rpc", { calls: [{ contract: "intents", method: "mt_balance_of", args: { account_id: account, token_id: cfg.tokenId } }] }))[0].ok);

    // Both top up $3 from "an exchange": a deposit address, then the money arrives.
    const deposits = [];
    for (const m of [ada, bayo]) deposits.push((await api("/api/swap", { action: "topup", network: "bsc", account: m.accountId, amount: "3000000" })).depositAddress);
    await sleep(4200);
    for (const d of deposits) await api("/api/swap", { action: "status", depositAddress: d });
    if ((await balance(ada.accountId)) !== 3_000_000n) throw new Error("the top-up didn't arrive");
    step.push("top-ups arrived");

    const created = await send(ada, a.create({ contribution: 1_000_000n, size: 2, periodSecs: 600, random: false, inviteKeyHex: null, name: "verify" }));
    const id = findEvent(created.events, "circle_created")?.circle ?? findEvent(created.events, "joined")?.circle;
    if (id === undefined) throw new Error("the circle wasn't created");
    step.push(`circle ${id} created`);
    const joined = await send(bayo, a.join(id, 1_000_000n, null));
    if (!findEvent(joined.events, "joined")) throw new Error("the second member couldn't join");
    step.push("second member joined");

    for (const round of [0, 1]) {
      for (const m of [ada, bayo]) {
        const r = await send(m, a.contribute(id, round, 1_000_000n));
        if (!findEvent(r.events, "contributed")) throw new Error(`round ${round + 1}: a payment wasn't taken`);
      }
      step.push(`round ${round + 1} paid out`);
    }
    const [circle] = (await api("/api/rpc", { calls: [{ contract: "contri", method: "get_circle", args: { circle_id: id } }] })).map((/** @type {any} */ x) => x.ok);
    if (circle.status !== "Finished" || circle.payouts.length !== 2) throw new Error(`the circle ended ${circle.status} with ${circle.payouts.length} payouts`);
    // Each paid 3 x $1 (deposit and two rounds), received $2 and the deposit back.
    const [aEnd, bEnd] = [await balance(ada.accountId), await balance(bayo.accountId)];
    if (aEnd !== 3_000_000n || bEnd !== 3_000_000n) throw new Error(`balances at the end: ${aEnd}, ${bEnd} (expected 3000000 each)`);
    step.push("both got the pot and their deposit back");
    report("a whole circle, offline, signed by the app and checked by the relayer", "PASS", step.join(", "));
  } catch (e) {
    report("a whole circle, offline, signed by the app and checked by the relayer", "FAIL", `${step.join(", ")}${step.length ? "; then " : ""}${e instanceof Error ? e.message : e}`);
  }
}

// ---- 4. The README's claims on mainnet ----
{
  const readme = readFileSync(`${root}README.md`, "utf8");
  const claimedHash = /code hash `([1-9A-HJ-NP-Za-km-z]{43,44})`/.exec(readme)?.[1];
  const contract = /\[`([a-z0-9._-]+\.near)`\]\(https:\/\/nearblocks\.io\/address\//.exec(readme)?.[1] ?? "circles.contring.near";
  const RPC = ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"];
  /** @param {string} method @param {object} params */
  const rpc = async (method, params) => {
    for (const url of RPC) {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) }).catch(() => null);
      const j = await r?.json().catch(() => null);
      if (j?.result) return j.result;
    }
    return null;
  };
  const account = await rpc("query", { request_type: "view_account", finality: "final", account_id: contract });
  if (!account) {
    report("the README's mainnet claims", "SKIP", "NEAR's RPC isn't reachable from here");
  } else {
    const keys = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: contract });
    const n = keys?.keys?.length ?? -1;
    report(`the contract ${contract} is locked`, n === 0 ? "PASS" : "FAIL", `${n} access keys`);
    report("its code is the build the README names", account.code_hash === claimedHash ? "PASS" : "FAIL", `on chain ${account.code_hash}, README ${claimedHash ?? "none"}`);
    const run = /Circle (\d+): \$1 a round/.exec(readme)?.[1];
    const view = await rpc("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: "get_circle", args_base64: Buffer.from(JSON.stringify({ circle_id: Number(run) })).toString("base64") });
    const c = view ? JSON.parse(Buffer.from(view.result).toString()) : null;
    if (!c) report(`the real-money circle ${run}`, "FAIL", "not found (closed by someone, or not on chain)");
    else report(`the real-money circle ${run} finished with every pot paid`, c.status === "Finished" && c.payouts.length === c.size ? "PASS" : "FAIL", `${c.status}, ${c.payouts.length} of ${c.size} payouts, ${c.payouts.map((/** @type {any} */ p) => `$${Number(p.amount) / 1e6}`).join(" and ")}`);
  }
}

// ---- 5. Contract unit tests (optional) ----
if (process.argv.includes("--all")) {
  const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8" });
  if (cargo.status !== 0) report("contract unit tests", "SKIP", "cargo isn't installed; CI's run is on the ci-results branch");
  else {
    const r = spawnSync("cargo", ["test", "--quiet"], { cwd: `${root}contract`, encoding: "utf8" });
    const line = /test result: .*/.exec(r.stdout)?.[0] ?? "no result";
    report("contract unit tests", r.status === 0 ? "PASS" : "FAIL", line);
  }
} else {
  report("contract unit tests", "SKIP", "add --all to run them (needs Rust); CI's run is on the ci-results branch");
}

const failed = results.filter((r) => r.status === "FAIL").length;
console.log(failed ? `\n${failed} check(s) failed` : "\nEverything checked works as the README says.");
process.exit(failed ? 1 : 0);
