// @ts-check
// The Contri contract's messages, and helpers to read a circle's state.
// Formats are documented in docs/METHODS.md and docs/ARCHITECTURE.md.

import { authCall, transfer } from "./intents.js";

/** USDT and USDC on NEAR use 6 decimals. */
export const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);

/** Gas NEAR Intents attaches to Contri's `mt_on_transfer`. The last contribution of a round pays the pot out, so it gets more. */
const GAS = { create: "30000000000000", join: "50000000000000", contribute: "100000000000000", seat: "50000000000000", deposit: "30000000000000" };

/**
 * @typedef {object} Member
 * @property {string} account_id @property {string} deposit @property {boolean} paid_this_round
 * @property {boolean} defaulted @property {number} missed
 *
 * @typedef {object} Circle
 * @property {number} id @property {string} name @property {string} organizer @property {string} contribution
 * @property {number} size @property {number} period_secs @property {Member[]} members
 * @property {(string | null)[]} listings @property {boolean} invite_only @property {boolean} random_order
 * @property {string} fill_by @property {string} backing @property {{account_id: string, amount: string, due: string}[]} backers
 * @property {"Open" | "Active" | "Finished" | "Cancelled"} status @property {string} created_at @property {string} started_at
 * @property {number} round @property {string} pot @property {boolean} paying
 * @property {{round: number, to: string, amount: string, shortfall: string, at: string}[]} payouts
 * @property {string | null} round_deadline
 */

/**
 * Builds the intents for each action a member can take. `contract` is
 * Contri's account and `token` the circle asset, e.g. `nep141:usdt.tether-token.near`.
 * @param {string} contract @param {string} token
 */
export function actions(contract, token) {
  /** @param {bigint | string} amount @param {string} msg @param {string} minGas */
  const pay = (amount, msg, minGas) => [transfer(contract, token, amount, { msg, minGas })];
  return {
    /**
     * Creates a circle and takes its first seat, paying one contribution as the deposit.
     * @param {{ contribution: bigint, size: number, periodSecs: number, random: boolean, inviteKeyHex: string | null, name: string }} c
     */
    create: (c) =>
      pay(c.contribution, `create:${c.contribution}:${c.size}:${c.periodSecs}:${c.random ? "random" : "join"}:${c.inviteKeyHex ?? "-"}:${c.name}`, GAS.create),
    /** @param {number} circle @param {bigint | string} deposit @param {string | null} inviteSig */
    join: (circle, deposit, inviteSig) => pay(deposit, inviteSig ? `join:${circle}:${inviteSig}` : `join:${circle}`, GAS.join),
    /** @param {number} circle @param {number} round @param {bigint | string} amount */
    contribute: (circle, round, amount) => pay(amount, `contribute:${circle}:${round}`, GAS.contribute),
    /** @param {number} circle @param {number} seat @param {bigint | string} price */
    buySeat: (circle, seat, price) => pay(price, `buy_seat:${circle}:${seat}`, GAS.seat),
    /** @param {number} circle @param {bigint | string} amount */
    refill: (circle, amount) => pay(amount, `refill:${circle}`, GAS.deposit),
    /** @param {number} circle @param {bigint | string} amount */
    back: (circle, amount) => pay(amount, `back:${circle}`, GAS.deposit),
    /** @param {number} circle */
    leave: (circle) => [authCall(contract, `leave:${circle}`)],
    /** @param {number} circle @param {number} seat @param {bigint | string} price */
    listSeat: (circle, seat, price) => [authCall(contract, `list_seat:${circle}:${seat}:${price}`)],
    /** @param {number} circle @param {number} seat */
    unlistSeat: (circle, seat) => [authCall(contract, `unlist_seat:${circle}:${seat}`)],
    /** @param {number} circle */
    cancel: (circle) => [authCall(contract, `cancel:${circle}`)],
    claimCredit: () => [authCall(contract, "claim_credit")],
  };
}

/**
 * "12.5" -> 12500000n. Rejects more decimals than the token has.
 * @param {string} s
 */
export function parseAmount(s) {
  const m = /^\s*(\d{1,12})(?:\.(\d{1,6}))?\s*$/.exec(s);
  if (!m) throw new Error("enter an amount like 5 or 2.50");
  return BigInt(m[1]) * UNIT + BigInt((m[2] ?? "").padEnd(DECIMALS, "0"));
}

/**
 * 12500000n -> "12.50". Whole cents, trailing zeros trimmed past them.
 * @param {bigint | string} v
 */
export function formatAmount(v) {
  const n = BigInt(v);
  const whole = n / UNIT;
  const frac = (n % UNIT).toString().padStart(DECIMALS, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole.toLocaleString("en-US")}.${frac}`;
}

/** @param {Circle} c @param {string} account */
export const seatOf = (c, account) => c.members.findIndex((m) => m.account_id === account);

/** The full pot each round. @param {Circle} c */
export const potSize = (c) => BigInt(c.contribution) * BigInt(c.size);

/**
 * What a member has to do now, if anything.
 * @param {Circle} c @param {string} account @param {number} [nowMs]
 * @returns {"join" | "wait" | "pay" | "paid" | "done" | "none"}
 */
export function dueFor(c, account, nowMs = Date.now()) {
  const seat = seatOf(c, account);
  if (c.status === "Open") return seat < 0 ? "join" : "wait";
  if (c.status !== "Active" || seat < 0) return seat < 0 ? "none" : "done";
  if (c.members[seat].paid_this_round) return "paid";
  const deadline = c.round_deadline ? Number(BigInt(c.round_deadline) / 1_000_000n) : Infinity;
  return nowMs < deadline ? "pay" : "wait";
}

/** @param {Circle} c */
export const roundDeadlineMs = (c) => (c.round_deadline ? Number(BigInt(c.round_deadline) / 1_000_000n) : null);

/**
 * When a seat's member receives the pot.
 * @param {Circle} c @param {number} seat
 */
export function payoutDateMs(c, seat) {
  if (c.status !== "Active" && c.status !== "Finished") return null;
  const start = Number(BigInt(c.started_at) / 1_000_000n);
  return start + (seat + 1) * c.period_secs * 1000;
}

/** Short form of an implicit account for display: `a3f9…0c1d`. @param {string} account */
export const shortAccount = (account) => (/^[0-9a-f]{64}$/.test(account) ? `${account.slice(0, 4)}…${account.slice(-4)}` : account);

/** Contri events in a transaction's logs. @param {{ event: string, data: any[] }[]} evs @param {string} name */
export const findEvent = (evs, name) => evs.find((e) => e.event === name)?.data?.[0];

/**
 * What a circle needs from the keeper now, if anything. Shared by the
 * keeper and the app, which asks the keeper when it sees a circle that needs it.
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
