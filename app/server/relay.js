// @ts-check
// The relayer: submits members' signed intents to NEAR Intents and pays the
// gas, so members never need NEAR.
//
// It only relays what a Contri member needs: transfers to the Contri
// contract, Contri auth calls, and plain transfers out (a cash-out to a 1Click
// deposit account). Every payload's signature is checked here, then simulated
// by NEAR Intents (`simulate_intents`), before any gas is spent.
//
// Nothing is logged or stored: no IP addresses, no accounts, no payloads.

import { fromBase58, fromBase64, toHex } from "../public/js/lib/bytes.js";
import { nep413Hash } from "../public/js/lib/intents.js";
import { signerFromSecretKey, verify } from "../public/js/lib/keys.js";
import { events, outcome, sendTransaction, TGAS, view } from "../public/js/lib/near.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("../public/js/lib/intents.js").SignedIntents} SignedIntents */

export class RelayError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_PAYLOADS = 2;
const MAX_INTENTS = 2;
const MAX_VALID_MS = 30 * 60_000;
const MAX_MIN_GAS = 150n * TGAS;
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * Checks one signed payload against what Contri relays. Returns the signer.
 * @param {unknown} p @param {Config} c @param {number} [nowMs]
 */
export async function checkPayload(p, c, nowMs = Date.now()) {
  const s = /** @type {SignedIntents} */ (p);
  if (!s || s.standard !== "nep413" || typeof s.payload?.message !== "string") throw new RelayError("only NEP-413 signed intents are relayed");
  if (s.payload.recipient !== c.intentsId) throw new RelayError(`intents must be signed for ${c.intentsId}`);

  /** @type {{ signer_id: string, deadline: string, intents: any[] }} */
  let msg;
  try {
    msg = JSON.parse(s.payload.message);
  } catch {
    throw new RelayError("the signed message isn't JSON");
  }
  const deadline = Date.parse(msg.deadline);
  if (!(deadline > nowMs && deadline <= nowMs + MAX_VALID_MS)) throw new RelayError("the intent has expired or is valid for too long; sign it again");
  if (!Array.isArray(msg.intents) || msg.intents.length < 1 || msg.intents.length > MAX_INTENTS) throw new RelayError("unexpected number of intents");
  for (const i of msg.intents) checkIntent(i, c);

  // The signature, here first so a bad one costs no RPC call. NEAR Intents
  // checks it again, along with the key's link to the account.
  const publicKey = fromBase58(String(s.public_key).replace(/^ed25519:/, ""));
  const signature = fromBase58(String(s.signature).replace(/^ed25519:/, ""));
  const nonce = fromBase64(s.payload.nonce);
  if (publicKey.length !== 32 || signature.length !== 64 || nonce.length !== 32) throw new RelayError("malformed key, signature or nonce");
  if (!(await verify(publicKey, await nep413Hash(s.payload.message, nonce, s.payload.recipient), signature))) throw new RelayError("the signature doesn't match");
  if (/^[0-9a-f]{64}$/.test(msg.signer_id) && msg.signer_id !== toHex(publicKey)) throw new RelayError("the key isn't the signer's");
  return msg.signer_id;
}

/** @param {any} i @param {Config} c */
function checkIntent(i, c) {
  if (i?.intent === "auth_call") {
    if (i.contract_id !== c.contractId) throw new RelayError("auth calls are relayed only to Contri");
    if (i.attached_deposit && i.attached_deposit !== "0") throw new RelayError("auth calls can't attach NEAR");
    if (i.min_gas !== undefined) throw new RelayError("unexpected gas setting");
    return;
  }
  if (i?.intent === "transfer") {
    if (typeof i.receiver_id !== "string" || !ACCOUNT.test(i.receiver_id)) throw new RelayError("invalid receiver");
    const tokens = Object.entries(i.tokens ?? {});
    if (tokens.length !== 1 || !/^\d{1,30}$/.test(String(tokens[0][1])) || BigInt(tokens[0][1]) === 0n) throw new RelayError("a transfer moves one token");
    const toContri = i.receiver_id === c.contractId;
    // Only Contri gets a call with the transfer; anything else is a plain move of the member's own money.
    if (!toContri && (i.msg !== undefined || i.min_gas !== undefined)) throw new RelayError("transfers with a message are relayed only to Contri");
    if (toContri && typeof i.msg !== "string") throw new RelayError("a transfer to Contri needs a message");
    if (i.min_gas !== undefined && !(/^\d{1,20}$/.test(i.min_gas) && BigInt(i.min_gas) <= MAX_MIN_GAS)) throw new RelayError("too much gas asked");
    return;
  }
  throw new RelayError(`intent "${i?.intent}" isn't relayed`);
}

/**
 * Checks, simulates and submits signed intents. Returns the transaction hash
 * and Contri's events, so the app can show what happened (a new circle's id,
 * a refund's reason).
 * @param {unknown} body @param {Config} c
 */
export async function relay(body, c) {
  if (!c.contractId || !c.relayerId || !c.relayerKey) throw new RelayError("the relayer isn't set up", 503);
  const signed = /** @type {any} */ (body)?.signed;
  if (!Array.isArray(signed) || signed.length < 1 || signed.length > MAX_PAYLOADS) throw new RelayError("send 1 or 2 signed payloads");
  for (const p of signed) await checkPayload(p, c);

  /** @type {any} */
  let simulation;
  try {
    simulation = await view(c.rpcUrl, c.intentsId, "simulate_intents", { signed });
  } catch (e) {
    throw new RelayError(`NEAR Intents would reject this: ${simulationReason(e)}`);
  }
  if (simulation?.invariant_violated) throw new RelayError("NEAR Intents would reject this: the intents don't balance");

  const relayer = await signerFromSecretKey(c.relayerKey, c.relayerId);
  const { hash, result } = await sendTransaction(c.rpcUrl, relayer, c.intentsId, [
    { functionCall: { method: "execute_intents", args: { signed }, gas: 300n * TGAS, deposit: 0n } },
  ]);
  const { logs, failure } = outcome(result);
  return {
    hash,
    ok: !failure,
    failure: failure ? JSON.stringify(failure) : null,
    events: events(logs, "contri"),
    // Contri logs why it refunded a payment (wrong amount, circle full, ...).
    notes: logs.filter((l) => !l.startsWith("EVENT_JSON:")),
  };
}

/** @param {unknown} e */
function simulationReason(e) {
  const text = e instanceof Error ? e.message : String(e);
  const m = /Smart contract panicked: ([^"\\]+)/.exec(text);
  return m ? m[1] : text.slice(0, 200);
}
