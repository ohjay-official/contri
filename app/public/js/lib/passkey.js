// @ts-check
// The member's secret, from their passkey (browser only).
//
// The WebAuthn PRF extension lets a site ask a passkey for a pseudo-random
// value tied to that passkey and that site. The passkey's own key never
// leaves the device, nobody else can compute the value, and a synced passkey
// (Google Password Manager, iCloud Keychain) gives the same value on a new
// phone. Every circle key is derived from it (keys.js). Nothing is sent to a
// server: there is no account, email or phone number.
//
// Where a passkey can't give a PRF value, the app falls back to a random
// secret kept on this device, shown once as a recovery code.

import { fromBase58, randomBytes, toBase58, utf8 } from "./bytes.js";

const PRF_INPUT = utf8("contri-prf-v1");
const DEVICE_KEY = "contri.device-secret";

export class PrfUnavailable extends Error {
  constructor() {
    super("This passkey can't give Contri a key. Use this device instead, or another passkey provider.");
  }
}

export const passkeysAvailable = () => typeof window !== "undefined" && "PublicKeyCredential" in window;

/** @param {Credential | null} cred */
function prfResult(cred) {
  const ext = /** @type {any} */ (cred)?.getClientExtensionResults?.();
  const first = ext?.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

/** Creates a new passkey for Contri and returns its secret. */
export async function createPasskey() {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: "Contri" },
      user: { id: randomBytes(16), name: `Contri ${new Date().toISOString().slice(0, 10)}`, displayName: "Contri" },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -8 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: /** @type {any} */ ({ prf: { eval: { first: PRF_INPUT } } }),
    },
  });
  const ext = /** @type {any} */ (cred)?.getClientExtensionResults?.();
  if (!ext?.prf?.enabled && !ext?.prf?.results) throw new PrfUnavailable();
  // Some providers return the value at creation, others only when the passkey is used.
  return prfResult(cred) ?? unlockWithPasskey();
}

/** Asks for an existing Contri passkey and returns its secret. */
export async function unlockWithPasskey() {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      userVerification: "required",
      extensions: /** @type {any} */ ({ prf: { eval: { first: PRF_INPUT } } }),
    },
  });
  const secret = prfResult(cred);
  if (!secret) throw new PrfUnavailable();
  return secret;
}

/** A secret kept only on this device. @returns {{ secret: Uint8Array, created: boolean }} */
export function deviceSecret() {
  const saved = localStorage.getItem(DEVICE_KEY);
  if (saved) return { secret: fromBase58(saved), created: false };
  const secret = randomBytes(32);
  localStorage.setItem(DEVICE_KEY, toBase58(secret));
  return { secret, created: true };
}

/** Removes the key kept on this device: only the recovery code brings it back. */
export function forgetDeviceSecret() {
  localStorage.removeItem(DEVICE_KEY);
}

/** The device secret as a recovery code, for the member to write down. @param {Uint8Array} secret */
export const recoveryCode = (secret) => toBase58(secret).replace(/(.{4})(?!$)/g, "$1-");

/** @param {string} code */
export function restoreDeviceSecret(code) {
  const secret = fromBase58(code.replace(/[\s-]/g, ""));
  if (secret.length !== 32) throw new Error("that recovery code isn't complete");
  localStorage.setItem(DEVICE_KEY, toBase58(secret));
  return secret;
}
