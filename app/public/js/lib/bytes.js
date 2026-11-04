// @ts-check
// Byte helpers shared by the browser app and the relayer. No dependencies.

const enc = new TextEncoder();
const dec = new TextDecoder();

/** @param {string} s */
export const utf8 = (s) => enc.encode(s);

/** @param {Uint8Array} b */
export const fromUtf8 = (b) => dec.decode(b);

/** @param {...Uint8Array} parts */
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** @param {Uint8Array} b */
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** @param {string} s */
export function fromHex(s) {
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** @param {Uint8Array} b */
export function toBase64(b) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** @param {string} s */
export function fromBase64(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** URL-safe base64 without padding, for link fragments. @param {Uint8Array} b */
export const toBase64Url = (b) => toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** @param {Uint8Array} b */
export function toBase58(b) {
  let n = 0n;
  for (const x of b) n = n * 256n + BigInt(x);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

/** @param {string} s */
export function fromBase58(s) {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** Little-endian unsigned integer of `size` bytes. @param {bigint | number} v @param {number} size */
export function uintLE(v, size) {
  let n = BigInt(v);
  if (n < 0n || n >= 1n << BigInt(8 * size)) throw new Error("integer out of range");
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** @param {Uint8Array} data */
export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", /** @type {BufferSource} */ (data)));
}

/** @param {number} n */
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
