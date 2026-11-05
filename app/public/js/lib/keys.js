// @ts-check
// Ed25519 keys from 32-byte seeds, with WebCrypto only (browsers and Node 22).
//
// A member never has a NEAR account or a seed phrase. Their passkey gives the
// app a secret (see passkey.js), and every key is derived from it with HKDF:
//
//   circle account n   HKDF(secret, "contri/circle/<contract>/<n>")
//   private balance    HKDF(secret, "contri/vault/<contract>")
//
// Each derived key's account is its NEAR implicit account (the public key in
// hex), so a member's circles share nothing on chain. The same passkey on a
// new phone gives the same secret, so the same accounts come back.

import { concat, fromBase58, fromBase64, toBase58, toHex, utf8 } from "./bytes.js";

/** PKCS#8 header of an Ed25519 private key; the 32-byte seed follows it. */
const PKCS8_ED25519 = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);

/**
 * @typedef {object} Signer
 * @property {Uint8Array} publicKey 32 bytes
 * @property {string} publicKeyStr `ed25519:<base58>`, NEAR's public key format
 * @property {string} accountId the implicit account: the public key in hex
 * @property {(data: Uint8Array) => Promise<Uint8Array>} sign 64-byte signature
 */

/** @param {Uint8Array} seed 32 bytes @param {string} [accountId] defaults to the implicit account @returns {Promise<Signer>} */
export async function signerFromSeed(seed, accountId) {
  if (seed.length !== 32) throw new Error("an ed25519 seed is 32 bytes");
  const key = await crypto.subtle.importKey("pkcs8", concat(PKCS8_ED25519, seed), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (!jwk.x) throw new Error("this browser can't use ed25519 keys");
  const publicKey = fromBase64(jwk.x);
  return {
    publicKey,
    publicKeyStr: `ed25519:${toBase58(publicKey)}`,
    accountId: accountId ?? toHex(publicKey),
    sign: async (data) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, /** @type {BufferSource} */ (data))),
  };
}

/**
 * A NEAR wallet's exported key, `ed25519:<base58 of seed and public key>`.
 * Used by the relayer and the deploy script, never by members.
 * @param {string} secretKey @param {string} accountId
 */
export async function signerFromSecretKey(secretKey, accountId) {
  const raw = fromBase58(secretKey.replace(/^ed25519:/, ""));
  if (raw.length !== 64 && raw.length !== 32) throw new Error("expected an ed25519 secret key");
  const signer = await signerFromSeed(raw.slice(0, 32), accountId);
  if (raw.length === 64 && toHex(raw.slice(32)) !== toHex(signer.publicKey)) throw new Error("secret key doesn't match its public key");
  return signer;
}

/** @param {Uint8Array} secret @param {string} info @param {number} [length] */
export async function hkdf(secret, info, length = 32) {
  const base = await crypto.subtle.importKey("raw", /** @type {BufferSource} */ (secret), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: utf8("contri"), info: utf8(info) }, base, length * 8);
  return new Uint8Array(bits);
}

/**
 * The member's account for their `index`-th circle on `contract`.
 * @param {Uint8Array} secret @param {string} contract @param {number} index
 */
export async function circleSigner(secret, contract, index) {
  return signerFromSeed(await hkdf(secret, `contri/circle/${contract}/${index}`));
}

/**
 * The member's private account on NEAR Intents' private ledger (Confidential
 * Intents): one per member, never used on the public chain.
 * @param {Uint8Array} secret @param {string} contract
 */
export async function vaultSigner(secret, contract) {
  return signerFromSeed(await hkdf(secret, `contri/vault/${contract}`));
}

/** @param {Uint8Array} publicKey @param {Uint8Array} message @param {Uint8Array} signature */
export async function verify(publicKey, message, signature) {
  const key = await crypto.subtle.importKey("raw", /** @type {BufferSource} */ (publicKey), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, /** @type {BufferSource} */ (signature), /** @type {BufferSource} */ (message));
}
