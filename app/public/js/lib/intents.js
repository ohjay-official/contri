// @ts-check
// Signed intents for NEAR Intents (intents.near), NEP-413 standard.
//
// A member's app signs these with the member's circle key. Contri's relayer
// submits them with `execute_intents` and pays the gas, so members never need
// NEAR. NEAR Intents checks the signature and calls Contri with the verified
// signer: a `transfer` with a `msg` reaches `mt_on_transfer`, an `auth_call`
// reaches `on_auth`.

import { concat, fromHex, randomBytes, sha256, toBase58, toBase64, uintLE, utf8 } from "./bytes.js";

/** @typedef {import("./keys.js").Signer} Signer */

/**
 * @typedef {object} SignedIntents
 * @property {"nep413"} standard
 * @property {{ message: string, nonce: string, recipient: string }} payload
 * @property {string} public_key
 * @property {string} signature
 */

/** Borsh string: u32 length, then UTF-8 bytes. @param {string} s */
const borshString = (s) => {
  const b = utf8(s);
  return concat(uintLE(b.length, 4), b);
};

/** NEP-413 tag: 2^31 + 413, little endian. */
const NEP413_TAG = uintLE(2 ** 31 + 413, 4);

/**
 * The bytes a NEP-413 signature covers.
 * @param {string} message @param {Uint8Array} nonce @param {string} recipient
 */
export async function nep413Hash(message, nonce, recipient) {
  // Payload: message, nonce, recipient, callback_url (None).
  return sha256(concat(NEP413_TAG, borshString(message), nonce, borshString(recipient), Uint8Array.of(0)));
}

/** Marks a versioned nonce (NEAR Intents `VersionedNonce::VERSIONED_MAGIC_PREFIX`). */
const VERSIONED_MAGIC = Uint8Array.of(0x56, 0x28, 0xf6, 0xc6);

/**
 * A NEAR Intents V1 nonce: magic, version 0, the contract's current salt, the
 * deadline in nanoseconds (i64 LE), then 15 bytes that are the signing time
 * (8 bytes, nanoseconds LE) and 7 random bytes, as the NEAR Intents SDK lays
 * them out. NEAR Intents rejects it after the deadline or once the salt is
 * rotated out; 1Click checks the signing time when a member signs in.
 * @param {string} saltHex from `current_salt` on intents.near @param {number} deadlineMs @param {number} [nowMs]
 */
export function versionedNonce(saltHex, deadlineMs, nowMs = Date.now()) {
  const salt = fromHex(saltHex);
  if (salt.length !== 4) throw new Error("a salt is 4 bytes");
  const ns = (/** @type {number} */ ms) => uintLE(BigInt(Math.floor(ms)) * 1_000_000n, 8);
  return concat(VERSIONED_MAGIC, Uint8Array.of(0), salt, ns(deadlineMs), ns(nowMs), randomBytes(7));
}

/**
 * Signs a list of intents. The deadline is short, so a signed payload that
 * leaks can't be replayed later; each nonce is used once. With `salt`, the
 * nonce is a versioned one bound to that deadline; without, a legacy random one.
 * @param {Signer} signer
 * @param {object[]} intents
 * @param {{ recipient?: string, validForMs?: number, now?: number, salt?: string }} [opts]
 * @returns {Promise<SignedIntents>}
 */
export async function signIntents(signer, intents, { recipient = "intents.near", validForMs = 10 * 60_000, now = Date.now(), salt } = {}) {
  const deadlineMs = Math.floor((now + validForMs) / 1000) * 1000;
  const deadline = new Date(deadlineMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const message = JSON.stringify({ signer_id: signer.accountId, deadline, intents });
  let nonce;
  if (salt) nonce = versionedNonce(salt, deadlineMs, now);
  else {
    nonce = randomBytes(32);
    nonce[0] = 0; // never the prefix NEAR Intents reserves for versioned nonces
  }
  const signature = await signer.sign(await nep413Hash(message, nonce, recipient));
  return {
    standard: "nep413",
    payload: { message, nonce: toBase64(nonce), recipient },
    public_key: signer.publicKeyStr,
    signature: `ed25519:${toBase58(signature)}`,
  };
}

/**
 * Moves tokens inside NEAR Intents. With `msg`, the receiver's
 * `mt_on_transfer` is called with it and can refund.
 * @param {string} receiverId @param {string} tokenId @param {bigint | string} amount
 * @param {{ msg?: string, minGas?: string }} [opts]
 */
export function transfer(receiverId, tokenId, amount, { msg, minGas } = {}) {
  /** @type {Record<string, unknown>} */
  const intent = { intent: "transfer", receiver_id: receiverId, tokens: { [tokenId]: String(amount) } };
  if (msg !== undefined) intent.msg = msg;
  if (minGas !== undefined) intent.min_gas = minGas;
  return intent;
}

/** Calls `on_auth(signer_id, msg)` on `contractId`. @param {string} contractId @param {string} msg */
export const authCall = (contractId, msg) => ({ intent: "auth_call", contract_id: contractId, msg });
