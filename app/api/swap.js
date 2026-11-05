// @ts-check
// POST /api/swap  { action, ... }
// Top-ups, cash-outs and the private balance, through NEAR Intents' 1Click API.
import { handler } from "../server/http.js";
import { cashOut, submitDeposit, swapStatus, topUp } from "../server/oneclick.js";
import { privateBalance, privateHome, privateMove, privateSignIn, privateSubmit, privateTopUp } from "../server/confidential.js";
import { RelayError } from "../server/relay.js";

const ACTIONS = {
  topup: topUp,
  cashout: cashOut,
  status: swapStatus,
  submit: submitDeposit,
  // Private balance (Confidential Intents)
  psignin: privateSignIn,
  pbalance: privateBalance,
  ptopup: privateTopUp,
  pmove: privateMove,
  psubmit: privateSubmit,
  phome: privateHome,
};

export const POST = handler(async (body, c) => {
  const run = ACTIONS[/** @type {keyof typeof ACTIONS} */ (body?.action)];
  if (!run) throw new RelayError("unknown action");
  return run(body, c);
});
