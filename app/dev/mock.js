// @ts-check
// Made-up circles for checking screens offline (MOCK=1 node dev/server.js).
// Never used in production, and nothing touches a chain.
//
// It behaves like the real thing, in memory: a top-up arrives a few seconds
// after you ask for a deposit address, creating, joining and paying update the
// circles, the last payment of a round pays the pot, and the private balance
// moves money. Two ways in:
//   - "Other ways in" > "Restore from a recovery code" with the code the server
//     prints (MEMBER_CODE): you're in two sample circles, one running, one filling;
//   - "Keep my key on this device": a new member with no circles; start one.

import { fromBase64, randomBytes, toBase58, toBase64 } from "../public/js/lib/bytes.js";
import { recoveryCode } from "../public/js/lib/passkey.js";
import { encryptName } from "../public/js/lib/invite.js";
import { circleSigner } from "../public/js/lib/keys.js";
import { json } from "../server/http.js";

export const CONTRACT = "contri.near";
export const DEVICE_SECRET = new Uint8Array(32).fill(11);
export const INVITE_SECRET = new Uint8Array(32).fill(5);
export const deviceSecretB58 = toBase58(DEVICE_SECRET);
/** The sample member's recovery code, for "Restore from a recovery code". */
export const MEMBER_CODE = recoveryCode(DEVICE_SECRET);

const me0 = (await circleSigner(DEVICE_SECRET, CONTRACT, 0)).accountId;
const me1 = (await circleSigner(DEVICE_SECRET, CONTRACT, 1)).accountId;
export const accounts = [me0, me1];

const other = (/** @type {number} */ n) => n.toString(16).repeat(64).slice(0, 64);
const T = (/** @type {number} */ days) => String(BigInt(Date.now() + days * 86_400_000) * 1_000_000n);
const member = (/** @type {string} */ a, paid = false, missed = 0, deposit = "5000000") => ({ account_id: a, deposit, paid_this_round: paid, defaulted: missed > 0, missed });

/** @type {any[]} */
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

/** @type {Record<string, bigint>} */
const balances = { [me0]: 3_200_000n, [me1]: 0n };
const TOKEN = "nep141:usdt.tether-token.near";
// The private balance, and a move out of it waiting for its signature.
let privateHeld = 12_500_000n;
/** @type {{ to: string | null, amount: bigint } | null} */
let pendingMove = null;

/** Top-ups waiting to "arrive": deposit address -> where and how much. @type {Map<string, { account: string, amount: bigint, at: number }>} */
const arriving = new Map();
let nextAddress = 1;
const freshAddress = () => `0x${(nextAddress++).toString(16).padStart(40, "c")}`;

/** Applies a signed intent to the made-up circles, as the contract would. Returns its events. @param {any} payload */
function apply(payload) {
  const message = JSON.parse(payload.payload.message);
  const who = message.signer_id;
  /** @type {{ event: string, data: any[] }[]} */
  const events = [];
  /** @type {string[]} */
  const notes = [];
  for (const i of message.intents) {
    if (i.intent === "transfer" && i.receiver_id !== CONTRACT) {
      // A plain transfer out (a cash-out to a 1Click deposit address).
      const amount = BigInt(Object.values(i.tokens)[0]);
      balances[who] = (balances[who] ?? 0n) - amount;
      continue;
    }
    const msg = i.msg ?? i.msg_auth ?? "";
    const amount = i.tokens ? BigInt(Object.values(i.tokens)[0]) : 0n;
    if (i.intent === "transfer") balances[who] = (balances[who] ?? 0n) - amount;
    const [kind, ...args] = (i.intent === "auth_call" ? i.msg : msg).split(":");
    if (kind === "create") {
      const [contribution, size, period, order, , ...name] = args;
      const id = circles.length;
      circles.push({
        id, name: name.join(":"), organizer: who, contribution, size: Number(size), period_secs: Number(period),
        members: [member(who, false, 0, contribution)], listings: Array(Number(size)).fill(null), invite_only: true, random_order: order === "random",
        fill_by: T(14), backing: "0", backers: [], status: "Open", created_at: T(0), started_at: "0", round: 0, pot: "0", paying: false, payouts: [], round_deadline: null,
      });
      events.push({ event: "circle_created", data: [{ circle: id }] });
    } else if (kind === "join") {
      const c = circles[Number(args[0])];
      if (!c || c.status !== "Open" || c.members.some((/** @type {any} */ m) => m.account_id === who)) {
        balances[who] += amount;
        notes.push("refunded: can't join");
        continue;
      }
      c.members.push(member(who, false, 0, String(amount)));
      events.push({ event: "joined", data: [{ circle: c.id, member: who }] });
      if (c.members.length === c.size) {
        c.status = "Active";
        c.started_at = T(0);
        c.round_deadline = T(c.period_secs / 86400);
      }
    } else if (kind === "contribute") {
      const c = circles[Number(args[0])];
      const m = c?.members.find((/** @type {any} */ x) => x.account_id === who);
      if (!c || !m || m.paid_this_round || Number(args[1]) !== c.round) {
        balances[who] += amount;
        notes.push("refunded: nothing to pay");
        continue;
      }
      m.paid_this_round = true;
      c.pot = String(BigInt(c.pot) + amount);
      events.push({ event: "contributed", data: [{ circle: c.id, round: c.round, member: who }] });
      if (c.members.every((/** @type {any} */ x) => x.paid_this_round)) {
        const to = c.members[c.round].account_id;
        balances[to] = (balances[to] ?? 0n) + BigInt(c.pot);
        c.payouts.push({ round: c.round, to, amount: c.pot, shortfall: "0", at: T(0) });
        events.push({ event: "paid_out", data: [{ circle: c.id, round: c.round, to }] });
        c.pot = "0";
        c.round++;
        for (const x of c.members) x.paid_this_round = false;
        if (c.round >= c.size) {
          c.status = "Finished";
          c.round_deadline = null;
          for (const x of c.members) {
            balances[x.account_id] = (balances[x.account_id] ?? 0n) + BigInt(x.deposit);
            x.deposit = "0";
          }
        } else c.round_deadline = T((c.round + 1) * (c.period_secs / 86400));
      }
    } else {
      events.push({ event: kind, data: [{}] });
    }
  }
  return { hash: "mock", ok: true, failure: null, events, notes };
}

/** @param {string} name @param {Request} request */
export async function handle(name, request) {
  const body = request.method === "POST" ? await request.json() : {};
  if (name === "config") return json({ network: "mock", contractId: CONTRACT, intentsId: "intents.near", tokenId: "nep141:usdt.tether-token.near", relaying: true });
  if (name === "rpc") {
    return json(
      body.calls.map((/** @type {any} */ c) => {
        const a = c.args ?? {};
        switch (c.method) {
          case "get_circles_for": return { ok: circles.filter((x) => x.members.some((/** @type {any} */ m) => m.account_id === a.account_id) || x.organizer === a.account_id).map((x) => x.id) };
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
    if (body.action === "topup") {
      const depositAddress = freshAddress();
      const amount = BigInt(body.amount);
      arriving.set(depositAddress, { account: body.account, amount, at: Date.now() });
      const send = ((amount * 1005n) / 1000n + 9999n) / 10000n;
      return json({ network: body.network, label: "BNB Smart Chain (BEP20)", symbol: "USDT", depositAddress, depositMemo: null, send: `${send / 100n}.${String(send % 100n).padStart(2, "0")}`, minSend: "1.00", receive: (Number(amount) / 1e6).toFixed(2), deadline: new Date(Date.now() + 86_400_000).toISOString(), seconds: 5 });
    }
    if (body.action === "status") {
      // A top-up "arrives" 4 seconds after its address was handed out.
      const t = arriving.get(body.depositAddress);
      if (t) {
        if (Date.now() - t.at < 4000) return json({ status: "PENDING_DEPOSIT" });
        balances[t.account] = (balances[t.account] ?? 0n) + t.amount;
        arriving.delete(body.depositAddress);
        return json({ status: "SUCCESS" });
      }
      return json({ status: body.depositAddress?.startsWith("0x7d3A") ? "PENDING_DEPOSIT" : "SUCCESS" });
    }
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
  if (name === "relay") return json(apply(body.signed[0]));
  if (name === "keeper") return json({ done: [] });
  return json({ error: "mock: unknown endpoint" }, 404);
}
