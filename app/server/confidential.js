// @ts-check
// A member's private balance, on NEAR Intents' Confidential Intents.
//
// Every member has one private account, the "vault": an ed25519 key the app
// derives from the passkey (HKDF(secret, "contri/vault/<contract>")). Its
// balance lives on NEAR Intents' private shard, which has no public RPC or
// explorer, so nobody looking at the public chain can see it.
//
//   private top-up   stablecoin on another chain -> vault (private)
//   move to circle   vault -> a circle account on public NEAR Intents
//   move home        a circle account -> vault (after a payout, or leftovers)
//   private cash-out vault -> stablecoin on another chain
//
// So the public chain shows money arriving at a circle account from 1Click,
// and leaving it to 1Click: never the exchange account or wallet behind it.
// 1Click routes each move, so it sees both ends of that one move, and so does
// Contri's server, which passes the request on. Contri's code keeps nothing;
// Vercel keeps its own request logs.
//
// Moves out of the vault are intents the vault signs: 1Click builds the
// intent (`/v0/generate-intent`), the member's app signs exactly that, and
// this server submits it (`/v0/submit-intent`). Reading the vault's balance
// needs a short session the vault signs in for (`/v0/auth/authenticate`).

import { fromBase58, fromBase64, toHex } from "../public/js/lib/bytes.js";
import { nep413Hash } from "../public/js/lib/intents.js";
import { verify } from "../public/js/lib/keys.js";
import { checkPrivateMove } from "../public/js/lib/private.js";
import { deadline, fee, feeAmount, feeBpsOf, feeShown, formatDown, formatUnits, IMPLICIT_OR_NAMED, net, quote, TOKEN_DECIMALS, toSend, units } from "./oneclick.js";
import { RelayError } from "./relay.js";
import { issueTicket } from "./ticket.js";

/** @typedef {import("./config.js").Config} Config */

/** @param {Config} c @param {string} path @param {RequestInit & { session?: string }} [init] */
async function oneClick(c, path, init = {}) {
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (c.oneClickKey) headers["X-API-Key"] = c.oneClickKey;
  if (init.session) headers.Authorization = `Bearer ${init.session}`;
  const res = await fetch(`${c.oneClickUrl}${path}`, { ...init, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new RelayError(json.message ? `1Click: ${json.message}` : `1Click answered ${res.status}`, res.status >= 500 ? 502 : 400);
  return json;
}

/** @param {unknown} v */
function account(v) {
  const s = String(v ?? "");
  if (!IMPLICIT_OR_NAMED.test(s)) throw new RelayError("invalid account");
  return s;
}

/**
 * Checks a NEP-413 payload's signature and that its signer is the key's
 * implicit account. Returns the parsed message.
 * @param {any} signed
 */
async function checkSigned(signed) {
  if (signed?.standard !== "nep413" || typeof signed.payload?.message !== "string") throw new RelayError("expected a NEP-413 signed payload");
  const publicKey = fromBase58(String(signed.public_key).replace(/^ed25519:/, ""));
  const signature = fromBase58(String(signed.signature).replace(/^ed25519:/, ""));
  const nonce = fromBase64(String(signed.payload.nonce));
  if (publicKey.length !== 32 || signature.length !== 64 || nonce.length !== 32) throw new RelayError("malformed key, signature or nonce");
  if (!(await verify(publicKey, await nep413Hash(signed.payload.message, nonce, signed.payload.recipient), signature))) throw new RelayError("the signature doesn't match");
  let message;
  try {
    message = JSON.parse(signed.payload.message);
  } catch {
    throw new RelayError("the signed message isn't JSON");
  }
  if (message.signer_id !== toHex(publicKey)) throw new RelayError("the key isn't the signer's");
  return message;
}

/** Signs the vault in: an empty intent, signed by the vault. Returns a session of about 15 minutes. @param {any} body @param {Config} c */
export async function privateSignIn(body, c) {
  const message = await checkSigned(body.signed);
  if (!Array.isArray(message.intents) || message.intents.length !== 0) throw new RelayError("sign-in signs no intents");
  const r = await oneClick(c, "/v0/auth/authenticate", { method: "POST", body: JSON.stringify({ signedData: body.signed }) });
  return { session: r.accessToken, expiresIn: r.expiresIn };
}

/**
 * The vault's private balance of the circle token (USDT), in token units.
 * 1Click lists every non-zero balance; the private ledger may name USDT as
 * `imt:<issuer>:<token id>`, so both forms count.
 * @param {any} body @param {Config} c
 */
export async function privateBalance(body, c) {
  const session = String(body.session ?? "");
  if (!/^[A-Za-z0-9._-]{20,4096}$/.test(session)) throw new RelayError("sign in to read the private balance", 401);
  const r = await oneClick(c, "/v0/account/balances", { session });
  const balances = /** @type {{ tokenId: string, available: string }[]} */ (Array.isArray(r.balances) ? r.balances : []);
  let amount = 0n;
  for (const b of balances) {
    const id = String(b.tokenId);
    if ((id === c.tokenId || (id.startsWith("imt:") && id.endsWith(`:${c.tokenId}`))) && /^\d{1,30}$/.test(String(b.available))) amount += BigInt(b.available);
  }
  return { amount: amount.toString() };
}

/** A deposit address that turns `amount` (token units) sent on `network` into the vault's private balance. @param {any} body @param {Config} c */
export async function privateTopUp(body, c) {
  const n = net(body.network);
  const vault = account(body.vault);
  const want = units(body.amount, "amount");
  const send = toSend(want, n.decimals, feeBpsOf(c));
  const q = await quote(c, {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: n.asset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: c.tokenId,
    amount: send.toString(),
    recipient: vault,
    recipientType: "CONFIDENTIAL_INTENTS",
    refundTo: vault,
    refundType: "CONFIDENTIAL_INTENTS",
    confidentiality: "basic",
    deadline: deadline(24 * 60),
    referral: "contri",
    ...fee(c),
  });
  return {
    network: body.network,
    label: n.label,
    symbol: n.symbol,
    depositAddress: q.depositAddress,
    depositMemo: q.depositMemo ?? null,
    send: formatUnits(BigInt(q.amountIn), n.decimals),
    receive: formatDown(BigInt(q.amountOut), TOKEN_DECIMALS),
    contriFee: feeShown(c),
    contriFeeUsd: feeAmount(c, BigInt(q.amountIn), n.decimals),
    deadline: q.deadline,
    seconds: q.timeEstimate,
  };
}

/**
 * Starts a move out of the vault: to a circle account (`to`), or to another
 * chain (`network` and `address`). Returns the intent 1Click built, for the
 * vault to sign as it is. With `dry`, only what would arrive.
 * @param {any} body @param {Config} c
 */
export async function privateMove(body, c) {
  const vault = account(body.vault);
  const amount = units(body.amount, "amount");
  const dry = Boolean(body.dry);
  /** @type {Record<string, unknown>} */
  let destination;
  let decimals = TOKEN_DECIMALS;
  if (body.to) {
    destination = { destinationAsset: c.tokenId, recipient: account(body.to), recipientType: "INTENTS" };
  } else {
    const n = net(body.network);
    if (!n.address.test(String(body.address))) throw new RelayError(`that isn't a ${n.label} address`);
    // Leaving for another chain is a cash-out, which carries Contri's fee.
    destination = { destinationAsset: n.asset, recipient: String(body.address), recipientType: "DESTINATION_CHAIN", ...fee(c) };
    decimals = n.decimals;
  }
  const q = await quote(c, {
    dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: c.tokenId,
    depositType: "CONFIDENTIAL_INTENTS",
    amount: amount.toString(),
    refundTo: vault,
    refundType: "CONFIDENTIAL_INTENTS",
    deadline: deadline(30),
    referral: "contri",
    ...destination,
  });
  const estimate = {
    receive: formatDown(BigInt(q.amountOut), decimals),
    fee: q.withdrawFee ? formatUnits(BigInt(q.withdrawFee), decimals) : "0",
    contriFee: body.to ? null : feeShown(c),
    contriFeeUsd: body.to ? null : feeAmount(c, amount, TOKEN_DECIMALS),
    seconds: q.timeEstimate,
  };
  if (dry) return estimate;
  if (!q.depositAddress) throw new RelayError("1Click didn't give a deposit address; try again", 502);
  const g = await oneClick(c, "/v0/generate-intent", {
    method: "POST",
    body: JSON.stringify({ type: "swap_transfer", standard: "nep413", signerId: vault, depositAddress: q.depositAddress }),
  });
  return { ...estimate, depositAddress: q.depositAddress, intent: g.intent };
}

/**
 * Submits the intent from `privateMove`, signed by the vault. Only a plain
 * transfer of the circle token to a deposit address is passed on, so Contri's
 * 1Click key can't be used to submit anything else.
 * @param {any} body @param {Config} c
 */
export async function privateSubmit(body, c) {
  const signed = body.signed;
  const message = await checkSigned(signed);
  try {
    checkPrivateMove(signed.payload.message, { signer: message.signer_id, tokenId: c.tokenId });
  } catch (e) {
    throw new RelayError(`not submitted: ${e instanceof Error ? e.message : e}`);
  }
  const r = await oneClick(c, "/v0/submit-intent", { method: "POST", body: JSON.stringify({ type: "swap_transfer", signedData: signed }) });
  return { intentHash: r.intentHash };
}

/**
 * Starts a move from a circle account into the vault. Returns a deposit
 * account on public NEAR Intents; the app then signs a plain transfer to it
 * from the circle account, which Contri's relayer submits.
 * @param {any} body @param {Config} c
 */
export async function privateHome(body, c) {
  const from = account(body.from);
  const vault = account(body.vault);
  const amount = units(body.amount, "amount");
  const q = await quote(c, {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: c.tokenId,
    depositType: "INTENTS",
    destinationAsset: c.tokenId,
    amount: amount.toString(),
    recipient: vault,
    recipientType: "CONFIDENTIAL_INTENTS",
    refundTo: from,
    refundType: "INTENTS",
    deadline: deadline(30),
    referral: "contri",
  });
  if (!q.depositAddress) throw new RelayError("1Click didn't give a deposit address; try again", 502);
  const ticket = await issueTicket(c.relayerKey, q.depositAddress, from, amount);
  return { depositAddress: q.depositAddress, ticket, receive: formatDown(BigInt(q.amountOut), TOKEN_DECIMALS), seconds: q.timeEstimate };
}
