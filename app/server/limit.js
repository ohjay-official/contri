// @ts-check
// Request limits.
//
// Each server instance counts requests per caller over the last minute and
// turns away the excess, so nobody can make the relayer spend its NEAR, or use
// up Contri's 1Click quota, as fast as they can send requests. Serverless
// instances don't share memory, so this caps each instance; Vercel's firewall
// rate limits sit in front of all of them.
//
// Callers are counted by a hash of their IP address with a random salt made
// when the instance starts. The hashes stay in memory for a minute and are
// never logged or written anywhere.

import { toHex } from "../public/js/lib/bytes.js";

const WINDOW_MS = 60_000;
const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
/** @type {Map<string, number[]>} */
const hits = new Map();

/**
 * Counts one request for `key`. False when it already had `max` in the last minute.
 * @param {string} key @param {number} max @param {number} [nowMs]
 */
export function allow(key, max, nowMs = Date.now()) {
  const recent = (hits.get(key) ?? []).filter((t) => nowMs - t < WINDOW_MS);
  const ok = recent.length < max;
  if (ok) recent.push(nowMs);
  hits.set(key, recent);
  if (hits.size > 20_000) {
    for (const [k, v] of hits) if (!v.some((t) => nowMs - t < WINDOW_MS)) hits.delete(k);
  }
  return ok;
}

/**
 * A salted hash of the caller's IP address, or "" when there is none (the local
 * dev server and tests; Vercel always sets it).
 * @param {Request} request
 */
export async function caller(request) {
  const ip = request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  if (!ip) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return toHex(new Uint8Array(digest)).slice(0, 32);
}
