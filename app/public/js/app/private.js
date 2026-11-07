// @ts-check
// The member's private balance: USDT on NEAR Intents' private ledger
// (Confidential Intents), held by one account derived from the passkey.
// Nobody looking at the public chain can see it or link it to the exchange
// it came from. 1Click and Contri's server see which circle accounts it pays,
// and NEAR Intents' operators run the private ledger.
//
// Every move out of it is an intent 1Click builds and this phone signs, after
// checking it moves exactly what the member asked (lib/private.js).

import { fromBase64, toBase58 } from "../lib/bytes.js";
import { nep413Hash, transfer } from "../lib/intents.js";
import { checkPrivateMove } from "../lib/private.js";
import { getConfig, relay, sign, swap } from "./api.js";
import { sleep } from "./ui.js";
import { logMove, signer, vault } from "./wallet.js";

/** A 1Click session to read the private balance: about 15 minutes, kept in memory only. */
/** @type {{ token: string, until: number, account: string } | null} */
let session = null;

async function signIn() {
  const v = await vault();
  if (session?.account === v.accountId && session.until > Date.now() + 30_000) return session.token;
  // An empty intent, signed by the private account: proves it's the member's, moves nothing.
  const signed = await sign(v, [], { validForMs: 4 * 60_000 });
  const r = await swap("psignin", { signed });
  session = { token: r.session, until: Date.now() + Number(r.expiresIn ?? 900) * 1000, account: v.accountId };
  return session.token;
}

/** The private balance, in token units. */
export async function privateBalance() {
  try {
    return BigInt((await swap("pbalance", { session: await signIn() })).amount);
  } catch {
    // The session may have expired early: sign in once more.
    session = null;
    return BigInt((await swap("pbalance", { session: await signIn() })).amount);
  }
}

/**
 * A one-time deposit address that adds `amount` (token units) to the private
 * balance. Kept on this device until it's used or expires, so a reload
 * doesn't lose it.
 * @param {string} network @param {bigint} amount
 */
export async function addPrivately(network, amount) {
  const v = await vault();
  const q = await swap("ptopup", { network, vault: v.accountId, amount: amount.toString() });
  await logMove({ kind: "private-topup", depositAddress: q.depositAddress, amount: `${q.send} ${q.symbol}`, network: q.label });
  try {
    localStorage.setItem(`contri.ptopup.${v.accountId.slice(0, 16)}`, JSON.stringify(q));
  } catch {}
  return q;
}

/** The last private top-up address, while it's still valid. */
export async function pendingPrivateTopUp() {
  const v = await vault();
  try {
    const q = JSON.parse(localStorage.getItem(`contri.ptopup.${v.accountId.slice(0, 16)}`) ?? "null");
    return q && Date.parse(q.deadline) > Date.now() ? q : null;
  } catch {
    return null;
  }
}

/** Forgets the last private top-up address once it's been used. */
export async function clearPrivateTopUp() {
  const v = await vault();
  try {
    localStorage.removeItem(`contri.ptopup.${v.accountId.slice(0, 16)}`);
  } catch {}
}

/**
 * Moves money out of the private balance: to one of the member's circle
 * accounts (`{ to }`), or to an address on another chain (`{ network, address }`).
 * @param {{ to: string } | { network: string, address: string }} destination @param {bigint} amount
 * @returns {Promise<{ depositAddress: string, receive: string, fee: string, seconds: number }>}
 */
export async function moveOut(destination, amount) {
  const [cfg, v] = await Promise.all([getConfig(), vault()]);
  const want = amount.toString();
  const q = await swap("pmove", { vault: v.accountId, amount: want, ...destination });
  const payload = q.intent?.payload;
  if (q.intent?.standard !== "nep413" || typeof payload?.message !== "string") throw new Error("1Click sent something unexpected to sign. Nothing was moved.");
  try {
    checkPrivateMove(payload.message, { signer: v.accountId, tokenId: cfg.tokenId, depositAddress: q.depositAddress, amount: want });
  } catch (e) {
    throw new Error(`Not signed: ${e instanceof Error ? e.message : e}. Nothing was moved.`);
  }
  const signature = await v.sign(await nep413Hash(payload.message, fromBase64(payload.nonce), payload.recipient));
  await swap("psubmit", { signed: { standard: "nep413", payload, public_key: v.publicKeyStr, signature: `ed25519:${toBase58(signature)}` } });
  await logMove(
    "to" in destination
      ? { kind: "private-to-circle", depositAddress: q.depositAddress, amount: `${q.receive} USDT`, account: destination.to }
      : { kind: "private-cashout", depositAddress: q.depositAddress, amount: q.receive, network: destination.network, to: destination.address },
  );
  return q;
}

/**
 * Moves money from a circle account into the private balance: a plain
 * transfer, signed by the circle account, to a 1Click deposit account.
 * @param {number} index the circle account (slot) @param {bigint} amount
 */
export async function moveHome(index, amount) {
  const [cfg, v, s] = await Promise.all([getConfig(), vault(), signer(index)]);
  const q = await swap("phome", { from: s.accountId, vault: v.accountId, amount: amount.toString() });
  const r = await relay([await sign(s, [transfer(q.depositAddress, cfg.tokenId, amount)])], [q.ticket]);
  await swap("submit", { txHash: r.hash, depositAddress: q.depositAddress }).catch(() => null);
  await logMove({ kind: "to-private", depositAddress: q.depositAddress, amount: `${q.receive} USDT`, account: s.accountId, tx: r.hash });
  return /** @type {{ depositAddress: string, receive: string, seconds: number }} */ (q);
}

/** 1Click's swap states, in the member's words. @type {Record<string, string>} */
export const STATUS = {
  PENDING_DEPOSIT: "Waiting for your deposit",
  KNOWN_DEPOSIT_TX: "Your deposit is on its way",
  INCOMPLETE_DEPOSIT: "Less arrived than this address needs. Check the amount you sent.",
  PROCESSING: "Received. Moving it on.",
  SUCCESS: "Arrived",
  REFUNDED: "It couldn't go through, so the money was refunded.",
  FAILED: "It failed. Keep this deposit address: it is how the money can be traced.",
};

/**
 * What a status means for the member. A short deposit says how much more to
 * send to the same address.
 * @param {{ status: string, need?: string | null, got?: string | null, short?: string | null } | null} st
 */
export function statusText(st) {
  if (st?.status === "INCOMPLETE_DEPOSIT" && st.short) return `${st.got} of ${st.need} arrived. Send ${st.short} more to the same address, on the same network, before it expires; the extra arrives with it.`;
  return st?.status ? STATUS[st.status] ?? st.status : "";
}

/**
 * Follows a 1Click deposit address until it finishes, the screen closes, or
 * `minutes` pass. Calls `onStatus` with each new state, and the status
 * itself. Returns the last state.
 * @param {string} depositAddress @param {(status: string, st: any) => void} onStatus @param {Element} screen @param {number} [minutes]
 */
export async function follow(depositAddress, onStatus, screen, minutes = 30) {
  let last = "";
  for (let i = 0; i < minutes * 12 && screen.isConnected; i++) {
    const st = await swap("status", { depositAddress }).catch(() => null);
    if (st?.status && st.status !== last) {
      last = st.status;
      onStatus(last, st);
    }
    if (["SUCCESS", "REFUNDED", "FAILED"].includes(last)) break;
    await sleep(5000);
  }
  return last;
}
