// @ts-check
// Staying unlocked.
//
// Phones reload a page they put in the background (iOS Safari often does it
// within seconds), browsers restart, tabs get closed. None of that should ask
// for the passkey again: once unlocked, Contri stays unlocked on this device
// until the member locks it (Your key, then Lock Contri on this device). The
// unlocked secret is kept sealed:
//
//   - AES-GCM with a key the browser makes non-extractable and keeps in
//     IndexedDB: page scripts can use it to unseal but can't export its bytes.
//     It isn't tied to the phone's hardware: the phone's screen lock is what
//     protects an unlocked Contri;
//   - the sealed secret in localStorage;
//   - locking deletes both.
//
// The same code runs on every browser: Chrome, Edge, Samsung Internet,
// Firefox and Safari, on phones and computers. Where IndexedDB or WebCrypto
// keys aren't available (some private modes), nothing is kept and a reload
// asks for the passkey.

import { fromBase58, toBase58 } from "./bytes.js";

const STORE = "contri.session";
const DB = "contri";
const KEYS = "keys";

/** @returns {Promise<IDBDatabase>} */
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(KEYS);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @param {"get" | "put" | "delete"} op @param {CryptoKey} [value] @returns {Promise<any>} */
async function keyStore(op, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(KEYS, op === "get" ? "readonly" : "readwrite");
    const store = tx.objectStore(KEYS);
    const req = op === "get" ? store.get("session") : op === "put" ? store.put(value, "session") : store.delete("session");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).finally(() => d.close());
}

/** The keep or forget in progress: they run one after another, never interleaved. */
let queue = Promise.resolve();
/** @param {() => Promise<void>} job */
const inTurn = (job) => (queue = queue.then(job, job));

/**
 * Seals and keeps an unlocked secret until the member locks Contri. Resolves
 * once both halves are stored, so the page can be closed right after.
 * @param {Uint8Array} secret @param {string} mode
 */
export function keep(secret, mode) {
  return inTurn(async () => {
    try {
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, /** @type {BufferSource} */ (secret)));
      await keyStore("put", key);
      localStorage.setItem(STORE, JSON.stringify({ v: 2, mode, iv: toBase58(iv), sealed: toBase58(sealed) }));
    } catch {
      await clear();
      return;
    }
    // Ask the browser not to clear this site's storage to free up space. Not
    // waited for: some browsers take their time to answer.
    navigator.storage?.persist?.().catch(() => false);
  });
}

/** The kept secret, if Contri hasn't been locked. @returns {Promise<{ secret: Uint8Array, mode: string } | null>} */
export async function recall() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
    if (!saved || (saved.v !== 1 && saved.v !== 2)) return null;
    const key = await keyStore("get");
    if (!key) return null;
    const secret = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: /** @type {BufferSource} */ (fromBase58(saved.iv)) }, key, /** @type {BufferSource} */ (fromBase58(saved.sealed))));
    return { secret, mode: saved.mode };
  } catch {
    return null;
  }
}

/** Deletes the kept session and its key: Contri is locked. */
export function forget() {
  return inTurn(clear);
}

async function clear() {
  try {
    localStorage.removeItem(STORE);
  } catch {}
  await keyStore("delete").catch(() => null);
}
