// @ts-check
// Server settings, from environment variables (Vercel project settings, or
// GitHub secrets in CI). Nothing here is ever sent to the browser except
// what `publicConfig` returns.

/** @param {string} name @param {string} fallback @returns {string} */
const env = (name, fallback) => {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
};

export function config() {
  const network = env("NEAR_NETWORK", "mainnet");
  return {
    network,
    rpcUrl: env("NEAR_RPC", network === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com"),
    contractId: env("CONTRI_ACCOUNT_ID", ""),
    intentsId: env("INTENTS_ID", "intents.near"),
    tokenId: env("TOKEN_ID", "nep141:usdt.tether-token.near"),
    relayerId: env("RELAYER_ACCOUNT_ID", ""),
    relayerKey: env("RELAYER_KEY", ""),
    oneClickUrl: env("ONECLICK_URL", "https://1click.chaindefuser.com"),
    oneClickKey: env("ONECLICK_API_KEY", ""),
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
});
