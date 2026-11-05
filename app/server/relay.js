// @ts-check
// The relayer: submits members' signed intents to NEAR Intents and pays the
// gas, so members never need NEAR.
//
// It only relays what a Contri member needs, in Contri's token:
//   - transfers to the Contri contract, with a message Contri understands;
//   - Contri auth calls from a member or the organizer of that circle (or from
//     someone with a credit to claim);
//   - plain transfers to a 1Click deposit account this server opened in the
//     last half hour (a cash-out, or a move into the private balance), which
//     come with the ticket /api/swap gave for it (see ticket.js).
// Every payload's signature is checked here, then simulated by NEAR Intents
// (`simulate_intents`), before any gas is spent. Requests are also limited
// per caller and per signer (see limit.js).
//
// Nothing is logged or stored: no IP addresses, no accounts, no payloads.

import { fromBase58, fromBase64, toHex } from "../public/js/lib/bytes.js";
import { nep413Hash } from "../public/js/lib/intents.js";
import { signerFromSecretKey, verify } from "../public/js/lib/keys.js";
import { events, outcome, sendTransaction, TGAS, view } from "../public/js/lib/near.js";
import { allow } from "./limit.js";
import { ticketed } from "./ticket.js";

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
const N = "\\d{1,20}";
/** What Contri's `mt_on_transfer` reads (the contract's `parse_transfer`). */
const TRANSFER_MSG = new RegExp(`^(create:${N}:${N}:${N}:(join|random):(-|[0-9a-fA-F]{64}):[\\s\\S]{1,256}|join:${N}(:[0-9a-fA-F]{128})?|contribute:${N}:${N}|buy_seat:${N}:${N}|back:${N}|refill:${N})$`);
/** What Contri's `on_auth` reads (the contract's `parse_auth`). */
const AUTH_MSG = new RegExp(`^(claim_credit|list_seat:${N}:${N}:${N}|unlist_seat:${N}:${N}|cancel:${N}|leave:${N})$`);

/**
 * Checks one signed payload against what Contri relays. Returns the signer.
 * @param {unknown} p @param {Config} c @param {number} [nowMs] @param {unknown[]} [tickets] for transfers to 1Click deposit accounts
 */
export async function checkPayload(p, c, nowMs = Date.now(), tickets = []) {
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
  for (const i of msg.intents) {
    if (i.intent === "transfer" && i.receiver_id !== c.contractId && !(await ticketed(c.relayerKey, i.receiver_id, tickets, nowMs))) {
      throw new RelayError("money leaves Contri only for a deposit account Contri just set up; start again to get a new one");
    }
  }

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
    if (typeof i.msg !== "string" || !AUTH_MSG.test(i.msg)) throw new RelayError("Contri wouldn't understand this request");
    return;
  }
  if (i?.intent === "transfer") {
    if (typeof i.receiver_id !== "string" || !ACCOUNT.test(i.receiver_id)) throw new RelayError("invalid receiver");
    const tokens = Object.entries(i.tokens ?? {});
    if (tokens.length !== 1 || !/^\d{1,30}$/.test(String(tokens[0][1])) || BigInt(tokens[0][1]) === 0n) throw new RelayError("a transfer moves one token");
    if (tokens[0][0] !== c.tokenId) throw new RelayError("only Contri's token is relayed");
    const toContri = i.receiver_id === c.contractId;
    // Only Contri gets a call with the transfer; anything else is a plain move of the member's own money.
    if (!toContri && (i.msg !== undefined || i.min_gas !== undefined)) throw new RelayError("transfers with a message are relayed only to Contri");
    if (toContri && typeof i.msg !== "string") throw new RelayError("a transfer to Contri needs a message");
    if (toContri && !TRANSFER_MSG.test(i.msg)) throw new RelayError("Contri wouldn't understand this payment");
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
  const given = /** @type {any} */ (body)?.tickets;
  const tickets = Array.isArray(given) ? given.slice(0, 4) : [];
  for (const p of signed) {
    const signer = await checkPayload(p, c, Date.now(), tickets);
    if (!allow(`relay-signer:${signer}`, 10)) throw new RelayError("Too many requests from this account. Wait a minute and try again.", 429);
    await checkAuthCalls(p, signer, c);
  }

  /** @type {any} */
  let simulation;
  try {
    simulation = await view(c.rpcUrl, c.intentsId, "simulate_intents", { signed });
  } catch (e) {
    throw new RelayError(`NEAR Intents would reject this: ${simulationReason(e)}`);
  }
  if (simulation?.invariant_violated) throw new RelayError("NEAR Intents would reject this: the intents don't balance");

  const relayer = await signerFromSecretKey(c.relayerKey, c.relayerId);
  /** @type {Awaited<ReturnType<typeof sendTransaction>>} */
  let sent;
  try {
    sent = await sendTransaction(c.rpcUrl, relayer, c.intentsId, [
      { functionCall: { method: "execute_intents", args: { signed }, gas: 300n * TGAS, deposit: 0n } },
    ]);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (/NotEnoughBalance|LackBalanceForState/i.test(text)) throw new RelayError("Contri can't pay the network fee right now. Nothing was taken from your balance; try again later.", 503);
    // Sent but not confirmed in time: it may still go through, so don't say it didn't.
    if (/TIMEOUT|timed? ?out|HTTP 50\d|fetch failed/i.test(text)) throw new RelayError("NEAR is slow to confirm right now. Refresh in a minute to see whether it went through before trying again.", 504);
    if (/InvalidTxError|InvalidNonce|Expired/i.test(text)) throw new RelayError("NEAR didn't accept the transaction. Nothing was taken from your balance; try again.", 502);
    throw new RelayError("Something went wrong sending this to NEAR. Refresh in a minute to see whether it went through before trying again.", 502);
  }
  const { hash, result } = sent;
  const { logs, failure } = outcome(result);
  return {
    hash,
    ok: !failure,
    failure: failure ? JSON.stringify(failure) : null,
    events: events(logs, "contri"),
    // Contri logs why it refunded a payment (wrong amount, circle full, ...).
    notes: logs.filter((l) => !l.startsWith("EVENT_JSON:")).map(memberNote),
  };
}

/**
 * An auth call comes from someone it's about: a member or the organizer of
 * the circle, or, to claim a credit, someone who has one. One view each.
 * @param {any} p @param {string} signer @param {Config} c
 */
async function checkAuthCalls(p, signer, c) {
  for (const i of JSON.parse(p.payload.message).intents) {
    if (i.intent !== "auth_call") continue;
    if (i.msg === "claim_credit") {
      const owed = await view(c.rpcUrl, c.contractId, "get_credit", { account_id: signer }).catch(() => "0");
      if (BigInt(owed ?? "0") === 0n) throw new RelayError("there's no credit to claim");
      continue;
    }
    const circle = await view(c.rpcUrl, c.contractId, "get_circle", { circle_id: Number(i.msg.split(":")[1]) }).catch(() => null);
    const involved = circle && (circle.organizer === signer || circle.members.some((/** @type {any} */ m) => m.account_id === signer));
    if (!involved) throw new RelayError("only the circle's members can do that");
  }
}

/**
 * A refund reason from the contract ("contri: refunding 5000000: circle is
 * full"), in the member's words, without a full stop so the app can add to it.
 * @param {string} log
 */
export function memberNote(log) {
  const reason = log.replace(/^contri: refunding \d+: /, "");
  if (/out of storage room/.test(reason)) return "Contri is full right now and can't take new circles or members. Try again later";
  if (/at least 1 USDT/.test(reason)) return "The amount each round has to be at least $1";
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

/** NEAR Intents' reasons, in the member's words. */
const REASONS = [
  [/insufficient balance|overflow/i, "there isn't enough money in this circle's account yet"],
  [/nonce.*(used|expired)|deadline|expired/i, "this request expired; try again"],
  [/invalid signature|signature/i, "the signature didn't check out; reopen the app and try again"],
];

/** @param {unknown} e */
function simulationReason(e) {
  const text = e instanceof Error ? e.message : String(e);
  for (const [re, words] of REASONS) if (/** @type {RegExp} */ (re).test(text)) return /** @type {string} */ (words);
  const m = /panic_msg: \\?"([^"\\]+)/.exec(text) ?? /Smart contract panicked: ([^"\\]+)/.exec(text);
  return m ? m[1] : text.slice(0, 200);
}
