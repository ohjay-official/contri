// @ts-check
// Signed intents for NEAR Intents (intents.near), NEP-413 standard.
//
// A member's app signs these with the member's circle key. Contri's relayer
// submits them with `execute_intents` and pays the gas, so members never need
// NEAR. NEAR Intents checks the signature and calls Contri with the verified
// signer: a `transfer` with a `msg` reaches `mt_on_transfer`, an `auth_call`
// reaches `on_auth`.

import { concat, randomBytes, sha256, toBase58, toBase64, uintLE, utf8 } from "./bytes.js";

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

/**
 * Signs a list of intents. The deadline is short, so a signed payload that
 * leaks can't be replayed later; each nonce is used once.
 * @param {Signer} signer
 * @param {object[]} intents
 * @param {{ recipient?: string, validForMs?: number, now?: number }} [opts]
 * @returns {Promise<SignedIntents>}
 */
export async function signIntents(signer, intents, { recipient = "intents.near", validForMs = 10 * 60_000, now = Date.now() } = {}) {
  const deadline = new Date(now + validForMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const message = JSON.stringify({ signer_id: signer.accountId, deadline, intents });
  const nonce = randomBytes(32);
  nonce[0] = 0; // never the prefix NEAR Intents reserves for versioned nonces
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
