// @ts-check
// Tickets for 1Click deposit accounts.
//
// Besides Contri itself, the relayer pays gas only for transfers to a 1Click
// deposit account this server asked for in the last half hour (a cash-out, or
// a move into the private balance). /api/swap hands out a ticket with each
// one, and /api/relay checks it, so the relayer can't be used to move other
// money for free. A ticket is bound to the deposit account, the member's
// account that will pay into it and the exact amount: an expiry and an HMAC
// of all four, keyed by the relayer's key. The relayer accepts each ticket
// once (see `useOnce` in limit.js).

import { toHex } from "../public/js/lib/bytes.js";

const VALID_MS = 30 * 60_000;
const enc = new TextEncoder();

/** @param {string} secret @param {string} text */
async function mac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(`contri-ticket:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text))));
}

/**
 * A ticket for `from` to send exactly `amount` to the deposit account `account`.
 * @param {string} secret @param {string} account @param {string} from @param {bigint | string} amount @param {number} [nowMs]
 */
export async function issueTicket(secret, account, from, amount, nowMs = Date.now()) {
  const expires = nowMs + VALID_MS;
  return `${expires}.${await mac(secret, `${account}:${from}:${amount}:${expires}`)}`;
}

/**
 * The one of `tickets` issued for `from` to send `amount` to `account`, if it
 * hasn't expired, or null.
 * @param {string} secret @param {string} account @param {string} from @param {bigint | string} amount @param {unknown[]} tickets @param {number} [nowMs]
 */
export async function ticketed(secret, account, from, amount, tickets, nowMs = Date.now()) {
  for (const t of tickets) {
    const [expires, sig] = String(t).split(".");
    if (!/^\d{13}$/.test(expires ?? "") || Number(expires) < nowMs || Number(expires) > nowMs + VALID_MS) continue;
    const want = await mac(secret, `${account}:${from}:${amount}:${expires}`);
    if (sig?.length !== want.length) continue;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
    if (diff === 0) return String(t);
  }
  return null;
}
