// @ts-check
// The keeper: calls Contri's anyone-can-call methods when a circle needs them.
// The contract pays the pot out by itself when the last member pays; the
// keeper handles the rest: a round whose deadline passed with someone unpaid
// (settle_round), a payout to retry (pay_out), and deposits to send back once
// a circle ends (release_deposits). It runs on a schedule and whenever the app
// opens a circle that needs it. Anyone could run it; it holds no special rights.

import { signerFromSecretKey } from "../public/js/lib/keys.js";
import { outcome, sendTransaction, TGAS, view } from "../public/js/lib/near.js";
import { RelayError } from "./relay.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("../public/js/lib/contri.js").Circle} Circle */

/**
 * What a circle needs now, if anything.
 * @param {Circle} c @param {number} nowMs
 * @returns {"settle_round" | "pay_out" | "release_deposits" | null}
 */
export function needs(c, nowMs) {
  if (c.paying) return null;
  if (c.status === "Active") {
    if (c.members.every((m) => m.paid_this_round)) return "pay_out";
    const deadline = c.round_deadline ? Number(BigInt(c.round_deadline) / 1_000_000n) : Infinity;
    return nowMs > deadline ? "settle_round" : null;
  }
  if (c.status === "Finished" || c.status === "Cancelled") {
    const owed = c.members.some((m) => BigInt(m.deposit) > 0n) || c.backers.some((b) => BigInt(b.due) > 0n);
    return owed ? "release_deposits" : null;
  }
  return null;
}

const GAS = { settle_round: 150n * TGAS, pay_out: 100n * TGAS, release_deposits: 250n * TGAS };

/**
 * Checks one circle (`body.circle`) or every circle, and acts where needed.
 * @param {any} body @param {Config} c @param {number} [nowMs]
 */
export async function keep(body, c, nowMs = Date.now()) {
  if (!c.contractId || !c.relayerId || !c.relayerKey) throw new RelayError("the keeper isn't set up", 503);
  /** @type {Circle[]} */
  let circles;
  if (body?.circle !== undefined) {
    const id = Number(body.circle);
    if (!Number.isSafeInteger(id) || id < 0) throw new RelayError("invalid circle");
    const one = await view(c.rpcUrl, c.contractId, "get_circle", { circle_id: id });
    circles = one ? [one] : [];
  } else {
    circles = [];
    for (let from = 0; ; from += 100) {
      const page = await view(c.rpcUrl, c.contractId, "get_circles", { from_index: from, limit: 100 });
      circles.push(...page);
      if (page.length < 100) break;
    }
  }

  const todo = circles.map((circle) => ({ circle: circle.id, method: needs(circle, nowMs) })).filter((t) => t.method);
  if (!todo.length) return { done: [] };
  const keeper = await signerFromSecretKey(c.relayerKey, c.relayerId);
  const done = [];
  // One at a time: they share the relayer's nonce.
  for (const t of todo.slice(0, 10)) {
    const method = /** @type {keyof typeof GAS} */ (t.method);
    try {
      const { hash, result } = await sendTransaction(c.rpcUrl, keeper, c.contractId, [
        { functionCall: { method, args: { circle_id: t.circle }, gas: GAS[method], deposit: 0n } },
      ]);
      done.push({ ...t, hash, ok: !outcome(result).failure });
    } catch (e) {
      done.push({ ...t, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "failed" });
    }
  }
  return { done };
}
