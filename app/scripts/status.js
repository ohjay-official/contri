// @ts-check
// Prints the public state of Contri's accounts on mainnet, for the deploy
// workflow's report: balances, whether code is deployed, how many keys.
// Account ids are public; no key or secret is read here.

import { config } from "../server/config.js";
import { rpc, view } from "../public/js/lib/near.js";

const c = config();
const near = (/** @type {string} */ yocto) => Number(BigInt(yocto) / 10n ** 20n) / 10_000;

/** @param {string} id */
async function account(id) {
  if (!id) return null;
  try {
    const a = await rpc(c.rpcUrl, "query", { request_type: "view_account", finality: "final", account_id: id });
    const keys = await rpc(c.rpcUrl, "query", { request_type: "view_access_key_list", finality: "final", account_id: id });
    return { id, exists: true, near: near(a.amount), storage_bytes: a.storage_usage, code: a.code_hash !== "11111111111111111111111111111111", keys: keys.keys.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/UNKNOWN_ACCOUNT|does not exist/i.test(message)) return { id, exists: false };
    return { id, error: message.slice(0, 200) };
  }
}

const contri = await account(c.contractId);
let contract = null;
if (contri && "code" in contri && contri.code) contract = await view(c.rpcUrl, c.contractId, "get_config").catch((e) => ({ error: String(e).slice(0, 200) }));
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), contri, relayer: await account(c.relayerId), contract }, null, 2));
