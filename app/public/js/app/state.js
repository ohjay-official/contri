// @ts-check
// What the app has loaded, and words for amounts, dates and schedules.

import { formatAmount } from "../lib/contri.js";
import { decryptName } from "../lib/invite.js";
import { views } from "./api.js";
import { decodeSecret, discover, local } from "./wallet.js";

/** @typedef {import("../lib/contri.js").Circle} Circle */
/** @typedef {import("./wallet.js").Slot} Slot */

export const state = {
  /** @type {Slot[] | null} */
  slots: null,
  /** @type {Map<number, Circle>} */
  circles: new Map(),
  /** @type {Map<number, string>} */
  names: new Map(),
};

/** Loads the member's accounts, their circles, and the names this device can read. */
export async function refresh() {
  const slots = await discover();
  const ids = [...new Set(slots.flatMap((s) => s.circles))];
  const circles = ids.length ? await views(ids.map((id) => ({ contract: "contri", method: "get_circle", args: { circle_id: id } }))) : [];
  state.slots = slots;
  state.circles = new Map(circles.filter(Boolean).map((c) => [c.id, c]));
  const known = await local();
  for (const l of Object.values(known)) {
    const id = l.circle ?? (l.pending?.kind === "join" ? l.pending.circle : undefined);
    if (id === undefined || !l.secret || state.names.has(id)) continue;
    // A circle being joined isn't one of the member's yet, so read it here.
    const c = state.circles.get(id) ?? (l.pending ? (await views([{ contract: "contri", method: "get_circle", args: { circle_id: id } }]))[0] : null);
    if (c) {
      const name = await decryptName(decodeSecret(l.secret), c.name);
      if (name) state.names.set(id, name);
    }
  }
  return state;
}

/** The slot that sits in (or organizes) a circle. @param {number} id */
export const slotFor = (id) => state.slots?.find((s) => s.circles.includes(id)) ?? null;

/** @param {number} id */
export const nameOf = (id) => state.names.get(id) ?? `Circle ${id}`;

/** @param {bigint | string} v */
export const usd = (v) => `$${formatAmount(v)}`;

/** "every day", "every 2 weeks", "every 10 minutes". @param {number} secs */
export function every(secs) {
  const units = /** @type {const} */ ([["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]]);
  for (const [unit, size] of units) {
    if (secs % size === 0) {
      const n = secs / size;
      return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
    }
  }
  return `every ${secs} seconds`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
/** @param {number} ms */
export const when = (ms) => dateFmt.format(new Date(ms));

const rel = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
/** "in 3 hours", "5 minutes ago". @param {number} ms @param {number} [now] */
export function fromNow(ms, now = Date.now()) {
  const s = Math.round((ms - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return rel.format(s, "second");
  if (abs < 3600) return rel.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rel.format(Math.round(s / 3600), "hour");
  return rel.format(Math.round(s / 86400), "day");
}
