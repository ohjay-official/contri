// Probes NEAR Intents' 1Click API for the Confidential Intents flows Contri
// needs, with a throwaway key and no money:
//   1. sign in (POST /v0/auth/authenticate) with the app's own NEP-413 signing
//      and versioned nonce, then read confidential balances with the session;
//   2. dry quotes for each leg: chain -> confidential, confidential -> public
//      Intents account, public -> confidential, confidential -> chain;
//   3. a real (non-dry) confidential -> public quote, generate-intent for it,
//      and submit-intent signed by the key, which has no balance, so it must
//      fail on balance, not on the signature.
// Output: probe-out/confidential.json and probe-out/confidential.md

import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes as nodeRandom } from "node:crypto";
import { signerFromSeed } from "../app/public/js/lib/keys.js";
import { signIntents } from "../app/public/js/lib/intents.js";
import { fromBase64, toBase58 } from "../app/public/js/lib/bytes.js";
import { view } from "../app/public/js/lib/near.js";

const BASE = "https://1click.chaindefuser.com";
const RPC = "https://rpc.mainnet.fastnear.com";
const KEY = process.env.ONECLICK_API_KEY || "";
const USDT = "nep141:usdt.tether-token.near";
const BSC_USDT = "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g";
const out = { ranAt: new Date().toISOString(), partnerKey: Boolean(KEY), steps: [] };

const member = await signerFromSeed(new Uint8Array(nodeRandom(32)));
const circleAccount = (await signerFromSeed(new Uint8Array(nodeRandom(32)))).accountId;
out.vault = member.accountId;

/** @param {Record<string,string>} [extra] */
const headers = (extra = {}) => ({ "Content-Type": "application/json", Accept: "application/json", ...(KEY ? { "X-API-Key": KEY } : {}), ...extra });

async function call(label, path, init = {}) {
  try {
    const res = await fetch(`${BASE}${path}`, init);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 1500); }
    // Session tokens are shortened in the published results: the repo is public.
    const redact = (/** @type {any} */ v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (/token$/i.test(k) && typeof x === "string" ? `${x.slice(0, 12)}...` : x)));
    out.steps.push({ label, path, status: res.status, request: init.body ? redact(JSON.parse(init.body)) : undefined, response: redact(body) });
    return { status: res.status, body };
  } catch (e) {
    out.steps.push({ label, path, error: String(e) });
    return { status: 0, body: null };
  }
}

const deadline = (min) => new Date(Date.now() + min * 60_000).toISOString();
const quote = (label, body, session) =>
  call(label, "/v0/quote", { method: "POST", headers: headers(session ? { Authorization: `Bearer ${session}` } : {}), body: JSON.stringify({ slippageTolerance: 100, deadline: deadline(30), referral: "contri", ...body }) });

// 1. Sign in with the app's signing code.
const salt = await view(RPC, "intents.near", "current_salt");
out.salt = salt;
const signed = await signIntents(member, [], { salt, validForMs: 4 * 60_000 });
const auth = await call("authenticate (nep413, versioned nonce, empty intents)", "/v0/auth/authenticate", { method: "POST", headers: headers(), body: JSON.stringify({ signedData: signed }) });
const session = auth.body?.accessToken;
if (session) await call("confidential balances with the session", "/v0/account/balances", { headers: headers({ Authorization: `Bearer ${session}` }) });

// 2. Dry quotes for each leg.
const legs = [
  ["top up: BSC USDT -> confidential", { swapType: "EXACT_INPUT", originAsset: BSC_USDT, depositType: "ORIGIN_CHAIN", destinationAsset: USDT, amount: "5000000000000000000", recipient: member.accountId, recipientType: "CONFIDENTIAL_INTENTS", refundTo: member.accountId, refundType: "CONFIDENTIAL_INTENTS", confidentiality: "basic" }],
  ["contribute: confidential -> public circle account", { swapType: "EXACT_INPUT", originAsset: USDT, depositType: "CONFIDENTIAL_INTENTS", destinationAsset: USDT, amount: "5000000", recipient: circleAccount, recipientType: "INTENTS", refundTo: member.accountId, refundType: "CONFIDENTIAL_INTENTS" }],
  ["payout home: public circle account -> confidential", { swapType: "EXACT_INPUT", originAsset: USDT, depositType: "INTENTS", destinationAsset: USDT, amount: "5000000", recipient: member.accountId, recipientType: "CONFIDENTIAL_INTENTS", refundTo: circleAccount, refundType: "INTENTS" }],
  ["cash out: confidential -> BSC", { swapType: "EXACT_INPUT", originAsset: USDT, depositType: "CONFIDENTIAL_INTENTS", destinationAsset: BSC_USDT, amount: "5000000", recipient: "0x2222222222222222222222222222222222222222", recipientType: "DESTINATION_CHAIN", refundTo: member.accountId, refundType: "CONFIDENTIAL_INTENTS" }],
];
for (const [label, body] of legs) {
  await quote(`${label} (dry)`, { dry: true, ...body });
  if (session) await quote(`${label} (dry, with session)`, { dry: true, ...body }, session);
}

// 2b. Where does the session go? Try the dry top-up leg with the token in other headers.
if (session) {
  for (const [name, value] of [["User-Session", session], ["X-User-Session", session], ["X-Session-Token", session], ["X-Access-Token", session], ["Cookie", `accessToken=${session}`]]) {
    await call(`top up (dry), session in ${name}`, "/v0/quote", {
      method: "POST",
      headers: headers({ [name]: value }),
      body: JSON.stringify({ slippageTolerance: 100, deadline: deadline(30), referral: "contri", dry: true, ...legs[0][1] }),
    });
  }
}

// 3. A real confidential -> public quote, then generate-intent and submit-intent.
const live = await quote("contribute leg (live quote)", { dry: false, ...legs[1][1] }, session);
const depositAddress = live.body?.quote?.depositAddress;
if (depositAddress) {
  const gen = await call("generate-intent (nep413)", "/v0/generate-intent", {
    method: "POST", headers: headers(), body: JSON.stringify({ type: "swap_transfer", standard: "nep413", signerId: member.accountId, depositAddress }),
  });
  const intent = gen.body?.intent;
  if (intent?.payload) {
    // Sign exactly what 1Click returned.
    const { nep413Hash } = await import("../app/public/js/lib/intents.js");
    const hash = await nep413Hash(intent.payload.message, fromBase64(intent.payload.nonce), intent.payload.recipient);
    const signature = await member.sign(hash);
    await call("submit-intent (no balance: should fail on balance, not signature)", "/v0/submit-intent", {
      method: "POST", headers: headers(), body: JSON.stringify({ type: "swap_transfer", signedData: { standard: "nep413", payload: intent.payload, public_key: member.publicKeyStr, signature: `ed25519:${toBase58(signature)}` } }),
    });
  }
}


await mkdir("probe-out", { recursive: true });
await writeFile("probe-out/confidential.json", JSON.stringify(out, null, 2));
const lines = [`# Confidential Intents probe`, ``, `Ran ${out.ranAt}. Partner key: ${out.partnerKey}. Salt: ${out.salt}.`, ``, `| step | status | response |`, `| --- | --- | --- |`];
for (const s of out.steps) lines.push(`| ${s.label} | ${s.status ?? "error"} | ${JSON.stringify(s.response ?? s.error).slice(0, 300).replace(/\|/g, "/")} |`);
await writeFile("probe-out/confidential.md", lines.join("\n") + "\n");
console.log(lines.join("\n"));
