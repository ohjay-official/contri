// @ts-check
// The member's keys and what this device remembers.
//
// Every circle a member is in gets its own account ("slot"): slot n is
// circleSigner(secret, contract, n). On a new phone the app finds them again
// by checking slots 0, 1, 2... until a few in a row are unused. Nothing about
// which accounts belong together is stored anywhere but here.
//
// This device keeps, per slot: the circle's invite secret (to read its name
// and share the link again) and anything half done (a circle being created
// or joined while a top-up arrives). Losing it loses no money: the keys come
// from the passkey, and the money is on NEAR Intents.

import { fromBase58, toBase58, toBase64Url, fromBase64 } from "../lib/bytes.js";
import { circleSigner, vaultSigner } from "../lib/keys.js";
import { createPasskey, deviceSecret, unlockWithPasskey } from "../lib/passkey.js";
import { getConfig, views } from "./api.js";

/** @typedef {import("../lib/keys.js").Signer} Signer */
/**
 * @typedef {object} Slot
 * @property {number} index
 * @property {Signer} signer
 * @property {number[]} circles circles this account organizes or sits in
 * @property {bigint} balance USDT on NEAR Intents
 */
/**
 * @typedef {object} Local
 * @property {string} [secret] invite secret, base64url
 * @property {number} [circle]
 * @property {{ kind: "create", name: string, contribution: string, size: number, periodSecs: number, random: boolean } | { kind: "join", circle: number }} [pending]
 */

const SESSION = "contri.session";

/** @type {{ secret: Uint8Array, mode: "passkey" | "device" } | null} */
let session = null;
/** @type {Map<number, Signer>} */
const signers = new Map();
/** @type {Signer | null} */
let vaultKey = null;

/** Picks up an unlocked session after a reload in the same tab. */
export function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION) ?? "null");
    if (saved) session = { secret: fromBase58(saved.secret), mode: saved.mode };
  } catch {
    session = null;
  }
  return Boolean(session);
}

/** @param {Uint8Array} secret @param {"passkey" | "device"} mode */
function start(secret, mode) {
  session = { secret, mode };
  signers.clear();
  vaultKey = null;
  try {
    sessionStorage.setItem(SESSION, JSON.stringify({ secret: toBase58(secret), mode }));
  } catch {
    // Private mode: the session lasts until the page closes.
  }
}

export const unlocked = () => Boolean(session);
export const mode = () => session?.mode ?? null;
export const secret = () => {
  if (!session) throw new Error("Unlock Contri first.");
  return session.secret;
};

export async function signUpWithPasskey() {
  start(await createPasskey(), "passkey");
}
export async function signInWithPasskey() {
  start(await unlockWithPasskey(), "passkey");
}
export function useThisDevice() {
  const { secret, created } = deviceSecret();
  start(secret, "device");
  return created;
}
/** @param {Uint8Array} s */
export const useRestoredSecret = (s) => start(s, "device");

export function lock() {
  session = null;
  signers.clear();
  vaultKey = null;
  sessionStorage.removeItem(SESSION);
}

/** @param {number} index */
export async function signer(index) {
  let s = signers.get(index);
  if (!s) {
    const { contractId } = await getConfig();
    s = await circleSigner(secret(), contractId, index);
    signers.set(index, s);
  }
  return s;
}

/** The member's private account (their private balance). */
export async function vault() {
  if (!vaultKey) {
    const { contractId } = await getConfig();
    vaultKey = await vaultSigner(secret(), contractId);
  }
  return vaultKey;
}

// ---- What this device remembers ----

async function storeKey() {
  return `contri.local.${(await signer(0)).accountId.slice(0, 16)}`;
}

/** @returns {Promise<Record<number, Local>>} */
export async function local() {
  try {
    return JSON.parse(localStorage.getItem(await storeKey()) ?? "{}");
  } catch {
    return {};
  }
}

/** @param {number} index @param {Partial<Local> | null} patch null forgets the slot */
export async function remember(index, patch) {
  const all = await local();
  if (patch === null) delete all[index];
  else all[index] = { ...all[index], ...patch };
  try {
    localStorage.setItem(await storeKey(), JSON.stringify(all));
  } catch {
    // Storage full or blocked: the flow still works, it just won't survive a reload.
  }
}

/** @param {Uint8Array} s */
export const encodeSecret = (s) => toBase64Url(s);
/** @param {string} s */
export const decodeSecret = (s) => fromBase64(s);

// ---- Finding the member's accounts ----

/**
 * The member's slots with their circles and balances. Checks slots in groups
 * of five until three in a row are unused and unknown to this device.
 * @returns {Promise<Slot[]>}
 */
export async function discover() {
  const { tokenId } = await getConfig();
  const known = await local();
  const maxKnown = Math.max(-1, ...Object.keys(known).map(Number));
  /** @type {Slot[]} */
  const slots = [];
  let unused = 0;
  for (let start = 0; unused < 3 && start < 100; start += 5) {
    const batch = await Promise.all([0, 1, 2, 3, 4].map((i) => signer(start + i)));
    const results = await views(
      batch.flatMap((s) => [
        { contract: "contri", method: "get_circles_for", args: { account_id: s.accountId } },
        { contract: "intents", method: "mt_balance_of", args: { account_id: s.accountId, token_id: tokenId } },
      ]),
    );
    batch.forEach((s, i) => {
      const index = start + i;
      const slot = { index, signer: s, circles: results[2 * i], balance: BigInt(results[2 * i + 1]) };
      const used = slot.circles.length > 0 || slot.balance > 0n || index <= maxKnown;
      if (used) {
        slots.push(slot);
        unused = 0;
      } else unused++;
    });
  }
  return slots;
}

/** The first slot that has never been used. @param {Slot[]} slots */
export async function freshSlot(slots) {
  const known = await local();
  let i = 0;
  while (slots.some((s) => s.index === i) || known[i]) i++;
  return i;
}

/** @param {number} index */
export async function balanceOf(index) {
  const { tokenId } = await getConfig();
  const s = await signer(index);
  const [b] = await views([{ contract: "intents", method: "mt_balance_of", args: { account_id: s.accountId, token_id: tokenId } }]);
  return BigInt(b);
}

// ---- Names for other members, kept only on this device ----
// Members appear on chain as account numbers. A member can name the ones they
// know ("Kemi"); the names never leave this phone.

async function labelsKey() {
  return `contri.labels.${(await signer(0)).accountId.slice(0, 16)}`;
}

/** @returns {Promise<Record<string, string>>} */
export async function labels() {
  try {
    return JSON.parse(localStorage.getItem(await labelsKey()) ?? "{}");
  } catch {
    return {};
  }
}

/** @param {string} account @param {string} name empty removes it */
export async function setLabel(account, name) {
  const all = await labels();
  const clean = name.trim().slice(0, 40);
  if (clean) all[account] = clean;
  else delete all[account];
  try {
    localStorage.setItem(await labelsKey(), JSON.stringify(all));
  } catch {
    // Storage blocked: the name lasts until the page closes.
  }
}
