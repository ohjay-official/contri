// @ts-check
// Calls to Contri's server: settings, chain reads, the relayer, 1Click and the keeper.

import { signIntents } from "../lib/intents.js";

/** @typedef {{ network: string, contractId: string, intentsId: string, tokenId: string, relaying: boolean }} AppConfig */

/** @param {string} path @param {object} [body] */
async function request(path, body) {
  let res;
  try {
    res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  } catch {
    throw new Error("You're offline, or Contri can't be reached. Check your connection and try again.");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Contri's server answered ${res.status}. Try again.`);
  return json;
}

/** @type {Promise<AppConfig> | null} */
let configPromise = null;
/** @returns {Promise<AppConfig>} */
export const getConfig = () => (configPromise ??= request("/api/config").catch((e) => ((configPromise = null), Promise.reject(e))));

/**
 * Several view calls in one request.
 * @param {{ contract: "contri" | "intents", method: string, args?: object }[]} calls
 * @returns {Promise<any[]>} each result, or throws on the first error
 */
export async function views(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 25) {
    const results = await request("/api/rpc", { calls: calls.slice(i, i + 25) });
    for (const r of results) {
      if ("error" in r) throw new Error(r.error);
      out.push(r.ok);
    }
  }
  return out;
}

/** @param {number} id @returns {Promise<import("../lib/contri.js").Circle | null>} */
export const getCircle = async (id) => (await views([{ contract: "contri", method: "get_circle", args: { circle_id: id } }]))[0];

/**
 * Submits signed intents. Returns Contri's events and notes (a refund's reason).
 * @param {import("../lib/intents.js").SignedIntents[]} signed
 * @returns {Promise<{ hash: string, ok: boolean, failure: string | null, events: { event: string, data: any[] }[], notes: string[] }>}
 */
export async function relay(signed) {
  const r = await request("/api/relay", { signed });
  if (!r.ok) throw new Error("NEAR Intents didn't accept that. Nothing was taken from your balance.");
  return r;
}

/** @param {"topup" | "cashout" | "status" | "submit"} action @param {object} body */
export const swap = (action, body) => request("/api/swap", { action, ...body });

/** Asks the keeper to settle a circle whose round deadline has passed. @param {number} circle */
export const keep = (circle) => request("/api/keeper", { circle }).catch(() => null);

/**
 * Signs intents as a circle account with a versioned nonce, ready for `relay`.
 * @param {import("../lib/keys.js").Signer} signer @param {object[]} intents
 */
export async function sign(signer, intents) {
  const cfg = await getConfig();
  const [salt] = await views([{ contract: "intents", method: "current_salt" }]);
  return signIntents(signer, intents, { recipient: cfg.intentsId, salt });
}
