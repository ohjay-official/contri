// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { actions } from "../public/js/lib/contri.js";
import { authCall, signIntents, transfer } from "../public/js/lib/intents.js";
import { signerFromSeed } from "../public/js/lib/keys.js";
import { needs } from "../server/keeper.js";
import { formatUnits, toSend } from "../server/oneclick.js";
import { checkPayload, relay } from "../server/relay.js";
import { views } from "../server/views.js";

const TOKEN = "nep141:usdt.tether-token.near";
/** @type {import("../server/config.js").Config} */
const c = {
  network: "sandbox", rpcUrl: "http://127.0.0.1:1", contractId: "contri.near", intentsId: "intents.near", tokenId: TOKEN,
  relayerId: "relayer.near", relayerKey: "", oneClickUrl: "", oneClickKey: "",
};
const member = await signerFromSeed(new Uint8Array(32).fill(3));
const a = actions(c.contractId, TOKEN);

/** @param {object[]} intents @param {object} [opts] */
const sign = (intents, opts) => signIntents(member, intents, opts);

test("the relayer accepts what members sign", async () => {
  for (const intents of [
    a.join(0, 5_000_000n, null),
    a.contribute(0, 1, 5_000_000n),
    a.create({ contribution: 5_000_000n, size: 3, periodSecs: 60, random: false, inviteKeyHex: null, name: "v1.x" }),
    a.leave(0),
    a.listSeat(0, 1, 1n),
    [transfer("1click-deposit.near", TOKEN, 5_000_000n)], // a cash-out
  ]) {
    assert.equal(await checkPayload(await sign(intents), c), member.accountId);
  }
});

test("the relayer refuses anything else before spending gas", async () => {
  const refused = async (/** @type {any} */ p, /** @type {RegExp} */ why) => assert.rejects(checkPayload(p, c), why);
  await refused(await sign([{ intent: "token_diff", diff: {} }]), /isn't relayed/);
  await refused(await sign([authCall("evil.near", "x")]), /only to Contri/);
  await refused(await sign([transfer("evil.near", TOKEN, 1n, { msg: "call me" })]), /only to Contri/);
  await refused(await sign([transfer("contri.near", TOKEN, 1n)]), /needs a message/);
  await refused(await sign([transfer("contri.near", TOKEN, 0n, { msg: "join:0" })]), /one token/);
  await refused(await sign([transfer("contri.near", TOKEN, 1n, { msg: "join:0", minGas: "300000000000000" })]), /too much gas/);
  await refused(await sign([...a.leave(0), ...a.leave(1), ...a.leave(2)]), /number of intents/);
  await refused(await sign(a.leave(0), { now: Date.now() - 3_600_000 }), /expired/);
  await refused(await sign(a.leave(0), { validForMs: 24 * 3_600_000 }), /too long/);
  await refused(await signIntents(member, a.leave(0), { recipient: "other.near" }), /signed for intents.near/);
  await refused({ standard: "erc191" }, /NEP-413/);

  const tampered = await sign(a.leave(0));
  tampered.payload.message = tampered.payload.message.replace("leave:0", "leave:1");
  await refused(tampered, /signature doesn't match/);

  const other = await signerFromSeed(new Uint8Array(32).fill(4));
  const impostor = await sign(a.leave(0));
  impostor.public_key = other.publicKeyStr;
  await refused(impostor, /signature doesn't match/);
});

test("the relayer needs its settings", async () => {
  await assert.rejects(relay({ signed: [] }, c), /isn't set up/);
  await assert.rejects(relay({ signed: [] }, { ...c, relayerKey: "ed25519:x" }), /1 or 2/);
});

test("the read proxy answers only Contri and balance views", async () => {
  const r = await views({ calls: [{ contract: "intents", method: "execute_intents" }, { contract: "x", method: "get_circle" }, { contract: "contri", method: "new" }] }, c);
  assert.ok(r.every((x) => "error" in x));
  await assert.rejects(views({ calls: [] }, c), /send 1 to 25/);
});

test("the keeper acts only when a circle needs it", () => {
  const m = (/** @type {boolean} */ paid, deposit = "5") => ({ account_id: "a", deposit, paid_this_round: paid, defaulted: false, missed: 0 });
  /** @type {any} */
  const base = { paying: false, backers: [], round_deadline: "60000000000" };
  assert.equal(needs({ ...base, status: "Open", members: [m(false)] }, 0), null);
  assert.equal(needs({ ...base, status: "Active", members: [m(true), m(false)] }, 0), null);
  assert.equal(needs({ ...base, status: "Active", members: [m(true), m(false)] }, 61_000), "settle_round");
  assert.equal(needs({ ...base, status: "Active", members: [m(true), m(true)] }, 0), "pay_out");
  assert.equal(needs({ ...base, status: "Active", paying: true, members: [m(true), m(true)] }, 0), null);
  assert.equal(needs({ ...base, status: "Finished", members: [m(true, "0"), m(true, "5")] }, 0), "release_deposits");
  assert.equal(needs({ ...base, status: "Finished", members: [m(true, "0")] }, 0), null);
  assert.equal(needs({ ...base, status: "Cancelled", members: [], backers: [{ account_id: "d", amount: "9", due: "3" }] }, 0), "release_deposits");
});

test("token amounts for people round up to the cent", () => {
  assert.equal(formatUnits(2_010_000_000_000_000_000n, 18), "2.01");
  assert.equal(formatUnits(2_000_001n, 6), "2.01");
  assert.equal(formatUnits(2_000_000n, 6), "2.00");
});

test("members are asked to send whole cents, a little over what has to arrive", () => {
  assert.equal(toSend(3_000_000n, 18), 3_020_000_000_000_000_000n, "$3 arrives from 3.02 USDT on BNB Chain");
  assert.equal(toSend(1_000_000n, 6), 1_010_000n);
  assert.equal(toSend(5_000_000n, 6), 5_030_000n);
});
