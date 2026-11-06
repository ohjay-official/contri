// @ts-check
// Request limits.
//
// Each server instance counts requests per caller over the last minute and
// turns away the excess, so nobody can make the relayer spend its NEAR, or use
// up Contri's 1Click quota, as fast as they can send requests.
//
// Serverless instances don't share memory, so on its own that caps each
// instance. When a Redis database is connected (Upstash, through Vercel's
// marketplace, which sets KV_REST_API_URL and KV_REST_API_TOKEN), the same
// counts are also kept there, shared by every instance, along with one cap on
// the relayer as a whole. If Redis can't be reached, requests go on with only
// the per-instance limits rather than failing.
//
// Callers are counted by a salted hash of their IP address. Without Redis the
// salt is random per instance and the hashes stay in memory; with Redis the
// salt is the Redis token (secret, so the hashes can't be reversed by trying
// every IP), and each count expires after a minute. Neither is logged.

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

const REDIS_URL = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";

/**
 * Whether the shared counts work right now: "ok", "off" (no database), or the
 * kind of failure (an HTTP status or an error name). Never the URL or token.
 */
export async function limitsCheck() {
  if (!REDIS_URL || !REDIS_TOKEN) return "off";
  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify([["PING"]]),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return `http ${res.status}`;
    const [first] = await res.json();
    return first?.result === "PONG" ? "ok" : "unexpected reply";
  } catch (e) {
    return e instanceof Error ? e.name : "error";
  }
}

/** Whether a Redis database is connected for shared limits. */
export const sharedLimits = () => Boolean(REDIS_URL && REDIS_TOKEN);

/**
 * Counts one request for `key` on this instance and, when Redis is connected,
 * across all of them. False when either count is already at `max` this minute.
 * @param {string} key @param {number} max
 */
export async function allowShared(key, max) {
  if (!allow(key, max)) return false;
  if (!REDIS_URL || !REDIS_TOKEN) return true;
  const k = `limit:${key}:${Math.floor(Date.now() / WINDOW_MS)}`;
  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify([["INCR", k], ["EXPIRE", k, "120"]]),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return true;
    const [first] = await res.json();
    return Number(first?.result ?? 0) <= max;
  } catch {
    return true;
  }
}

/**
 * A salted hash of the caller's IP address, or "" when there is none (the local
 * dev server and tests; Vercel always sets it).
 * @param {Request} request
 */
export async function caller(request) {
  const ip = request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  if (!ip) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${REDIS_TOKEN || salt}:${ip}`));
  return toHex(new Uint8Array(digest)).slice(0, 32);
}
