// @ts-check
// Staying unlocked while the member switches apps.
//
// Phones reload a page they put in the background (iOS Safari often does it
// within seconds), and a reload used to lock Contri and ask for the passkey
// again. Now the unlocked secret is kept for a while, sealed:
//
//   - AES-GCM with a key the browser makes non-extractable and keeps in
//     IndexedDB: script can use it to unseal, but nothing can read its bytes,
//     so the stored session is useless copied off the device;
//   - the sealed secret in localStorage, with an expiry that moves forward
//     while the member uses the app, and passes after IDLE_MS without use;
//   - locking (or the expiry) deletes both.
//
// Where IndexedDB or WebCrypto keys aren't available (some private modes),
// nothing is kept and a reload asks for the passkey, as before.

import { fromBase58, toBase58 } from "./bytes.js";

/** How long Contri stays unlocked without being used. */
export const IDLE_MS = 30 * 60_000;
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

/**
 * Seals and keeps an unlocked secret.
 * @param {Uint8Array} secret @param {string} mode @param {number} [now]
 */
export async function keep(secret, mode, now = Date.now()) {
  try {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, /** @type {BufferSource} */ (secret)));
    await keyStore("put", key);
    localStorage.setItem(STORE, JSON.stringify({ v: 1, mode, iv: toBase58(iv), sealed: toBase58(sealed), until: now + IDLE_MS }));
  } catch {
    forget();
  }
}

/**
 * The kept secret, if it hasn't expired. Each successful read moves the
 * expiry forward.
 * @param {number} [now] @returns {Promise<{ secret: Uint8Array, mode: string } | null>}
 */
export async function recall(now = Date.now()) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
    if (!saved || saved.v !== 1) return null;
    if (!(saved.until > now)) {
      await forget();
      return null;
    }
    const key = await keyStore("get");
    if (!key) return null;
    const secret = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: /** @type {BufferSource} */ (fromBase58(saved.iv)) }, key, /** @type {BufferSource} */ (fromBase58(saved.sealed))));
    touch(now);
    return { secret, mode: saved.mode };
  } catch {
    return null;
  }
}

/** Moves the expiry forward: the member is using the app. @param {number} [now] */
export function touch(now = Date.now()) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
    if (saved && saved.until > now) localStorage.setItem(STORE, JSON.stringify({ ...saved, until: now + IDLE_MS }));
  } catch {
    // Storage blocked: nothing is kept anyway.
  }
}

/** Deletes the kept session and its key. */
export async function forget() {
  try {
    localStorage.removeItem(STORE);
  } catch {}
  await keyStore("delete").catch(() => null);
}
