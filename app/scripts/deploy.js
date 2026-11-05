// @ts-check
// Deploys Contri. Run by .github/workflows/deploy.yml with keys from GitHub
// secrets; the keys never leave GitHub's runner.
//
//   node app/scripts/deploy.js <contri.wasm>   create the contract account (first time), deploy, init
//   node app/scripts/deploy.js --lock          delete the contract account's key: nobody can change the code again
//
// One funded account is enough. The relayer's account (RELAYER_ACCOUNT_ID,
// RELAYER_KEY) pays members' gas, and the first deploy creates the contract
// as its sub-account `circles.<relayer>`, funded with what its code needs to
// be stored and holding the same key until --lock removes it. A separate
// contract account still works: set CONTRI_ACCOUNT_ID and CONTRI_DEPLOYER_KEY.
//
// Env: RELAYER_ACCOUNT_ID, RELAYER_KEY, optionally CONTRI_ACCOUNT_ID,
// CONTRI_DEPLOYER_KEY, NEAR_RPC, INTENTS_ID, TOKEN_ID.

import { readFile } from "node:fs/promises";
import { config } from "../server/config.js";
import { signerFromSecretKey } from "../public/js/lib/keys.js";
import { RpcError, rpc, sendTransaction, TGAS, view } from "../public/js/lib/near.js";

const YOCTO = 10n ** 24n;
const near = (/** @type {bigint | string} */ y) => (Number(BigInt(y) / 10n ** 20n) / 10_000).toFixed(4);
/** Storage costs 1 NEAR per 100 kB. @param {number} bytes */
const storage = (bytes) => BigInt(bytes) * 10n ** 19n;

const c = config();
if (!c.contractId) throw new Error("set RELAYER_ACCOUNT_ID (or CONTRI_ACCOUNT_ID)");
const key = process.env.CONTRI_DEPLOYER_KEY || c.relayerKey;
if (!key) throw new Error("set RELAYER_KEY (or CONTRI_DEPLOYER_KEY)");
const signer = await signerFromSecretKey(key, c.contractId);

/** @param {string} id */
async function account(id) {
  try {
    return await rpc(c.rpcUrl, "query", { request_type: "view_account", finality: "final", account_id: id });
  } catch (e) {
    if (e instanceof RpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(e.message)) return null;
    throw e;
  }
}

const existing = await account(c.contractId);

if (process.argv[2] === "--lock") {
  if (!existing) throw new Error(`${c.contractId} doesn't exist`);
  await sendTransaction(c.rpcUrl, signer, c.contractId, [{ deleteKey: { publicKey: signer.publicKey } }], "FINAL");
  const keys = await rpc(c.rpcUrl, "query", { request_type: "view_access_key_list", finality: "final", account_id: c.contractId });
  console.log(`locked ${c.contractId}: ${keys.keys.length} access keys left`);
  if (keys.keys.length) throw new Error("the account still has keys");
} else {
  const wasm = new Uint8Array(await readFile(process.argv[2]));
  const init = { functionCall: { method: "new", args: { intents_id: c.intentsId, token_id: c.tokenId }, gas: 30n * TGAS, deposit: 0n } };

  if (!existing) {
    // First deploy: the relayer creates the contract account and funds it for
    // its code plus room for the first circles.
    if (!c.contractId.endsWith(`.${c.relayerId}`)) throw new Error(`${c.contractId} doesn't exist; create it first, or leave CONTRI_ACCOUNT_ID unset`);
    const parent = await signerFromSecretKey(c.relayerKey, c.relayerId);
    const parentAccount = await account(c.relayerId);
    if (!parentAccount) throw new Error(`${c.relayerId} doesn't exist yet: fund it first`);
    const fund = storage(wasm.length + 8_000);
    const keep = YOCTO / 5n; // 0.2 NEAR left for members' gas
    if (BigInt(parentAccount.amount) < fund + keep) {
      throw new Error(`${c.relayerId} has ${near(parentAccount.amount)} NEAR; it needs about ${near(fund + keep)} (contract storage ${near(fund)} + gas ${near(keep)})`);
    }
    console.log(`${c.relayerId}: ${near(parentAccount.amount)} NEAR. Creating ${c.contractId} with ${near(fund)} NEAR`);
    const { hash } = await sendTransaction(c.rpcUrl, parent, c.contractId, [
      { createAccount: true },
      { transfer: { deposit: fund } },
      { addFullAccessKey: { publicKey: parent.publicKey } },
      { deployContract: { code: wasm } },
      init,
    ], "FINAL");
    console.log(`created, deployed and initialized: ${hash}`);
  } else {
    console.log(`${c.contractId}: ${near(existing.amount)} NEAR, ${existing.storage_usage} bytes stored`);
    const fresh = existing.code_hash === "11111111111111111111111111111111";
    const needed = storage(wasm.length + existing.storage_usage + 5_000);
    if (BigInt(existing.amount) < needed) throw new Error(`needs about ${near(needed)} NEAR, has ${near(existing.amount)}`);
    /** @type {import("../public/js/lib/near.js").Action[]} */
    const actions = [{ deployContract: { code: wasm } }];
    if (fresh) actions.push(init);
    const { hash } = await sendTransaction(c.rpcUrl, signer, c.contractId, actions, "FINAL");
    console.log(`${fresh ? "deployed and initialized" : "upgraded"}: ${hash}`);
  }
  console.log(JSON.stringify(await view(c.rpcUrl, c.contractId, "get_config")));
}
