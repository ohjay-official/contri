// @ts-check
// POST /api/swap  { action: "topup" | "cashout" | "status" | "submit", ... }
// Top-ups and cash-outs through NEAR Intents' 1Click API.
import { handler } from "../server/http.js";
import { cashOut, submitDeposit, swapStatus, topUp } from "../server/oneclick.js";
import { RelayError } from "../server/relay.js";

const ACTIONS = { topup: topUp, cashout: cashOut, status: swapStatus, submit: submitDeposit };

export const POST = handler(async (body, c) => {
  const run = ACTIONS[/** @type {keyof typeof ACTIONS} */ (body?.action)];
  if (!run) throw new RelayError("unknown action");
  return run(body, c);
});
