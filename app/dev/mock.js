// @ts-check
// Made-up circles for checking screens offline (MOCK=1 node dev/server.js).
// Never used in production. The member is the device key below; open the app,
// choose "Keep my key on this device", and dev/screens.js seeds the rest.

import { toBase58 } from "../public/js/lib/bytes.js";
import { encryptName } from "../public/js/lib/invite.js";
import { circleSigner } from "../public/js/lib/keys.js";
import { json } from "../server/http.js";

export const CONTRACT = "contri.near";
export const DEVICE_SECRET = new Uint8Array(32).fill(11);
export const INVITE_SECRET = new Uint8Array(32).fill(5);
export const deviceSecretB58 = toBase58(DEVICE_SECRET);

const me0 = (await circleSigner(DEVICE_SECRET, CONTRACT, 0)).accountId;
const me1 = (await circleSigner(DEVICE_SECRET, CONTRACT, 1)).accountId;
export const accounts = [me0, me1];

const other = (/** @type {number} */ n) => n.toString(16).repeat(64).slice(0, 64);
const T = (/** @type {number} */ days) => String(BigInt(Date.now() + days * 86_400_000) * 1_000_000n);
const member = (/** @type {string} */ a, paid = false, missed = 0, deposit = "5000000") => ({ account_id: a, deposit, paid_this_round: paid, defaulted: missed > 0, missed });

const circles = [
  {
    id: 0, name: await encryptName(INVITE_SECRET, "Yaba traders"), organizer: other(10), contribution: "5000000", size: 5, period_secs: 86400,
    members: [member(other(10), true), member(other(11), true), member(other(12), true, 1), member(me0), member(other(13))],
    listings: [null, null, "1500000", null, null], invite_only: true, random_order: false, fill_by: T(12),
    backing: "0", backers: [], status: "Active", created_at: T(-4), started_at: T(-2.4), round: 2, pot: "15000000", paying: false,
    payouts: [
      { round: 0, to: other(10), amount: "25000000", shortfall: "0", at: T(-1.5) },
      { round: 1, to: other(11), amount: "25000000", shortfall: "0", at: T(-0.5) },
    ],
    round_deadline: T(0.6),
  },
  {
    id: 1, name: await encryptName(INVITE_SECRET, "Family December"), organizer: me1, contribution: "10000000", size: 4, period_secs: 604800,
    members: [member(me1, false, 0, "10000000"), member(other(14), false, 0, "10000000")],
    listings: [null, null, null, null], invite_only: true, random_order: true, fill_by: T(13),
    backing: "0", backers: [], status: "Open", created_at: T(-1), started_at: "0", round: 0, pot: "0", paying: false, payouts: [], round_deadline: null,
  },
];

const balances = { [me0]: 3_200_000n, [me1]: 0n };

/** @param {string} name @param {Request} request */
export async function handle(name, request) {
  const body = request.method === "POST" ? await request.json() : {};
  if (name === "config") return json({ network: "mock", contractId: CONTRACT, intentsId: "intents.near", tokenId: "nep141:usdt.tether-token.near", relaying: true });
  if (name === "rpc") {
    return json(
      body.calls.map((/** @type {any} */ c) => {
        const a = c.args ?? {};
        switch (c.method) {
          case "get_circles_for": return { ok: circles.filter((x) => x.members.some((m) => m.account_id === a.account_id) || x.organizer === a.account_id).map((x) => x.id) };
          case "mt_balance_of": return { ok: String(balances[a.account_id] ?? 0n) };
          case "get_circle": return { ok: circles[a.circle_id] ?? null };
          case "current_salt": return { ok: "0a0b0c0d" };
          default: return { error: `mock has no ${c.method}` };
        }
      }),
    );
  }
  if (name === "swap") {
    if (body.action === "topup") return json({ network: body.network, label: "BNB Smart Chain (BEP20)", symbol: "USDT", depositAddress: "0x7d3A5bE2c1f0aB4E9c8D6F21a0B3c4D5e6F70819", depositMemo: null, send: "1.81", minSend: "1.79", receive: "1.80", deadline: new Date(Date.now() + 86_400_000).toISOString(), seconds: 40 });
    if (body.action === "status") return json({ status: "PENDING_DEPOSIT" });
    if (body.action === "cashout") return json({ network: body.network, label: "BNB Smart Chain (BEP20)", symbol: "USDT", depositAddress: body.dry ? null : other(15), receive: "3.19", fee: "0.01", seconds: 13 });
  }
  if (name === "relay") return json({ hash: "mock", ok: true, failure: null, events: [{ event: "contributed", data: [{}] }], notes: [] });
  if (name === "keeper") return json({ done: [] });
  return json({ error: "mock: unknown endpoint" }, 404);
}
