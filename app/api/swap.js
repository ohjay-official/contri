// @ts-check
// POST /api/swap  { action, ... }
// Top-ups, cash-outs and the private balance, through NEAR Intents' 1Click API.
import { handler } from "../server/http.js";
import { cashOut, submitDeposit, swapStatus, topUp } from "../server/oneclick.js";
import { privateBalance, privateHome, privateMove, privateSignIn, privateSubmit, privateTopUp } from "../server/confidential.js";
import { allow } from "../server/limit.js";
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

// Actions that make 1Click open a deposit account or sign in, as opposed to
// quotes and lookups, which the app also polls.
const CREATES = new Set(["topup", "cashout", "ptopup", "pmove", "phome", "psubmit"]);

export const POST = handler(
  async (body, c, who) => {
    const run = ACTIONS[/** @type {keyof typeof ACTIONS} */ (body?.action)];
    if (!run) throw new RelayError("unknown action");
    if (who && CREATES.has(body.action) && !body.dry && !allow(`swap-create:${who}`, 12)) throw new RelayError("Too many requests. Wait a minute and try again.", 429);
    return run(body, c);
  },
  { name: "swap", perMinute: 120 },
);
