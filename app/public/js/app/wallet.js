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

import { fromBase58, toBase64Url, fromBase64 } from "../lib/bytes.js";
import { circleSigner, vaultSigner } from "../lib/keys.js";
import { createPasskey, deviceSecret, unlockWithPasskey } from "../lib/passkey.js";
import { forget, keep as keepSession, recall } from "../lib/session.js";
import { demo } from "./demo.js";

/** Where this phone's notes go: the browser's storage, or, in the demo, this tab only, so they reset with the pretend chain. */
const memory = new Map();
const store = () => (demo ? { getItem: (/** @type {string} */ k) => memory.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => void memory.set(k, v) } : localStorage);
import { getConfig, views } from "./api.js";

/** @typedef {import("../lib/keys.js").Signer} Signer */
/**
 * @typedef {object} Slot
 * @property {number} index
 * @property {Signer} signer
 * @property {number[]} circles circles this account organizes or sits in
 * @property {bigint} balance USDT on NEAR Intents
 * @property {bigint} credit owed to this account by Contri after a transfer out failed
 */
/**
 * @typedef {object} Local
 * @property {string} [secret] invite secret, base64url
 * @property {number} [circle]
 * @property {{ kind: "create", name: string, contribution: string, size: number, periodSecs: number, random: boolean } | { kind: "join", circle: number }} [pending]
 * @property {{ depositAddress: string, depositMemo: string | null, send: string, symbol: string, label: string, seconds: number, deadline: string }} [deposit] the last top-up address, until it's used or expires
 */

const SESSION = "contri.session";

/** @type {{ secret: Uint8Array, mode: "passkey" | "device" } | null} */
let session = null;
/** @type {Map<number, Signer>} */
const signers = new Map();
/** @type {Signer | null} */
let vaultKey = null;

/** Picks up an unlocked session after the page reloads (see lib/session.js). */
export async function restore() {
  // The demo is always the made-up sample member, kept nowhere, so it can't
  // replace or clear a real member's session on this phone.
  if (demo) {
    const { DEVICE_SECRET, INVITE_SECRET } = await import("../demo/mock.js");
    session = { secret: DEVICE_SECRET, mode: "device" };
    // The sample member's two circles, with their invite keys so their names show.
    const secret = encodeSecret(INVITE_SECRET);
    if (!memory.has(await storeKey())) memory.set(await storeKey(), JSON.stringify({ 0: { circle: 0, secret }, 1: { circle: 1, secret } }));
    memory.set(await recoveryKey(), "1");
    return true;
  }
  const kept = await recall();
  if (kept && (kept.mode === "passkey" || kept.mode === "device")) session = { secret: kept.secret, mode: kept.mode };
  else {
    // Sessions from before sealing were kept in sessionStorage; move one over.
    try {
      const old = JSON.parse(sessionStorage.getItem(SESSION) ?? "null");
      sessionStorage.removeItem(SESSION);
      if (old) await start(fromBase58(old.secret), old.mode);
    } catch {
      session = null;
    }
  }
  return Boolean(session);
}

/**
 * Unlocks with `secret` and keeps it (sealed) for later visits. Resolves once
 * it is stored, so a tab closed right after unlocking stays unlocked.
 * @param {Uint8Array} secret @param {"passkey" | "device"} mode
 */
async function start(secret, mode) {
  session = { secret, mode };
  signers.clear();
  vaultKey = null;
  if (!demo) await keepSession(secret, mode);
}

export const unlocked = () => Boolean(session);
export const mode = () => session?.mode ?? null;
export const secret = () => {
  if (!session) throw new Error("Unlock Contri first.");
  return session.secret;
};

/** When the passkey was last used on this page (not across reloads). */
let passkeyAt = 0;

export async function signUpWithPasskey() {
  await start(await createPasskey(), "passkey");
  passkeyAt = Date.now();
}
export async function signInWithPasskey() {
  await start(await unlockWithPasskey(), "passkey");
  passkeyAt = Date.now();
}
export async function useThisDevice() {
  const { secret, created } = deviceSecret();
  await start(secret, "device");
  return created;
}
/** @param {Uint8Array} s */
export const useRestoredSecret = (s) => start(s, "device");

/**
 * Asks for the passkey again before something that can't be undone: sending
 * money outside Contri, showing the recovery code, and (through
 * confirmRecentPasskey) joining a circle or buying a turn, which commit money
 * to other people. So a phone left unlocked isn't enough to hand the money to
 * someone else. A key kept on the device has nothing to ask for.
 */
export async function confirmWithPasskey() {
  if (session?.mode !== "passkey") return;
  const again = await unlockWithPasskey();
  const same = again.length === session.secret.length && again.every((b, i) => b === session?.secret[i]);
  if (!same) throw new Error("That passkey isn't the one you signed in with.");
  passkeyAt = Date.now();
}

/**
 * The same, unless the passkey was used on this page in the last two minutes,
 * so someone who has just signed in to join a circle is asked once, not twice.
 */
export async function confirmRecentPasskey() {
  if (Date.now() - passkeyAt < 120_000) return;
  await confirmWithPasskey();
}

export async function lock() {
  session = null;
  signers.clear();
  vaultKey = null;
  if (!demo) await forget();
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
    return JSON.parse(store().getItem(await storeKey()) ?? "{}");
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
    store().setItem(await storeKey(), JSON.stringify(all));
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
  // Accounts empty out in normal use (a cashed-out circle, a cancelled one the
  // keeper closed), so a new phone keeps looking past a run of 10 unused ones.
  for (let start = 0; unused < 10 && start < 100; start += 5) {
    const batch = await Promise.all([0, 1, 2, 3, 4].map((i) => signer(start + i)));
    const results = await views(
      batch.flatMap((s) => [
        { contract: "contri", method: "get_circles_for", args: { account_id: s.accountId } },
        { contract: "intents", method: "mt_balance_of", args: { account_id: s.accountId, token_id: tokenId } },
        { contract: "contri", method: "get_credit", args: { account_id: s.accountId } },
      ]),
    );
    batch.forEach((s, i) => {
      const index = start + i;
      const slot = { index, signer: s, circles: results[3 * i], balance: BigInt(results[3 * i + 1]), credit: BigInt(results[3 * i + 2] ?? "0") };
      const used = slot.circles.length > 0 || slot.balance > 0n || slot.credit > 0n || index <= maxKnown;
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

// ---- Money moved in and out, for Help ----
// Every top-up, cash-out and private-balance move goes through a one-time
// 1Click deposit address. This device keeps a short list of them, so the
// Help screen can show where each one is and the member can send the details
// to support. Nothing here can move money.

/**
 * @typedef {object} Move
 * @property {"topup" | "cashout" | "private-topup" | "private-to-circle" | "to-private" | "private-cashout"} kind
 * @property {string} depositAddress
 * @property {number} at when it started (ms)
 * @property {string} [amount] what was sent or moved, in dollars
 * @property {string} [network] the network's label, for top-ups and cash-outs
 * @property {string} [account] the circle account involved
 * @property {string} [to] where a cash-out went
 * @property {string} [tx] the NEAR transaction that sent it, if any
 */

async function movesKey() {
  return `contri.moves.${(await signer(0)).accountId.slice(0, 16)}`;
}
/** @returns {Promise<Move[]>} newest first */
export async function moves() {
  try {
    return JSON.parse(store().getItem(await movesKey()) ?? "[]");
  } catch {
    return [];
  }
}
/** @param {Omit<Move, "at">} move */
export async function logMove(move) {
  const all = [{ ...move, at: Date.now() }, ...(await moves())].slice(0, 50);
  try {
    store().setItem(await movesKey(), JSON.stringify(all));
  } catch {}
}

// ---- Whether the member has seen their recovery code ----

async function recoveryKey() {
  return `contri.recovery-seen.${(await signer(0)).accountId.slice(0, 16)}`;
}
/** Whether this device has shown the member their recovery code. */
export async function recoverySeen() {
  try {
    return store().getItem(await recoveryKey()) === "1";
  } catch {
    return true;
  }
}
export async function markRecoverySeen() {
  try {
    store().setItem(await recoveryKey(), "1");
  } catch {}
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
    return JSON.parse(store().getItem(await labelsKey()) ?? "{}");
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
    store().setItem(await labelsKey(), JSON.stringify(all));
  } catch {
    // Storage blocked: the name lasts until the page closes.
  }
}
