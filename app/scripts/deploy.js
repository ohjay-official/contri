// @ts-check
// Deploys Contri to its own account, or upgrades its code, signing with the
// account's key. Run by .github/workflows/deploy.yml with the key from a
// GitHub secret; the key never leaves GitHub's runner.
//
//   node app/scripts/deploy.js <contri.wasm>          deploy (and init the first time)
//   node app/scripts/deploy.js --lock                 delete the key: nobody can change the code again
//
// Env: CONTRI_ACCOUNT_ID, CONTRI_DEPLOYER_KEY, NEAR_RPC (optional), INTENTS_ID, TOKEN_ID.

import { readFile } from "node:fs/promises";
import { config } from "../server/config.js";
import { signerFromSecretKey } from "../public/js/lib/keys.js";
import { rpc, sendTransaction, TGAS, view } from "../public/js/lib/near.js";

const c = config();
const key = process.env.CONTRI_DEPLOYER_KEY;
if (!c.contractId || !key) throw new Error("set CONTRI_ACCOUNT_ID and CONTRI_DEPLOYER_KEY");
const signer = await signerFromSecretKey(key, c.contractId);
const account = await rpc(c.rpcUrl, "query", { request_type: "view_account", finality: "final", account_id: c.contractId });
const near = (/** @type {string} */ yocto) => (Number(BigInt(yocto) / 10n ** 20n) / 10_000).toFixed(4);
console.log(`${c.contractId}: ${near(account.amount)} NEAR, ${account.storage_usage} bytes stored`);

if (process.argv[2] === "--lock") {
  await sendTransaction(c.rpcUrl, signer, c.contractId, [{ deleteKey: { publicKey: signer.publicKey } }], "FINAL");
  const keys = await rpc(c.rpcUrl, "query", { request_type: "view_access_key_list", finality: "final", account_id: c.contractId });
  console.log(`locked: ${keys.keys.length} access keys left`);
  if (keys.keys.length) throw new Error("the account still has keys");
} else {
  const wasm = new Uint8Array(await readFile(process.argv[2]));
  const fresh = account.code_hash === "11111111111111111111111111111111";
  // Storage: 1 NEAR per 100 kB, plus room for the first few circles.
  const needed = BigInt(wasm.length + account.storage_usage + 5_000) * 10n ** 19n;
  if (BigInt(account.amount) < needed) throw new Error(`needs about ${near(needed.toString())} NEAR, has ${near(account.amount)}`);
  /** @type {import("../public/js/lib/near.js").Action[]} */
  const actions = [{ deployContract: { code: wasm } }];
  if (fresh) actions.push({ functionCall: { method: "new", args: { intents_id: c.intentsId, token_id: c.tokenId }, gas: 30n * TGAS, deposit: 0n } });
  const { hash } = await sendTransaction(c.rpcUrl, signer, c.contractId, actions, "FINAL");
  console.log(`${fresh ? "deployed and initialized" : "upgraded"}: ${hash}`);
  console.log(JSON.stringify(await view(c.rpcUrl, c.contractId, "get_config")));
}
