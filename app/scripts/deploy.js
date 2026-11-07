// @ts-check
// Deploys Contri. Run by .github/workflows/deploy.yml with keys from GitHub
// secrets. Until --lock, the deploy key is also the relayer's key, which
// Vercel holds too (scripts/vercel.js), so locking is what takes it away.
//
//   node app/scripts/deploy.js <contri.wasm>   create the contract account (first time), deploy, init
//   EXPECTED_WASM=<ci build> node app/scripts/deploy.js --lock   delete every key: nobody can change the code again
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
import { sha256, toBase58 } from "../public/js/lib/bytes.js";
import { signerFromSecretKey, signerFromSeed } from "../public/js/lib/keys.js";
import { outcome, RpcError, rpc, sendTransaction, TGAS, view } from "../public/js/lib/near.js";

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

/**
 * A check of the deployed code on mainnet that needs no USDT: the relayer, as
 * a NEAR account, is refused a circle under 1 USDT, then creates a circle (with
 * the 0.01 NEAR storage fee), cancels it and closes it.
 */
async function smoke() {
  const relayer = await signerFromSecretKey(c.relayerKey, c.relayerId);
  /** @param {string} method @param {object} args @param {bigint} [deposit] */
  const call = async (method, args, deposit = 0n) => {
    const { hash, result } = await sendTransaction(c.rpcUrl, relayer, c.contractId, [{ functionCall: { method, args, gas: 50n * TGAS, deposit } }], "FINAL");
    const { failure } = outcome(result);
    const value = result.status?.SuccessValue ? Buffer.from(result.status.SuccessValue, "base64").toString() : null;
    console.log(`smoke ${method}: ${hash} ${failure ? `failed: ${JSON.stringify(failure).slice(0, 160)}` : `ok ${value ?? ""}`}`);
    return { failure, value };
  };
  const fee = YOCTO / 100n;
  const base = { name: "Mainnet check before the lock", size: 2, period_secs: 600 };
  const small = await call("create_circle", { ...base, contribution: "999999" }, fee);
  if (!small.failure || !JSON.stringify(small.failure).includes("at least 1 USDT")) throw new Error("smoke: a circle under 1 USDT wasn't refused");
  const made = await call("create_circle", { ...base, contribution: "1000000" }, fee);
  if (made.failure || made.value === null) throw new Error("smoke: create_circle failed");
  const id = Number(JSON.parse(made.value));
  const open = await view(c.rpcUrl, c.contractId, "get_circle", { circle_id: id });
  if (open?.status !== "Open" || open.organizer !== c.relayerId || open.round_deadline !== null) throw new Error(`smoke: unexpected circle ${JSON.stringify(open)}`);
  if ((await call("cancel_circle", { circle_id: id })).failure) throw new Error("smoke: cancel_circle failed");
  if ((await call("close_circle", { circle_id: id })).failure) throw new Error("smoke: close_circle failed");
  if ((await view(c.rpcUrl, c.contractId, "get_circle", { circle_id: id })) !== null) throw new Error("smoke: the closed circle is still stored");
  console.log(`smoke: passed (circle ${id} created, cancelled and closed)`);
}

/**
 * An upgrade can change how circles are stored, and a circle stored the old
 * way couldn't be read by the new code. So before upgrading, finished or
 * cancelled circles that have paid everything back are closed (anyone may),
 * and the upgrade stops if any circle is still open or running.
 */
async function clearForUpgrade() {
  const { circle_count: count } = await view(c.rpcUrl, c.contractId, "get_config");
  /** @type {any[]} */
  const circles = [];
  for (let from = 0; from < count; from += 100) circles.push(...(await view(c.rpcUrl, c.contractId, "get_circles", { from_index: from, limit: 100 })));
  const live = circles.filter((x) => x.status === "Open" || x.status === "Active");
  if (live.length) throw new Error(`circles ${live.map((x) => x.id).join(", ")} are still open or running; finish or cancel them before this upgrade`);
  const relayer = await signerFromSecretKey(c.relayerKey, c.relayerId);
  for (const x of circles) {
    const { hash, result } = await sendTransaction(c.rpcUrl, relayer, c.contractId, [{ functionCall: { method: "close_circle", args: { circle_id: x.id }, gas: 30n * TGAS, deposit: 0n } }], "FINAL");
    const { failure } = outcome(result);
    if (failure) throw new Error(`circle ${x.id} couldn't be closed (${JSON.stringify(failure).slice(0, 160)}); release its deposits first`);
    console.log(`closed circle ${x.id} before the upgrade: ${hash}`);
  }
}

/** Bytes the contract's NEAR covers beyond what it stores. @param {any} a */
const headroom = (a) => Number(BigInt(a.amount) / 10n ** 19n) - a.storage_usage;
/**
 * The contract refuses new circles and members when its NEAR doesn't cover
 * what they and running circles may store (see `ensure_room` in the contract).
 * After an upgrade, the relayer tops it up to STORAGE_ROOM bytes of room if it
 * can spare the NEAR and keep KEEP_GAS for members' gas. Anyone can also send
 * NEAR to the contract, before or after it's locked.
 */
async function topUpStorage() {
  const ROOM = 25_000;
  const KEEP_GAS = (3n * YOCTO) / 10n;
  const now = await account(c.contractId);
  const short = ROOM - headroom(now);
  if (short <= 0) return console.log(`${c.contractId} has room for ${headroom(now)} more bytes`);
  const parentAccount = await account(c.relayerId);
  const amount = storage(short);
  if (!c.relayerKey || !parentAccount || BigInt(parentAccount.amount) < amount + KEEP_GAS) {
    return console.log(`${c.contractId} has room for ${headroom(now)} bytes; send it ${near(amount)} NEAR for ${ROOM}`);
  }
  const parent = await signerFromSecretKey(c.relayerKey, c.relayerId);
  const { hash } = await sendTransaction(c.rpcUrl, parent, c.contractId, [{ transfer: { deposit: amount } }], "FINAL");
  console.log(`sent ${near(amount)} NEAR from ${c.relayerId} to ${c.contractId} for storage: ${hash}; room ${headroom(await account(c.contractId))} bytes`);
}

if (process.argv[2] === "--lock") {
  if (!existing) throw new Error(`${c.contractId} doesn't exist`);
  // Locking makes the deployed code permanent, so it must be exactly the code
  // CI built from the repository: EXPECTED_WASM is that build (deploy.yml takes
  // it from the ci-results branch).
  if (!process.env.EXPECTED_WASM) throw new Error("set EXPECTED_WASM to CI's build of the contract");
  const expected = toBase58(await sha256(new Uint8Array(await readFile(process.env.EXPECTED_WASM))));
  if (existing.code_hash !== expected) throw new Error(`${c.contractId} runs ${existing.code_hash}, not CI's build ${expected}. Not locking.`);

  // NEAR Intents lets an account register keys that sign intents for its
  // balance; payouts move it as the caller ("predecessor auth"); and Intents
  // can lock an account. Any of these wrong at the lock would stay wrong.
  /** @returns {Promise<string[]>} */
  const intentsKeys = () => view(c.rpcUrl, c.intentsId, "public_keys_of", { account_id: c.contractId });
  /** @returns {Promise<boolean>} */
  const canPay = () => view(c.rpcUrl, c.intentsId, "is_auth_by_predecessor_id_enabled", { account_id: c.contractId });
  /** @returns {Promise<boolean>} */
  const lockedOnIntents = () => view(c.rpcUrl, c.intentsId, "is_account_locked", { account_id: c.contractId });
  const intentsOk = async () => {
    const keys = await intentsKeys();
    if (keys.length) throw new Error(`${c.contractId} has keys registered on ${c.intentsId}: ${keys.join(", ")}. Not locking.`);
    if ((await canPay()) !== true) throw new Error(`${c.intentsId} doesn't let ${c.contractId} move its own balance; payouts would fail. Not locking.`);
    if ((await lockedOnIntents()) !== false) throw new Error(`${c.contractId} is locked on ${c.intentsId}. Not locking.`);
  };
  await intentsOk();

  /** @returns {Promise<{ public_key: string }[]>} */
  const accessKeys = async () => (await rpc(c.rpcUrl, "query", { request_type: "view_access_key_list", finality: "final", account_id: c.contractId })).keys;
  const list = await accessKeys();
  if (!list.some((k) => k.public_key === signer.publicKeyStr)) throw new Error("the deploy key isn't on the account");
  const { fromBase58 } = await import("../public/js/lib/bytes.js");
  const del = (/** @type {string} */ k) => ({ deleteKey: { publicKey: fromBase58(k.replace(/^ed25519:/, "")) } });

  // 1. Swap every key for a fresh one that exists only in this process, in one
  //    transaction. From here the deploy key (also the relayer's) can't act as
  //    the contract, so nothing can slip in between the checks and the lock.
  const fresh = await signerFromSeed(crypto.getRandomValues(new Uint8Array(32)), c.contractId);
  const swap = await sendTransaction(c.rpcUrl, signer, c.contractId, [{ addFullAccessKey: { publicKey: fresh.publicKey } }, ...list.map((k) => del(k.public_key))], "FINAL");
  console.log(`swapped ${list.length} key(s) for a one-time key: ${swap.hash}`);
  // 2. Check again, now that nobody else can change anything.
  await intentsOk();
  if ((await account(c.contractId)).code_hash !== expected) throw new Error("the code changed before the lock");
  // 3. Delete the one-time key.
  const { hash } = await sendTransaction(c.rpcUrl, fresh, c.contractId, [del(fresh.publicKeyStr)], "FINAL");
  const left = await accessKeys();
  const after = await intentsKeys();
  const paying = await canPay();
  console.log(`locked ${c.contractId} in ${hash}: ${left.length} access keys left, ${after.length} keys on ${c.intentsId}, predecessor auth ${paying}, code ${expected}`);
  if (left.length || after.length) throw new Error("the account still has keys");
  if (paying !== true) throw new Error("predecessor auth is off: payouts would fail");
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
    if (toBase58(await sha256(wasm)) === existing.code_hash) {
      console.log(`${c.contractId} already runs this code (${existing.code_hash})`);
      await topUpStorage();
      if (process.env.SMOKE === "true") await smoke();
      console.log(JSON.stringify(await view(c.rpcUrl, c.contractId, "get_config")));
      process.exit(0);
    }
    if (!fresh) await clearForUpgrade();
    // A fresh account stores the whole code; an upgrade replaces code of about the same size.
    const needed = storage(fresh ? wasm.length + existing.storage_usage + 5_000 : Math.max(existing.storage_usage, wasm.length) + 2_000);
    if (BigInt(existing.amount) < needed) throw new Error(`needs about ${near(needed)} NEAR, has ${near(existing.amount)}`);
    /** @type {import("../public/js/lib/near.js").Action[]} */
    const actions = [{ deployContract: { code: wasm } }];
    if (fresh) actions.push(init);
    const { hash } = await sendTransaction(c.rpcUrl, signer, c.contractId, actions, "FINAL");
    console.log(`${fresh ? "deployed and initialized" : "upgraded"}: ${hash}`);
    await topUpStorage();
    if (process.env.SMOKE === "true") await smoke();
  }
  console.log(JSON.stringify(await view(c.rpcUrl, c.contractId, "get_config")));
}
