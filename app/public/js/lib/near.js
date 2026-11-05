// @ts-check
// A small NEAR JSON-RPC client and transaction signer. No dependencies.
// The browser only uses `view` (through Contri's /api/rpc proxy); the relayer
// and the deploy script also build and send transactions.

import { concat, fromBase58, fromBase64, fromUtf8, sha256, toBase58, toBase64, uintLE, utf8 } from "./bytes.js";

/** @typedef {import("./keys.js").Signer} Signer */

export class RpcError extends Error {
  /** @param {string} message @param {any} data */
  constructor(message, data) {
    super(message);
    this.data = data;
  }
}

/**
 * One JSON-RPC call. `url` can list several endpoints, comma-separated: when
 * one is busy (HTTP 429), down (5xx) or unreachable, the next is tried, twice
 * round, so a public node's rate limit doesn't stop members' payments.
 * Errors from NEAR itself (a failed call, a bad transaction) aren't retried.
 * Resending a signed transaction is safe: NEAR runs it at most once.
 * @param {string} url @param {string} method @param {unknown} params
 */
export async function rpc(url, method, params) {
  const urls = url.split(",").map((u) => u.trim()).filter(Boolean);
  /** @type {RpcError | null} */
  let last = null;
  for (let attempt = 0; attempt < urls.length * 2; attempt++) {
    const endpoint = urls[attempt % urls.length];
    if (attempt >= urls.length) await new Promise((r) => setTimeout(r, 400 * attempt));
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "contri", method, params }),
      });
    } catch (e) {
      last = new RpcError(`RPC ${method} couldn't reach ${new URL(endpoint).host}`, String(e));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      last = new RpcError(`RPC ${method} failed with HTTP ${res.status}`, await res.text().catch(() => ""));
      continue;
    }
    if (!res.ok) throw new RpcError(`RPC ${method} failed with HTTP ${res.status}`, await res.text());
    const body = await res.json();
    if (body.error) {
      const cause = body.error.cause?.name ?? body.error.name;
      throw new RpcError(`RPC ${method}: ${cause}: ${JSON.stringify(body.error.data ?? body.error.cause?.info ?? "")}`, body.error);
    }
    return body.result;
  }
  throw last ?? new RpcError(`RPC ${method}: no endpoint`, null);
}

/**
 * Calls a view method and parses its JSON result.
 * @param {string} url @param {string} contract @param {string} method @param {object} [args]
 */
export async function view(url, contract, method, args = {}) {
  const result = await rpc(url, "query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: contract,
    method_name: method,
    args_base64: toBase64(utf8(JSON.stringify(args))),
  });
  if (result.error) throw new RpcError(`${contract}.${method}: ${result.error}`, result);
  return JSON.parse(fromUtf8(Uint8Array.from(result.result)));
}

// ---- Transactions (borsh) ----

/** @param {Uint8Array} b */
const borshBytes = (b) => concat(uintLE(b.length, 4), b);
/** @param {string} s */
const borshString = (s) => borshBytes(utf8(s));
/** @param {Uint8Array} publicKey */
const borshKey = (publicKey) => concat(Uint8Array.of(0), publicKey); // 0 = ed25519

/**
 * @typedef {{ functionCall: { method: string, args: object | Uint8Array, gas: bigint, deposit: bigint } }
 *   | { createAccount: true }
 *   | { deployContract: { code: Uint8Array } }
 *   | { transfer: { deposit: bigint } }
 *   | { addFullAccessKey: { publicKey: Uint8Array } }
 *   | { deleteKey: { publicKey: Uint8Array } }} Action
 */

/** @param {Action} a */
function borshAction(a) {
  if ("createAccount" in a) return Uint8Array.of(0);
  if ("deployContract" in a) return concat(Uint8Array.of(1), borshBytes(a.deployContract.code));
  if ("functionCall" in a) {
    const { method, args, gas, deposit } = a.functionCall;
    const raw = args instanceof Uint8Array ? args : utf8(JSON.stringify(args));
    return concat(Uint8Array.of(2), borshString(method), borshBytes(raw), uintLE(gas, 8), uintLE(deposit, 16));
  }
  if ("transfer" in a) return concat(Uint8Array.of(3), uintLE(a.transfer.deposit, 16));
  // AddKey: the key, then AccessKey { nonce: u64, permission: FullAccess (1) }.
  if ("addFullAccessKey" in a) return concat(Uint8Array.of(5), borshKey(a.addFullAccessKey.publicKey), uintLE(0n, 8), Uint8Array.of(1));
  if ("deleteKey" in a) return concat(Uint8Array.of(6), borshKey(a.deleteKey.publicKey));
  throw new Error("unsupported action");
}

/**
 * Borsh of a (v0) NEAR transaction.
 * @param {{ signerId: string, publicKey: Uint8Array, nonce: bigint, receiverId: string, blockHash: Uint8Array, actions: Action[] }} tx
 */
export function encodeTransaction(tx) {
  return concat(
    borshString(tx.signerId),
    borshKey(tx.publicKey),
    uintLE(tx.nonce, 8),
    borshString(tx.receiverId),
    tx.blockHash,
    uintLE(tx.actions.length, 4),
    ...tx.actions.map(borshAction),
  );
}

/**
 * Signs and sends a transaction, retrying once on a stale nonce (two relayer
 * calls at the same moment can pick the same one).
 * @param {string} url @param {Signer} signer @param {string} receiverId @param {Action[]} actions
 * @param {"INCLUDED" | "EXECUTED_OPTIMISTIC" | "FINAL"} [waitUntil]
 */
export async function sendTransaction(url, signer, receiverId, actions, waitUntil = "EXECUTED_OPTIMISTIC") {
  for (let attempt = 0; ; attempt++) {
    const key = await rpc(url, "query", {
      request_type: "view_access_key",
      finality: "optimistic",
      account_id: signer.accountId,
      public_key: signer.publicKeyStr,
    });
    const nonce = BigInt(key.nonce) + 1n + BigInt(Math.floor(Math.random() * 1000) * attempt);
    const tx = encodeTransaction({
      signerId: signer.accountId,
      publicKey: signer.publicKey,
      nonce,
      receiverId,
      blockHash: fromBase58(key.block_hash),
      actions,
    });
    const hash = await sha256(tx);
    const signed = concat(tx, Uint8Array.of(0), await signer.sign(hash));
    try {
      const result = await rpc(url, "send_tx", { signed_tx_base64: toBase64(signed), wait_until: waitUntil });
      return { hash: toBase58(hash), result };
    } catch (e) {
      const stale = e instanceof RpcError && /InvalidNonce|NonceTooLarge/.test(e.message);
      if (!stale || attempt >= 2) throw e;
    }
  }
}

/**
 * Everything a transaction's receipts logged, and the first failure if any.
 * @param {any} result a `send_tx` / `tx` result
 */
export function outcome(result) {
  /** @type {string[]} */
  const logs = [];
  /** @type {unknown} */
  let failure = result.status?.Failure ?? null;
  for (const r of [result.transaction_outcome, ...(result.receipts_outcome ?? [])]) {
    if (!r) continue;
    logs.push(...r.outcome.logs);
    if (!failure && r.outcome.status?.Failure) failure = r.outcome.status.Failure;
  }
  return { logs, failure };
}

/**
 * NEP-297 events in logs.
 * @param {string[]} logs @param {string} [standard]
 * @returns {{ standard: string, event: string, data: any[] }[]}
 */
export function events(logs, standard) {
  return logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)))
    .filter((e) => !standard || e.standard === standard);
}

/** @param {string} b64 base64 SuccessValue of an outcome */
export const successJson = (b64) => (b64 ? JSON.parse(fromUtf8(fromBase64(b64))) : null);

/** 1 Tgas in gas units. */
export const TGAS = 1_000_000_000_000n;
