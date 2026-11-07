// @ts-check
// Top-ups and cash-outs through NEAR Intents' 1Click API. The API key stays on
// the server. 1Click sees a deposit address and a destination, never who the
// member is: Contri sends no names, emails or IP addresses. Every swap asks for
// the confidential route (see `confidential`), so a deposit address can't be
// looked up publicly to find the circle account it paid.
//
// Top up:   stablecoin on another chain -> 1Click deposit address -> the
//           member's circle account on NEAR Intents (as USDT).
// Cash out: the member signs a transfer from their circle account to a 1Click
//           deposit account inside NEAR Intents -> stablecoin on any chain.
// Refunds go back to the member's circle account, so no other address is asked for.

import { RelayError } from "./relay.js";
import { issueTicket } from "./ticket.js";

/** @typedef {import("./config.js").Config} Config */

/**
 * Networks members pay from and cash out to. Asset ids are 1Click's.
 * @type {Record<string, { label: string, symbol: string, asset: string, decimals: number, address: RegExp }>}
 */
export const NETWORKS = {
  bsc: { label: "BNB Smart Chain (BEP20)", symbol: "USDT", asset: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g", decimals: 18, address: /^0x[0-9a-fA-F]{40}$/ },
  sol: { label: "Solana", symbol: "USDT", asset: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", decimals: 6, address: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ },
  tron: { label: "Tron (TRC20)", symbol: "USDT", asset: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", decimals: 6, address: /^T[1-9A-HJ-NP-Za-km-z]{33}$/ },
  ton: { label: "TON", symbol: "USDT", asset: "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR", decimals: 6, address: /^[A-Za-z0-9_-]{48}$|^-?\d:[0-9a-fA-F]{64}$/ },
  base: { label: "Base", symbol: "USDC", asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, address: /^0x[0-9a-fA-F]{40}$/ },
  arb: { label: "Arbitrum", symbol: "USDC", asset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", decimals: 6, address: /^0x[0-9a-fA-F]{40}$/ },
  eth: { label: "Ethereum (ERC20)", symbol: "USDT", asset: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near", decimals: 6, address: /^0x[0-9a-fA-F]{40}$/ },
};

export const TOKEN_DECIMALS = 6;
export const IMPLICIT_OR_NAMED = /^[0-9a-f]{64}$|^(([a-z\d]+[-_])*[a-z\d]+\.)+[a-z\d]+$/;

/** @param {Config} c @param {object} body */
export async function quote(c, body) {
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (c.oneClickKey) headers["X-API-Key"] = c.oneClickKey;
  const res = await fetch(`${c.oneClickUrl}/v0/quote`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new RelayError(json.message ? `1Click: ${json.message}` : `1Click quote failed (${res.status})`, res.status >= 500 ? 502 : 400);
  return json.quote;
}

/** @param {unknown} v @param {string} what */
export function units(v, what) {
  if (typeof v !== "string" || !/^\d{1,18}$/.test(v) || BigInt(v) === 0n) throw new RelayError(`invalid ${what}`);
  if (BigInt(v) > MAX_UNITS) throw new RelayError("Contri moves up to $10,000 at a time");
  return BigInt(v);
}

/** The most one top-up, cash-out or move can be: $10,000 in USDT's six decimals. */
const MAX_UNITS = 10_000_000_000n;

/** @param {unknown} network */
export function net(network) {
  const n = NETWORKS[/** @type {string} */ (network)];
  if (!n) throw new RelayError("unsupported network");
  return n;
}

/** @param {number} minutes */
export const deadline = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

/**
 * With Contri's partner key, swaps go through NEAR Intents' confidential
 * route: 1Click's public status lookup then shows nothing for the deposit
 * address (it answers 404), instead of the circle account it pays and the
 * wallet it came from. Without a key 1Click refuses confidential quotes, so
 * they're asked for only when there is one.
 * @param {Config} c
 */
export const confidential = (c) => (c.oneClickKey ? { confidentiality: "basic" } : {});

/**
 * Contri's fee, for top-ups and cash-outs only: 1Click takes it from what is
 * sent, before the swap, and pays it to `feeAccount`. With a 1Click key, 1Click
 * keeps half of it.
 * @param {Config} c
 */
export const fee = (c) => (c.feeBps > 0 && c.feeAccount ? { appFees: [{ recipient: c.feeAccount, fee: c.feeBps }] } : {});

/** Contri's fee in hundredths of a percent, or 0 when there is none. @param {Config} c */
export const feeBpsOf = (c) => (fee(c).appFees ? c.feeBps : 0);

/** Contri's fee on `units` of a token with `decimals`, in that token, rounded up to the cent; null without a fee. @param {Config} c @param {bigint} units @param {number} decimals */
export const feeAmount = (c, units, decimals) => (feeBpsOf(c) ? formatUnits((units * BigInt(feeBpsOf(c))) / 10_000n, decimals) : null);

/** Contri's fee as members read it ("0.25%"), or null when there is none. @param {Config} c */
export const feeShown = (c) => (fee(c).appFees ? `${(c.feeBps / 100).toFixed(2).replace(/0$/, "")}%` : null);

/**
 * A deposit address that turns about `amount` (token units) sent on `network`
 * into USDT in `account`'s NEAR Intents balance. FLEX_INPUT: sending a bit more
 * or less still works, and anything extra stays in the member's balance.
 * @param {any} body @param {Config} c
 */
export async function topUp(body, c) {
  const n = net(body.network);
  const want = units(body.amount, "amount");
  if (!IMPLICIT_OR_NAMED.test(String(body.account))) throw new RelayError("invalid account");
  const send = toSend(want, n.decimals, feeBpsOf(c));
  const q = await quote(c, {
    dry: false,
    swapType: "FLEX_INPUT",
    slippageTolerance: 100,
    originAsset: n.asset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: c.tokenId,
    amount: send.toString(),
    recipient: body.account,
    recipientType: "INTENTS",
    refundTo: body.account,
    refundType: "INTENTS",
    deadline: deadline(24 * 60),
    referral: "contri",
    ...confidential(c),
    ...fee(c),
  });
  return {
    network: body.network,
    label: n.label,
    symbol: n.symbol,
    depositAddress: q.depositAddress,
    depositMemo: q.depositMemo ?? null,
    send: formatUnits(BigInt(q.amountIn), n.decimals),
    minSend: formatUnits(BigInt(q.minAmountIn), n.decimals),
    receive: formatDown(BigInt(q.amountOut), TOKEN_DECIMALS),
    contriFee: feeShown(c),
    contriFeeUsd: feeAmount(c, BigInt(q.amountIn), n.decimals),
    deadline: q.deadline,
    seconds: q.timeEstimate,
  };
}

/**
 * A 1Click deposit account inside NEAR Intents that sends `amount` USDT on to
 * `address` on `network`. The member then signs a transfer to it.
 * @param {any} body @param {Config} c
 */
export async function cashOut(body, c) {
  const n = net(body.network);
  const amount = units(body.amount, "amount");
  if (!n.address.test(String(body.address))) throw new RelayError(`that isn't a ${n.label} address`);
  if (!IMPLICIT_OR_NAMED.test(String(body.account))) throw new RelayError("invalid account");
  const q = await quote(c, {
    dry: Boolean(body.dry),
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: c.tokenId,
    depositType: "INTENTS",
    destinationAsset: n.asset,
    amount: amount.toString(),
    recipient: body.address,
    recipientType: "DESTINATION_CHAIN",
    refundTo: body.account,
    refundType: "INTENTS",
    deadline: deadline(30),
    referral: "contri",
    ...confidential(c),
    ...fee(c),
  });
  return {
    network: body.network,
    label: n.label,
    symbol: n.symbol,
    depositAddress: q.depositAddress ?? null,
    // Lets the relayer pay for the member's transfer to it (see ticket.js).
    ticket: q.depositAddress ? await issueTicket(c.relayerKey, q.depositAddress, body.account, amount) : null,
    receive: formatDown(BigInt(q.amountOut), n.decimals),
    fee: q.withdrawFee ? formatUnits(BigInt(q.withdrawFee), n.decimals) : "0",
    contriFee: feeShown(c),
    contriFeeUsd: feeAmount(c, amount, TOKEN_DECIMALS),
    seconds: q.timeEstimate,
  };
}

/** Where a top-up or cash-out is. @param {any} body @param {Config} c */
export async function swapStatus(body, c) {
  const address = String(body.depositAddress ?? "");
  if (!/^[A-Za-z0-9:_.-]{20,100}$/.test(address)) throw new RelayError("invalid deposit address");
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" };
  if (c.oneClickKey) headers["X-API-Key"] = c.oneClickKey;
  const res = await fetch(`${c.oneClickUrl}/v0/status?depositAddress=${encodeURIComponent(address)}`, { headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new RelayError(json.message ?? `1Click status failed (${res.status})`, 502);
  return { status: json.status, updatedAt: json.updatedAt ?? null };
}

/** Tells 1Click about a deposit so it is picked up sooner. @param {any} body @param {Config} c */
export async function submitDeposit(body, c) {
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (c.oneClickKey) headers["X-API-Key"] = c.oneClickKey;
  const res = await fetch(`${c.oneClickUrl}/v0/deposit/submit`, {
    method: "POST",
    headers,
    body: JSON.stringify({ txHash: String(body.txHash), depositAddress: String(body.depositAddress) }),
  });
  return { ok: res.ok };
}

/** Rounded down to the cent: what arrives is never overstated. @param {bigint} v @param {number} decimals */
export function formatDown(v, decimals) {
  const cents = (v * 100n) / 10n ** BigInt(decimals);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/**
 * What to ask a member to send for `want` (token units) to arrive: 0.5% more
 * for swap and bridge costs, plus Contri's fee (`feeBps`), so neither leaves
 * them short, rounded up to whole cents
 * so the amount is easy to type, in the sending network's decimals.
 * @param {bigint} want @param {number} decimals @param {number} [feeBps]
 */
export function toSend(want, decimals, feeBps = 0) {
  const CENT = 10n ** BigInt(TOKEN_DECIMALS - 2);
  const cents = ((want * (10_050n + BigInt(feeBps))) / 10_000n + CENT - 1n) / CENT;
  return cents * CENT * 10n ** BigInt(decimals - TOKEN_DECIMALS);
}

/** @param {bigint} v @param {number} decimals */
export function formatUnits(v, decimals) {
  const base = 10n ** BigInt(decimals);
  const cents = (v * 100n + base - 1n) / base; // round up: never tell someone to send too little
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
