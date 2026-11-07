// @ts-check
// Made-up circles on a pretend chain: the offline app (MOCK=1 node
// dev/server.js) and the demo at /demo, which runs it in the browser.
// Nothing here touches a chain or real money.
//
// It behaves like the real thing, in memory: a top-up arrives a few seconds
// after you ask for a deposit address, creating, joining and paying update the
// circles, the last payment of a round pays the pot, and the private balance
// moves money. Two ways in:
//   - "Other ways in" > "Restore from a recovery code" with the code the server
//     prints (MEMBER_CODE): you're in two sample circles, one running, one filling;
//   - "Keep my key on this device": a new member with no circles; start one.

import { fromBase64, randomBytes, toBase58, toBase64 } from "../lib/bytes.js";
import { recoveryCode } from "../lib/passkey.js";
import { encryptName } from "../lib/invite.js";
import { circleSigner } from "../lib/keys.js";

/** @param {unknown} v @param {number} [status] */
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
/** Settings from the environment when run by Node; none in a browser. @type {Record<string, string | undefined>} */
const env = /** @type {any} */ (globalThis).process?.env ?? {};

export const CONTRACT = "circles.contring.near";
export const DEVICE_SECRET = new Uint8Array(32).fill(11);
export const INVITE_SECRET = new Uint8Array(32).fill(5);
export const deviceSecretB58 = toBase58(DEVICE_SECRET);
/** The sample member's recovery code, for "Restore from a recovery code". */
export const MEMBER_CODE = recoveryCode(DEVICE_SECRET);

const me0 = (await circleSigner(DEVICE_SECRET, CONTRACT, 0)).accountId;
const me1 = (await circleSigner(DEVICE_SECRET, CONTRACT, 1)).accountId;
export const accounts = [me0, me1];

// Other members' accounts: 64 hex characters, like any implicit NEAR account.
const other = (/** @type {number} */ n) => Array.from({ length: 64 }, (_, i) => ((n * 2654435761 + i * 40503 + (i * i * n) % 977) >>> 3) % 16).map((d) => d.toString(16)).join("");
const T = (/** @type {number} */ days) => String(BigInt(Date.now() + days * 86_400_000) * 1_000_000n);
const member = (/** @type {string} */ a, paid = false, missed = 0, deposit = "5000000") => ({ account_id: a, deposit, paid_this_round: paid, defaulted: missed > 0, missed, ahead: 0 });

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
let privateHeld = env.MOCK_EMPTY ? 0n : 12_500_000n;
// MOCK_EMPTY=1: no circles and an empty private balance, like a fresh mainnet.
if (env.MOCK_EMPTY) circles.length = 0;
/** @type {{ to: string | null, amount: bigint } | null} */
let pendingMove = null;

/** Top-ups waiting to "arrive": deposit address -> where and how much. @type {Map<string, { account: string, amount: bigint, at: number }>} */
const arriving = new Map();
let nextAddress = 1;
// A made-up EVM address, different each time, that looks like one.
const freshAddress = () => `0x${other(40 + nextAddress++).slice(0, 40).replace(/[a-f]/g, (c, i) => (i % 3 ? c : c.toUpperCase()))}`;

/** Starts the circle once every seat is taken. @param {any} c */
function startIfFull(c) {
  if (c.members.length === c.size && c.status === "Open") {
    c.status = "Active";
    c.started_at = T(0);
    c.round_deadline = T(c.period_secs / 86400);
  }
}

/** Pays the pot to this round's seat once everyone has paid, as the contract does. @param {any} c @param {{ event: string, data: any[] }[]} events */
function payOutIfPaid(c, events) {
  if (!c.members.every((/** @type {any} */ x) => x.paid_this_round)) return;
  const to = c.members[c.round].account_id;
  balances[to] = (balances[to] ?? 0n) + BigInt(c.pot);
  c.payouts.push({ round: c.round, to, amount: c.pot, shortfall: "0", at: T(0) });
  events.push({ event: "paid_out", data: [{ circle: c.id, round: c.round, to, amount: c.pot }] });
  c.pot = "0";
  c.round++;
  for (const x of c.members) {
    x.paid_this_round = false;
    if (c.round < c.size && x.ahead > 0) {
      x.ahead--;
      x.paid_this_round = true;
      c.pot = String(BigInt(c.pot) + BigInt(c.contribution));
    }
  }
  if (c.listings[c.round - 1] != null) c.listings[c.round - 1] = null;
  if (c.round >= c.size) {
    c.status = "Finished";
    c.round_deadline = null;
    for (const x of c.members) {
      balances[x.account_id] = (balances[x.account_id] ?? 0n) + BigInt(x.deposit);
      x.deposit = "0";
    }
  } else c.round_deadline = T((c.round + 1) * (c.period_secs / 86400));
}

// ---- The demo's pretend members ----
// With bots on (the demo at /demo), circles fill and the other members pay by
// themselves, so one person on one phone can run a whole circle. Off for the
// offline server, whose checks play every member themselves.
let bots = false;
/** Accounts that have signed something here: the person trying the demo. @type {Set<string>} */
const people = new Set(accounts);
let botNo = 100;
export function useBots() {
  if (bots) return;
  bots = true;
  // Enough to buy a turn and pay a round straight away.
  balances[me0] = 10_000_000n;
}
/** The pretend members pay this round. @param {any} c */
function botsPay(c) {
  for (const m of c.members) {
    if (people.has(m.account_id) || m.paid_this_round) continue;
    m.paid_this_round = true;
    c.pot = String(BigInt(c.pot) + BigInt(c.contribution));
  }
}
/** Moves the pretend members along: joining new circles a few seconds after they're made. */
function tick() {
  if (!bots) return;
  const now = Date.now();
  for (const c of circles) {
    if (c.status === "Open" && c.fillAt && now >= c.fillAt) {
      while (c.members.length < c.size) c.members.push(member(other(botNo++), false, 0, c.contribution));
      startIfFull(c);
      delete c.fillAt;
    }
  }
}

/** Applies a signed intent to the made-up circles, as the contract would. Returns its events. @param {any} payload */
function apply(payload) {
  const message = JSON.parse(payload.payload.message);
  const who = message.signer_id;
  people.add(who);
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
      if (bots) circles[id].fillAt = Date.now() + 3000;
    } else if (kind === "join") {
      const c = circles[Number(args[0])];
      if (!c || c.status !== "Open" || c.members.some((/** @type {any} */ m) => m.account_id === who)) {
        balances[who] += amount;
        notes.push("refunded: can't join");
        continue;
      }
      c.members.push(member(who, false, 0, String(amount)));
      events.push({ event: "joined", data: [{ circle: c.id, member: who }] });
      startIfFull(c);
    } else if (kind === "contribute" || kind === "ahead") {
      const c = circles[Number(args[0])];
      const m = c?.members.find((/** @type {any} */ x) => x.account_id === who);
      const rounds = kind === "ahead" ? Number(args[1]) : 1;
      const left = c && m ? c.size - c.round - (m.paid_this_round ? 1 : 0) - (m.ahead ?? 0) : 0;
      const wrong = kind === "ahead" ? rounds < 1 || rounds > left || amount !== BigInt(c.contribution) * BigInt(rounds) : m?.paid_this_round || Number(args[1]) !== c?.round;
      if (!c || !m || wrong) {
        balances[who] += amount;
        notes.push("refunded: nothing to pay");
        continue;
      }
      let later = rounds;
      if (!m.paid_this_round) {
        m.paid_this_round = true;
        c.pot = String(BigInt(c.pot) + BigInt(c.contribution));
        later--;
        events.push({ event: "contributed", data: [{ circle: c.id, round: c.round, member: who }] });
      }
      if (kind === "ahead") {
        m.ahead = (m.ahead ?? 0) + later;
        events.push({ event: "paid_ahead", data: [{ circle: c.id, member: who, rounds: later, ahead: m.ahead }] });
      }
      // In the demo, the other (pretend) members pay as soon as you do, so
      // your payment closes the round and pays the pot, as the last one would.
      if (bots) botsPay(c);
      payOutIfPaid(c, events);
    } else if (kind === "buy_seat") {
      const c = circles[Number(args[0])];
      const s = Number(args[1]);
      const buyer = c?.members.findIndex((/** @type {any} */ x) => x.account_id === who) ?? -1;
      const price = c?.listings[s];
      if (!c || c.status !== "Active" || price == null || BigInt(price) !== amount || buyer <= s || s < c.round) {
        balances[who] += amount;
        notes.push("refunded: that turn isn't for sale at that price");
        continue;
      }
      const seller = c.members[s].account_id;
      [c.members[s], c.members[buyer]] = [c.members[buyer], c.members[s]];
      c.listings[s] = null;
      balances[seller] = (balances[seller] ?? 0n) + amount;
      events.push({ event: "seat_bought", data: [{ circle: c.id, seat: s, buyer: who, seller, price: String(amount) }] });
    } else if (kind === "list_seat" || kind === "unlist_seat") {
      const c = circles[Number(args[0])];
      const s = Number(args[1]);
      if (!c || c.members[s]?.account_id !== who || s < c.round) {
        notes.push("only the seat's owner can do this");
        continue;
      }
      c.listings[s] = kind === "list_seat" ? args[2] : null;
      events.push({ event: kind === "list_seat" ? "seat_listed" : "seat_unlisted", data: [{ circle: c.id, seat: s }] });
    } else {
      events.push({ event: kind, data: [{}] });
    }
  }
  return { hash: "mock", ok: true, failure: null, events, notes };
}

/** @param {string} name @param {Request} request */
export async function handle(name, request) {
  tick();
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
          case "get_credit": return { ok: "0" };
          case "get_config": return { ok: { owner_id: "contring.near", intents_id: "intents.near", token_id: "nep141:usdt.tether-token.near", circle_count: circles.length } };
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
      const send = ((amount * 10075n) / 10000n + 9999n) / 10000n;
      return json({ network: body.network, label: "BNB Smart Chain (BEP20)", symbol: "USDT", depositAddress, depositMemo: null, send: `${send / 100n}.${String(send % 100n).padStart(2, "0")}`, minSend: "1.00", receive: (Number(amount) / 1e6).toFixed(2), contriFee: "0.25%", contriFeeUsd: "0.03", deadline: new Date(Date.now() + 86_400_000).toISOString(), seconds: 5 });
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
    if (body.action === "ptopup") return json({ network: body.network, label: "BNB Smart Chain (BEP20)", symbol: "USDT", depositAddress: "0x1c4B2a9E7d3F60b5A8c1D2e3F4a5B6c7D8e9F0a1", depositMemo: null, send: "10.08", receive: "10.05", contriFee: "0.25%", contriFeeUsd: "0.03", deadline: new Date(Date.now() + 86_400_000).toISOString(), seconds: 35 });
    if (body.action === "pmove") {
      if (body.dry) return json({ receive: "9.95", fee: "0.02", contriFee: body.to ? null : "0.25%", contriFeeUsd: body.to ? null : "0.03", seconds: 13 });
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
    if (body.action === "cashout") return json({ network: body.network, label: "BNB Smart Chain (BEP20)", symbol: "USDT", depositAddress: body.dry ? null : other(15), receive: "3.18", fee: "0.01", contriFee: "0.25%", contriFeeUsd: "0.01", seconds: 13 });
  }
  if (name === "relay") return json(apply(body.signed[0]));
  if (name === "keeper") return json({ done: [] });
  return json({ error: "mock: unknown endpoint" }, 404);
}
