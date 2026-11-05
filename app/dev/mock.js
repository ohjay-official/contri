// @ts-check
// Made-up circles for checking screens offline (MOCK=1 node dev/server.js).
// Never used in production. The member is the device key below; open the app,
// choose "Keep my key on this device", and dev/screens.js seeds the rest.

import { randomBytes, toBase58, toBase64 } from "../public/js/lib/bytes.js";
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

const SEAT_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300'%3E%3Crect width='300' height='300' fill='%23243b7a'/%3E%3Cg fill='none' stroke-width='12' transform='rotate(-90 150 132)'%3E%3Ccircle cx='150' cy='132' r='78' stroke='%233b5394'/%3E%3Ccircle cx='150' cy='132' r='78' stroke='%23f3f4f0' stroke-dasharray='196 490'/%3E%3C/g%3E%3Cg font-family='system-ui' text-anchor='middle'%3E%3Ctext x='150' y='144' font-size='34' fill='%23f3f4f0'%3E4/5%3C/text%3E%3Ctext x='150' y='246' font-size='15' fill='%23f3f4f0'%3EPays in round 4%3C/text%3E%3Ctext x='150' y='274' font-size='11' fill='%23a3b6f3'%3EContri seat %230%3C/text%3E%3C/g%3E%3C/svg%3E";

const balances = { [me0]: 3_200_000n, [me1]: 0n };
const TOKEN = "nep141:usdt.tether-token.near";
// The private balance, and a move out of it waiting for its signature.
let privateHeld = 12_500_000n;
/** @type {{ to: string | null, amount: bigint } | null} */
let pendingMove = null;

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
          case "get_circles": return { ok: circles.slice(a.from_index ?? 0, (a.from_index ?? 0) + (a.limit ?? 50)) };
          case "nft_token": return { ok: { token_id: a.token_id, owner_id: me0, metadata: { title: "Contri seat - turn 4 of 5", media: SEAT_SVG } } };
          default: return { error: `mock has no ${c.method}` };
        }
      }),
    );
  }
  if (name === "swap") {
    if (body.action === "topup") return json({ network: body.network, label: "BNB Smart Chain (BEP20)", symbol: "USDT", depositAddress: "0x7d3A5bE2c1f0aB4E9c8D6F21a0B3c4D5e6F70819", depositMemo: null, send: "1.81", minSend: "1.79", receive: "1.80", deadline: new Date(Date.now() + 86_400_000).toISOString(), seconds: 40 });
    if (body.action === "status") return json({ status: body.depositAddress === other(16) || body.depositAddress === other(17) ? "SUCCESS" : "PENDING_DEPOSIT" });
    if (body.action === "psignin") return json({ session: "mock.session.token.for.the.private.balance", expiresIn: 900 });
    if (body.action === "pbalance") return json({ amount: String(privateHeld) });
    if (body.action === "ptopup") return json({ network: body.network, label: "BNB Smart Chain (BEP20)", symbol: "USDT", depositAddress: "0x1c4B2a9E7d3F60b5A8c1D2e3F4a5B6c7D8e9F0a1", depositMemo: null, send: "10.06", receive: "10.05", deadline: new Date(Date.now() + 86_400_000).toISOString(), seconds: 35 });
    if (body.action === "pmove") {
      if (body.dry) return json({ receive: "9.98", fee: "0.02", seconds: 13 });
      pendingMove = { to: body.to ?? null, amount: BigInt(body.amount) };
      const message = JSON.stringify({ deadline: new Date(Date.now() + 3 * 86_400_000).toISOString(), intents: [{ intent: "transfer", receiver_id: other(16), tokens: { [`imt:${"51e8".repeat(16)}:${TOKEN}`]: body.amount } }], signer_id: body.vault });
      return json({ receive: "1.00", fee: "0", seconds: 10, depositAddress: other(16), intent: { standard: "nep413", payload: { message, nonce: toBase64(randomBytes(32)), recipient: "intents.far" } } });
    }
    if (body.action === "psubmit") {
      if (pendingMove) {
        privateHeld -= pendingMove.amount;
        if (pendingMove.to) balances[pendingMove.to] = (balances[pendingMove.to] ?? 0n) + pendingMove.amount;
        pendingMove = null;
      }
      return json({ intentHash: "mock" });
    }
    if (body.action === "phome") {
      balances[body.from] = (balances[body.from] ?? 0n) - BigInt(body.amount);
      privateHeld += BigInt(body.amount);
      return json({ depositAddress: other(17), receive: "1.00", seconds: 10 });
    }
    if (body.action === "cashout") return json({ network: body.network, label: "BNB Smart Chain (BEP20)", symbol: "USDT", depositAddress: body.dry ? null : other(15), receive: "3.19", fee: "0.01", seconds: 13 });
  }
  if (name === "relay") return json({ hash: "mock", ok: true, failure: null, events: [{ event: "contributed", data: [{}] }], notes: [] });
  if (name === "keeper") return json({ done: [] });
  return json({ error: "mock: unknown endpoint" }, 404);
}
