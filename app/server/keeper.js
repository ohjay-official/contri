// @ts-check
// The keeper: calls Contri's anyone-can-call methods when a circle needs them.
// The contract pays the pot out by itself when the last member pays; the
// keeper handles the rest: a round whose deadline passed with someone unpaid
// (settle_round), a payout to retry (pay_out), a circle that never filled
// by its fill_by time (cancel_circle), and deposits to send back once a
// circle ends (release_deposits), then closing a cancelled circle once
// everyone is paid back (close_circle), which frees the contract's storage.
// It runs on a schedule and whenever the app opens a circle that needs it.
// Anyone could run it; it holds no special rights.

import { needs } from "../public/js/lib/contri.js";
import { signerFromSecretKey } from "../public/js/lib/keys.js";
import { outcome, rpc, sendTransaction, TGAS, view } from "../public/js/lib/near.js";
import { RelayError } from "./relay.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("../public/js/lib/contri.js").Circle} Circle */

export { needs };

const GAS = { settle_round: 150n * TGAS, pay_out: 100n * TGAS, cancel_circle: 30n * TGAS, release_deposits: 250n * TGAS, close_circle: 30n * TGAS };

/**
 * Checks one circle (`body.circle`) or every circle, and acts where needed.
 * @param {any} body @param {Config} c @param {number} [nowMs] defaults to the latest final block's time
 */
export async function keep(body, c, nowMs) {
  if (!c.contractId || !c.relayerId || !c.relayerKey) throw new RelayError("the keeper isn't set up", 503);
  // The contract goes by block time, so the keeper does too.
  const now = nowMs ?? Number(BigInt((await rpc(c.rpcUrl, "block", { finality: "final" })).header.timestamp_nanosec) / 1_000_000n);
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

  const all = circles.map((circle) => ({ circle: circle.id, method: needs(circle, now) })).filter((t) => t.method);
  // A pay_out only retries a payout whose transfer failed. Settling and
  // releasing come first, and at most two retries a run, so a circle whose
  // transfers keep failing can't crowd out the others or burn the relayer's NEAR.
  const retries = all.filter((t) => t.method === "pay_out").slice(0, 2);
  const todo = [...all.filter((t) => t.method !== "pay_out"), ...retries];
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
