// @ts-check
// Invite links and end-to-end encrypted circle details.
//
// An invite link looks like  https://<site>/join#<circle id>.<secret>
// Everything after `#` stays in the browser: it is never sent to any server,
// ours included. The secret is 16 random bytes (128 bits, 22 characters in
// the link; circles made before were 32 bytes, and both open). From it the
// app derives:
//
//   invite key   HKDF(secret, "contri/invite/sign")   ed25519. Its public half
//                is stored with the circle; the contract only lets in members
//                whose join is signed by it (see the contract's join_message).
//   name key     HKDF(secret, "contri/invite/name")   AES-256-GCM. Encrypts the
//                circle's name, stored on chain as ciphertext.

import { concat, fromBase64, fromUtf8, randomBytes, toBase64Url, toHex, utf8 } from "./bytes.js";
import { hkdf, signerFromSeed } from "./keys.js";

/** Longest circle name in UTF-8 bytes; its ciphertext stays under the contract's 256-byte limit. */
export const MAX_NAME_BYTES = 100;

export const newSecret = () => randomBytes(16);

/** @param {Uint8Array} secret */
export async function inviteSigner(secret) {
  return signerFromSeed(await hkdf(secret, "contri/invite/sign"));
}

/** @param {Uint8Array} secret */
async function nameKey(secret) {
  const raw = await hkdf(secret, "contri/invite/name");
  return crypto.subtle.importKey("raw", /** @type {BufferSource} */ (raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

const AAD = utf8("contri-circle-name");

/** @param {Uint8Array} secret @param {string} name @returns {Promise<string>} `v1.<base64url of iv and ciphertext>` */
export async function encryptName(secret, name) {
  const plain = utf8(name.trim());
  if (!plain.length) throw new Error("give the circle a name");
  if (plain.length > MAX_NAME_BYTES) throw new Error("that name is too long");
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: /** @type {BufferSource} */ (iv), additionalData: AAD }, await nameKey(secret), /** @type {BufferSource} */ (plain));
  return `v1.${toBase64Url(concat(iv, new Uint8Array(ct)))}`;
}

/** @param {Uint8Array} secret @param {string} stored @returns {Promise<string | null>} null if it can't be read with this secret */
export async function decryptName(secret, stored) {
  if (!stored.startsWith("v1.")) return null;
  try {
    const raw = fromBase64(stored.slice(3));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: /** @type {BufferSource} */ (raw.slice(0, 12)), additionalData: AAD },
      await nameKey(secret),
      /** @type {BufferSource} */ (raw.slice(12)),
    );
    return fromUtf8(new Uint8Array(plain));
  } catch {
    return null;
  }
}

/**
 * What the invite key signs so `account` can join (mirrors the contract's `join_message`).
 * @param {string} contract @param {number} circle @param {string} account @param {bigint | string} deposit
 */
export const joinMessage = (contract, circle, account, deposit) => `contri-join:${contract}:${circle}:${account}:${deposit}`;

/**
 * The 128-hex signature that goes in `join:<circle>:<signature>`.
 * @param {Uint8Array} secret @param {string} contract @param {number} circle @param {string} account @param {bigint | string} deposit
 */
export async function signJoin(secret, contract, circle, account, deposit) {
  const signer = await inviteSigner(secret);
  return toHex(await signer.sign(utf8(joinMessage(contract, circle, account, deposit))));
}

/** @param {string} origin @param {number} circle @param {Uint8Array} secret */
export const inviteLink = (origin, circle, secret) => `${origin}/join#${circle}.${toBase64Url(secret)}`;

/**
 * Reads `<circle>.<secret>` from a link's fragment.
 * @param {string} hash e.g. location.hash
 * @returns {{ circle: number, secret: Uint8Array } | null}
 */
export function parseInvite(hash) {
  const m = /^#?(\d{1,15})\.([A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{43})$/.exec(hash.trim());
  if (!m) return null;
  const secret = fromBase64(m[2]);
  return secret.length === 16 || secret.length === 32 ? { circle: Number(m[1]), secret } : null;
}
