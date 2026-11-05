// Checks the live site's money paths without spending anything:
//   1. a top-up quote through /api/swap returns a 1Click deposit address;
//   2. a cash-out dry quote works;
//   3. a signed join from an empty account reaches /api/relay, passes the
//      relayer's checks, and is stopped by NEAR Intents' simulation (no balance),
//      so no gas is spent;
//   4. the private balance's calls, end to end, with an empty private account.
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

// ---- The private balance (Confidential Intents), with an empty private account ----
// The same calls the app makes: sign in, read the balance, a private top-up
// address, a move to a circle account (checked, signed and submitted exactly
// as the phone does; 1Click accepts it and it then fails for lack of money),
// a cash-out estimate, and a payout going home.
import { vaultSigner } from "../app/public/js/lib/keys.js";
import { checkPrivateMove } from "../app/public/js/lib/private.js";
import { nep413Hash } from "../app/public/js/lib/intents.js";
import { fromBase64, toBase58 } from "../app/public/js/lib/bytes.js";

const vault = await vaultSigner(new Uint8Array(randomBytes(32)), cfg.contractId);
const step = (label, r) => console.log(label, r.status, JSON.stringify(r.body).slice(0, 1500));
const empty = await signIntents(vault, [], { recipient: cfg.intentsId, salt, validForMs: 4 * 60_000 });
const signin = await post("/api/swap", { action: "psignin", signed: empty });
step("private sign-in", { status: signin.status, body: { ...signin.body, session: signin.body.session ? `${String(signin.body.session).slice(0, 12)}...` : undefined } });
step("private balance", await post("/api/swap", { action: "pbalance", session: signin.body.session }));
step("private top-up", await post("/api/swap", { action: "ptopup", network: "bsc", vault: vault.accountId, amount: "5000000" }));

const move = await post("/api/swap", { action: "pmove", vault: vault.accountId, to: member.accountId, amount: "1000000" });
step("private move to a circle account", move);
if (move.body.intent) {
  const p = move.body.intent.payload;
  try {
    console.log("phone's check", JSON.stringify(checkPrivateMove(p.message, { signer: vault.accountId, tokenId: cfg.tokenId, depositAddress: move.body.depositAddress, amount: "1000000" })));
  } catch (e) {
    console.log("phone's check REFUSED", e.message);
  }
  const sig = await vault.sign(await nep413Hash(p.message, fromBase64(p.nonce), p.recipient));
  step("private submit", await post("/api/swap", { action: "psubmit", signed: { standard: "nep413", payload: p, public_key: vault.publicKeyStr, signature: `ed25519:${toBase58(sig)}` } }));
  await new Promise((r) => setTimeout(r, 8000));
  step("its status", await post("/api/swap", { action: "status", depositAddress: move.body.depositAddress }));
}
step("private cash-out (dry)", await post("/api/swap", { action: "pmove", vault: vault.accountId, network: "bsc", address: "0x2222222222222222222222222222222222222222", amount: "5000000", dry: true }));
const cashIntent = await post("/api/swap", { action: "pmove", vault: vault.accountId, network: "bsc", address: "0x2222222222222222222222222222222222222222", amount: "5000000" });
step("private cash-out intent", cashIntent);
if (cashIntent.body.intent) {
  try {
    console.log("phone's check", JSON.stringify(checkPrivateMove(cashIntent.body.intent.payload.message, { signer: vault.accountId, tokenId: cfg.tokenId, depositAddress: cashIntent.body.depositAddress, amount: "5000000" })));
  } catch (e) {
    console.log("phone's check REFUSED", e.message);
  }
}
step("payout home", await post("/api/swap", { action: "phome", from: member.accountId, vault: vault.accountId, amount: "1000000" }));
