// @ts-check
// Read-only chain access for the app. The browser asks Contri's server, which
// asks a NEAR RPC node, so no RPC provider sees a member's IP address next to
// the circle accounts it looks up (which would link them). Only Contri's views
// and balance views on NEAR Intents are answered. Nothing is logged.

import { view } from "../public/js/lib/near.js";
import { RelayError } from "./relay.js";

/** @typedef {import("./config.js").Config} Config */

const CONTRI_VIEWS = new Set([
  "get_config", "get_circle", "get_circles", "get_circles_for", "get_round_deadline", "get_record", "get_credit",
  "nft_token", "nft_tokens", "nft_tokens_for_owner", "nft_supply_for_owner", "nft_total_supply", "nft_metadata",
]);
const INTENTS_VIEWS = new Set(["mt_balance_of", "mt_batch_balance_of", "current_salt"]);
const MAX_CALLS = 25;

/**
 * Runs a batch of view calls. Each result is `{ ok: value }` or `{ error }`.
 * @param {unknown} body @param {Config} c
 */
export async function views(body, c) {
  const calls = /** @type {any} */ (body)?.calls;
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > MAX_CALLS) throw new RelayError(`send 1 to ${MAX_CALLS} calls`);
  return Promise.all(
    calls.map(async (call) => {
      const { contract, method, args } = call ?? {};
      const target = contract === "contri" ? c.contractId : contract === "intents" ? c.intentsId : null;
      const allowed = contract === "contri" ? CONTRI_VIEWS : INTENTS_VIEWS;
      if (!target || !allowed.has(method)) return { error: `${contract}.${method} isn't available` };
      try {
        return { ok: await view(c.rpcUrl, target, method, args ?? {}) };
      } catch (e) {
        return { error: e instanceof Error ? e.message.slice(0, 300) : "view failed" };
      }
    }),
  );
}
