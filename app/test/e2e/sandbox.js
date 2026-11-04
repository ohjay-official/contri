// @ts-check
// The app's own code against the real contracts, on a local NEAR sandbox.
//
// Run by contract/sandbox/tests/e2e.rs (`the_app_runs_a_circle_through_its_relayer`),
// which deploys NEAR Intents (built from source), a USDT token and Contri,
// then starts this script with:
//   NEAR_RPC, CONTRI_ACCOUNT_ID, INTENTS_ID, TOKEN_ID     where everything is
//   RELAYER_ACCOUNT_ID, RELAYER_KEY                        the relayer's account
//   FUNDER_ID, FUNDER_KEY                                  the token, to fund members
//
// Members are keys derived exactly as in the browser (circleSigner). Every
// action goes through the same API handlers the app calls: /api/relay,
// /api/rpc and /api/keeper.

import assert from "node:assert/strict";
import { POST as keeperPost } from "../../api/keeper.js";
import { POST as relayPost } from "../../api/relay.js";
import { POST as rpcPost } from "../../api/rpc.js";
import { actions, findEvent } from "../../public/js/lib/contri.js";
import { signIntents, transfer } from "../../public/js/lib/intents.js";
import { decryptName, encryptName, inviteSigner, newSecret, signJoin } from "../../public/js/lib/invite.js";
import { circleSigner, signerFromSecretKey } from "../../public/js/lib/keys.js";
import { rpc, sendTransaction, TGAS } from "../../public/js/lib/near.js";
import { toHex } from "../../public/js/lib/bytes.js";

const env = /** @param {string} k */ (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};
const RPC = env("NEAR_RPC");
const CONTRI = env("CONTRI_ACCOUNT_ID");
const TOKEN = env("TOKEN_ID");
const INTENTS = env("INTENTS_ID");
const USDT = 1_000_000n;
const C = 5n * USDT;
const a = actions(CONTRI, TOKEN);

/** @param {(r: Request) => Promise<Response>} handler @param {object} body */
async function call(handler, body) {
  const res = await handler(new Request("http://app/api", { method: "POST", body: JSON.stringify(body) }));
  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${json.error}`);
  return json;
}

/** @param {"contri" | "intents"} contract @param {string} method @param {object} args */
async function view(contract, method, args) {
  const [r] = await call(rpcPost, { calls: [{ contract, method, args }] });
  if (r.error) throw new Error(r.error);
  return r.ok;
}
const circle = (/** @type {number} */ id) => view("contri", "get_circle", { circle_id: id });
const balance = async (/** @type {string} */ account) => BigInt(await view("intents", "mt_balance_of", { account_id: account, token_id: TOKEN }));

/** The sandbox clock, in ms: intents are checked against block time, which fast-forwarding moves ahead of ours. */
async function chainNow() {
  const b = await rpc(RPC, "block", { finality: "final" });
  return Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n);
}

/** Signs as `who` and relays. @param {import("../../public/js/lib/keys.js").Signer} who @param {object[]} intents */
async function act(who, intents, what = "") {
  const signed = await signIntents(who, intents, { now: await chainNow(), recipient: INTENTS });
  const r = await call(relayPost, { signed: [signed] });
  assert.ok(r.ok, `${what}: ${r.failure}`);
  console.log(`  ${what}: ${r.events.map((/** @type {any} */ e) => e.event).join(", ") || "no events"} ${r.notes.join(" | ")}`);
  return r;
}

async function passDeadline(/** @type {number} */ id) {
  const deadline = Number(BigInt((await circle(id)).round_deadline) / 1_000_000n);
  for (let i = 0; i < 30 && (await chainNow()) <= deadline; i++) await rpc(RPC, "sandbox_fast_forward", { delta_height: 50 });
  assert.ok((await chainNow()) > deadline, "the sandbox clock passed the deadline");
}

console.log("app e2e: three members, one circle, everything through the app's relayer");

// Members: keys derived from three passkey secrets, as in the browser.
const [ada, bayo, chioma] = await Promise.all([1, 2, 3].map((n) => circleSigner(new Uint8Array(32).fill(n), CONTRI, 0)));

// Top-ups: the token sends 50 USDT into each member's NEAR Intents balance (1Click does this on mainnet).
const funder = await signerFromSecretKey(env("FUNDER_KEY"), env("FUNDER_ID"));
for (const m of [ada, bayo, chioma]) {
  await sendTransaction(RPC, funder, funder.accountId, [
    { functionCall: { method: "ft_transfer_call", args: { receiver_id: INTENTS, amount: (50n * USDT).toString(), msg: m.accountId }, gas: 100n * TGAS, deposit: 1n } },
  ]);
}
assert.equal(await balance(ada.accountId), 50n * USDT);

// Ada creates an invite-only circle with an encrypted name, paying her deposit.
const secret = newSecret();
const inviteKey = toHex((await inviteSigner(secret)).publicKey);
const name = await encryptName(secret, "Yaba Traders Ajo");
const created = await act(ada, a.create({ contribution: C, size: 3, periodSecs: 60, random: false, inviteKeyHex: inviteKey, name }), "create");
const id = findEvent(created.events, "circle_created").circle;
let c = await circle(id);
assert.equal(c.organizer, ada.accountId);
assert.equal(c.members.length, 1);
assert.equal(await decryptName(secret, c.name), "Yaba Traders Ajo", "the name only opens with the invite secret");

// Without the invite, a join is refunded; with it, Bayo and Chioma join and the circle starts.
const refused = await act(bayo, a.join(id, C, null), "join without invite");
assert.equal(findEvent(refused.events, "joined"), undefined);
assert.equal(await balance(bayo.accountId), 50n * USDT, "refunded");
for (const m of [bayo, chioma]) await act(m, a.join(id, C, await signJoin(secret, CONTRI, id, m.accountId, C)), "join with invite");
c = await circle(id);
assert.equal(c.status, "Active");
assert.deepEqual(c.members.map((/** @type {any} */ m) => m.account_id), [ada.accountId, bayo.accountId, chioma.accountId]);

// Chioma buys Bayo's turn (seat 1) for 1 USDT.
await act(bayo, a.listSeat(id, 1, USDT), "list seat");
await act(chioma, a.buySeat(id, 1, USDT), "buy seat");
c = await circle(id);
assert.deepEqual(c.members.map((/** @type {any} */ m) => m.account_id), [ada.accountId, chioma.accountId, bayo.accountId]);

// Round 0: everyone pays, and the last payment pays Ada the pot by itself.
const adaBefore = await balance(ada.accountId);
await act(ada, a.contribute(id, 0, C), "contribute");
await act(bayo, a.contribute(id, 0, C), "contribute");
const last = await act(chioma, a.contribute(id, 0, C), "contribute (last)");
assert.ok(findEvent(last.events, "paid_out"), "the last contribution paid out");
assert.equal(await balance(ada.accountId), adaBefore - C + 3n * C);

// Round 1: Bayo misses. After the deadline the keeper settles from his deposit and pays Chioma.
await act(ada, a.contribute(id, 1, C), "contribute");
await act(chioma, a.contribute(id, 1, C), "contribute");
assert.deepEqual((await call(keeperPost, { circle: id })).done, [], "nothing to do before the deadline");
await passDeadline(id);
const settled = await call(keeperPost, { circle: id });
assert.deepEqual(settled.done.map((/** @type {any} */ d) => [d.method, d.ok]), [["settle_round", true]]);
c = await circle(id);
assert.equal(c.round, 2);
assert.equal(c.members[2].missed, 1);

// Round 2: everyone pays; Bayo receives the pot and the circle finishes. The keeper returns what's left of deposits.
for (const m of [ada, chioma, bayo]) await act(m, a.contribute(id, 2, C), "contribute");
c = await circle(id);
assert.equal(c.status, "Finished");
const released = await call(keeperPost, { circle: id });
assert.deepEqual(released.done.map((/** @type {any} */ d) => [d.method, d.ok]), [["release_deposits", true]]);
c = await circle(id);
assert.ok(c.members.every((/** @type {any} */ m) => m.deposit === "0"));

// Money is conserved: all 150 USDT is back with the members, nothing stuck in Contri.
const total = (await balance(ada.accountId)) + (await balance(bayo.accountId)) + (await balance(chioma.accountId));
assert.equal(total, 150n * USDT);
assert.equal(await balance(CONTRI), 0n);
assert.deepEqual(await view("contri", "get_record", { account_id: bayo.accountId }), { completed: 0, defaults: 1, missed_payments: 1 });

// Cash-out: a plain transfer of the member's own money out (to a 1Click deposit account on mainnet).
await act(ada, [transfer(`cashout.${CONTRI}`, TOKEN, USDT)], "cash out");
assert.equal(await balance(`cashout.${CONTRI}`), USDT);

// The relayer refuses intents it shouldn't pay for, before spending gas.
const evil = await signIntents(ada, [transfer(INTENTS, TOKEN, USDT, { msg: "x" })], { now: await chainNow(), recipient: INTENTS });
await assert.rejects(call(relayPost, { signed: [evil] }), /only to Contri/);
// And NEAR Intents' simulation catches what would fail on chain: spending more than the balance.
const broke = await signIntents(bayo, a.contribute(id, 2, 1000n * USDT), { now: await chainNow(), recipient: INTENTS });
await assert.rejects(call(relayPost, { signed: [broke] }), /would reject/);

console.log("app e2e: passed");
