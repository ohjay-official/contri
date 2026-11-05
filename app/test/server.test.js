// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { actions } from "../public/js/lib/contri.js";
import { authCall, signIntents, transfer } from "../public/js/lib/intents.js";
import { signerFromSeed } from "../public/js/lib/keys.js";
import { needs } from "../server/keeper.js";
import { formatUnits, toSend } from "../server/oneclick.js";
import { allow } from "../server/limit.js";
import { checkPayload, memberNote, relay } from "../server/relay.js";
import { issueTicket, ticketed } from "../server/ticket.js";
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
  ]) {
    assert.equal(await checkPayload(await sign(intents), c), member.accountId);
  }
  // A cash-out: a plain transfer to the 1Click deposit account /api/swap opened, with its ticket.
  const ticket = await issueTicket(c.relayerKey, "1click-deposit.near");
  assert.equal(await checkPayload(await sign([transfer("1click-deposit.near", TOKEN, 5_000_000n)]), c, Date.now(), [ticket]), member.accountId);
});

test("money leaves only for a deposit account Contri opened in the last half hour", async () => {
  const deposit = "a".repeat(64);
  const out = await sign([transfer(deposit, TOKEN, 5_000_000n)]);
  await assert.rejects(checkPayload(out, c), /deposit account Contri just set up/);
  await assert.rejects(checkPayload(out, c, Date.now(), [await issueTicket(c.relayerKey, "b".repeat(64))]), /deposit account/);
  await assert.rejects(checkPayload(out, c, Date.now(), [await issueTicket("another key", deposit)]), /deposit account/);
  const old = await issueTicket(c.relayerKey, deposit, Date.now() - 31 * 60_000);
  assert.equal(await ticketed(c.relayerKey, deposit, [old]), false, "expired");
  assert.equal(await ticketed(c.relayerKey, deposit, ["9999999999999.00"]), false, "forged");
  assert.equal(await checkPayload(out, c, Date.now(), ["junk", await issueTicket(c.relayerKey, deposit)]), member.accountId);
});

test("the relayer pays only for Contri's token and messages Contri reads", async () => {
  const refused = async (/** @type {any} */ p, /** @type {RegExp} */ why) => assert.rejects(checkPayload(p, c), why);
  await refused(await sign([transfer("contri.near", "nep141:other.near", 5_000_000n, { msg: "join:0" })]), /only Contri's token/);
  await refused(await sign([transfer("contri.near", TOKEN, 5_000_000n, { msg: "x" })]), /wouldn't understand/);
  await refused(await sign([transfer("contri.near", TOKEN, 5_000_000n, { msg: "join:0:zz" })]), /wouldn't understand/);
  await refused(await sign([authCall("contri.near", "x")]), /wouldn't understand/);
  await refused(await sign([authCall("contri.near", "leave:0:1")]), /wouldn't understand/);
  for (const msg of ["back:0", "refill:3", "buy_seat:1:2", "contribute:0:4", `join:0:${"ab".repeat(64)}`, `create:1000000:2:60:random:${"0".repeat(64)}:v1.a:b`]) {
    assert.equal(await checkPayload(await sign([transfer("contri.near", TOKEN, 1_000_000n, { msg })]), c), member.accountId, msg);
  }
  for (const msg of ["claim_credit", "cancel:0", "unlist_seat:0:1", "list_seat:0:1:5"]) {
    assert.equal(await checkPayload(await sign([authCall("contri.near", msg)]), c), member.accountId, msg);
  }
});

test("request limits count per caller over a minute", () => {
  const t = 1_000_000;
  for (let i = 0; i < 3; i++) assert.ok(allow("test:x", 3, t + i));
  assert.equal(allow("test:x", 3, t + 10), false);
  assert.ok(allow("test:y", 3, t + 10), "others aren't affected");
  assert.ok(allow("test:x", 3, t + 60_001), "a minute later it's allowed again");
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

test("a busy RPC node falls over to the next one", async () => {
  const { rpc } = await import("../public/js/lib/near.js");
  const real = globalThis.fetch;
  /** @type {string[]} */
  const asked = [];
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url) => {
    asked.push(url);
    if (url.includes("busy")) return new Response("slow down", { status: 429 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "contri", result: "ok" }), { status: 200 });
  });
  try {
    assert.equal(await rpc("https://busy.example,https://fine.example", "status", []), "ok");
    assert.deepEqual(asked, ["https://busy.example", "https://fine.example"]);
    await assert.rejects(rpc("https://busy.example", "status", []), /HTTP 429/);
  } finally {
    globalThis.fetch = real;
  }
});

test("a transaction the node stopped waiting for is followed by hash, not sent again", async () => {
  const { sendTransaction, toBase58 } = { ...(await import("../public/js/lib/near.js")), ...(await import("../public/js/lib/bytes.js")) };
  const real = globalThis.fetch;
  /** @type {string[]} */
  const methods = [];
  let polls = 0;
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ init) => {
    const { method } = JSON.parse(init.body);
    methods.push(method);
    const ok = (/** @type {unknown} */ result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "contri", result }), { status: 200 });
    const fail = (/** @type {string} */ name) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "contri", error: { name: "HANDLER_ERROR", cause: { name } } }), { status: 200 });
    if (method === "query") return ok({ nonce: 5, block_hash: toBase58(new Uint8Array(32).fill(1)) });
    if (method === "send_tx") return fail("TIMEOUT_ERROR");
    if (method === "tx") return ++polls < 2 ? fail("TIMEOUT_ERROR") : ok({ status: { SuccessValue: "" } });
    return fail("UNKNOWN");
  });
  try {
    const r = await sendTransaction("https://rpc.example", member, "contri.near", [{ transfer: { deposit: 1n } }], "FINAL");
    assert.deepEqual(r.result.status, { SuccessValue: "" });
    assert.deepEqual(methods, ["query", "send_tx", "tx", "tx"], "signed and sent once");
  } finally {
    globalThis.fetch = real;
  }
});

test("the contract's refund reasons reach members in plain words", () => {
  assert.equal(memberNote("contri: refunding 5000000: circle is full"), "Circle is full");
  assert.equal(memberNote("contri: refunding 3000000: Contri is out of storage room right now"), "Contri is full right now and can't take new circles or members. Try again later");
  assert.equal(memberNote("contri: refunding 999999: contribution must be at least 1 USDT"), "The amount each round has to be at least $1");
});
