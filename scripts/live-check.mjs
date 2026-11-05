// Checks the live site's money paths without spending anything:
//   1. a top-up quote through /api/swap returns a 1Click deposit address;
//   2. a cash-out dry quote works;
//   3. a signed join from an empty account reaches /api/relay, passes the
//      relayer's checks, and is stopped by NEAR Intents' simulation (no balance),
//      so no gas is spent.
// Usage: node scripts/live-check.mjs https://contri.ng

import { signerFromSeed } from "../app/public/js/lib/keys.js";
import { signIntents } from "../app/public/js/lib/intents.js";
import { actions } from "../app/public/js/lib/contri.js";
import { randomBytes } from "node:crypto";

const base = process.argv[2] || "https://contri.ng";
const post = async (path, body) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const cfg = await (await fetch(`${base}/api/config`)).json();
console.log("config", JSON.stringify(cfg));
const member = await signerFromSeed(new Uint8Array(randomBytes(32)));

const topup = await post("/api/swap", { action: "topup", network: "bsc", account: member.accountId, amount: "3000000" });
console.log("topup", topup.status, JSON.stringify(topup.body));
const cash = await post("/api/swap", { action: "cashout", network: "bsc", account: member.accountId, amount: "3000000", address: "0x2222222222222222222222222222222222222222", dry: true });
console.log("cashout (dry)", cash.status, JSON.stringify(cash.body));

const [salt] = (await post("/api/rpc", { calls: [{ contract: "intents", method: "current_salt" }] })).body.map((x) => x.ok);
const signed = await signIntents(member, actions(cfg.contractId, cfg.tokenId).join(0, 1_000_000n, null), { recipient: cfg.intentsId, salt });
const relay = await post("/api/relay", { signed: [signed] });
console.log("relay (empty account)", relay.status, JSON.stringify(relay.body));
