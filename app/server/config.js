// @ts-check
// Server settings, from environment variables (Vercel project settings, or
// GitHub secrets in CI). Nothing here is ever sent to the browser except
// what `publicConfig` returns.

import { sharedLimits } from "./limit.js";

/** @param {string} name @param {string} fallback @returns {string} */
const env = (name, fallback) => {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
};

export function config() {
  const network = env("NEAR_NETWORK", "mainnet");
  const relayerId = env("RELAYER_ACCOUNT_ID", "");
  return {
    network,
    // Several public RPC nodes, tried in order when one is busy or down.
    rpcUrl: env("NEAR_RPC", network === "mainnet" ? "https://rpc.mainnet.fastnear.com,https://near.drpc.org,https://rpc.mainnet.near.org" : "https://rpc.testnet.fastnear.com,https://rpc.testnet.near.org"),
    // The contract lives in its own sub-account of the relayer's account
    // (`circles.<relayer>`), unless CONTRI_ACCOUNT_ID names another.
    contractId: env("CONTRI_ACCOUNT_ID", relayerId ? `circles.${relayerId}` : ""),
    intentsId: env("INTENTS_ID", "intents.near"),
    tokenId: env("TOKEN_ID", "nep141:usdt.tether-token.near"),
    relayerId,
    relayerKey: env("RELAYER_KEY", ""),
    oneClickUrl: env("ONECLICK_URL", "https://1click.chaindefuser.com"),
    oneClickKey: env("ONECLICK_API_KEY", ""),
    // Contri's fee on top-ups and cash-outs, in hundredths of a percent (25 is
    // 0.25%), paid to `feeAccount` and shared with 1Click. Moves between a
    // member's own balances and everything inside a circle carry no fee.
    feeBps: Math.max(0, Math.min(100, Math.floor(Number(env("CONTRI_FEE_BPS", "25")) || 0))),
    feeAccount: env("CONTRI_FEE_ACCOUNT", relayerId),
  };
}

/** @typedef {ReturnType<typeof config>} Config */

/** What the app needs to know. @param {Config} c */
export const publicConfig = (c) => ({
  network: c.network,
  contractId: c.contractId,
  intentsId: c.intentsId,
  tokenId: c.tokenId,
  relaying: Boolean(c.relayerId && c.relayerKey),
  // Whether request limits are shared by every server instance (see limit.js).
  sharedLimits: sharedLimits(),
  // Public on chain anyway; lets anyone check it can still pay for gas.
  relayer: c.relayerId || null,
  // Shown before every top-up and cash-out.
  feeBps: c.feeAccount ? c.feeBps : 0,
});
