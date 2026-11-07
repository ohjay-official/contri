// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { actions } from "../public/js/lib/contri.js";
import { authCall, signIntents, transfer } from "../public/js/lib/intents.js";
import { signerFromSeed } from "../public/js/lib/keys.js";
import { toBase58 } from "../public/js/lib/bytes.js";
import { keep, needs } from "../server/keeper.js";
import { formatUnits, toSend } from "../server/oneclick.js";
import { allow, useOnce } from "../server/limit.js";
import { authProblem, checkPayload, memberNote, paymentProblem, relay } from "../server/relay.js";
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
  const ticket = await issueTicket(c.relayerKey, "1click-deposit.near", member.accountId, 5_000_000n);
  assert.equal(await checkPayload(await sign([transfer("1click-deposit.near", TOKEN, 5_000_000n)]), c, Date.now(), [ticket]), member.accountId);
});

test("money leaves only for a deposit account Contri opened in the last half hour", async () => {
  const deposit = "a".repeat(64);
  const me = member.accountId;
  const out = await sign([transfer(deposit, TOKEN, 5_000_000n)]);
  await assert.rejects(checkPayload(out, c), /deposit account Contri just set up/);
  await assert.rejects(checkPayload(out, c, Date.now(), [await issueTicket(c.relayerKey, "b".repeat(64), me, 5_000_000n)]), /deposit account/);
  await assert.rejects(checkPayload(out, c, Date.now(), [await issueTicket("another key", deposit, me, 5_000_000n)]), /deposit account/);
  // A ticket is for one payer and one exact amount.
  await assert.rejects(checkPayload(out, c, Date.now(), [await issueTicket(c.relayerKey, deposit, "c".repeat(64), 5_000_000n)]), /deposit account/);
  await assert.rejects(checkPayload(out, c, Date.now(), [await issueTicket(c.relayerKey, deposit, me, 1n)]), /deposit account/);
  const old = await issueTicket(c.relayerKey, deposit, me, 5_000_000n, Date.now() - 31 * 60_000);
  assert.equal(await ticketed(c.relayerKey, deposit, me, 5_000_000n, [old]), null, "expired");
  assert.equal(await ticketed(c.relayerKey, deposit, me, 5_000_000n, ["9999999999999.00"]), null, "forged");
  const good = await issueTicket(c.relayerKey, deposit, me, 5_000_000n);
  assert.equal(await checkPayload(out, c, Date.now(), ["junk", good]), me);
  // One ticket serves one transfer, even within one request.
  const twice = await sign([transfer(deposit, TOKEN, 5_000_000n), transfer(deposit, TOKEN, 5_000_000n)]);
  await assert.rejects(checkPayload(twice, c, Date.now(), [good]), /deposit account/);
  // And once across requests.
  assert.equal(await useOnce(`ticket:${good}`, 60), true);
  assert.equal(await useOnce(`ticket:${good}`, 60), false);
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
  const base = { paying: false, backers: [], round_deadline: "60000000000", fill_by: "60000000000" };
  assert.equal(needs({ ...base, status: "Open", members: [m(false)] }, 0), null);
  // An open circle that never filled is cancelled once fill_by has passed.
  assert.equal(needs({ ...base, status: "Open", members: [m(false)] }, 60_000), null);
  assert.equal(needs({ ...base, status: "Open", members: [m(false)] }, 60_001), "cancel_circle");
  assert.equal(needs({ ...base, status: "Active", members: [m(true), m(false)] }, 0), null);
  assert.equal(needs({ ...base, status: "Active", members: [m(true), m(false)] }, 61_000), "settle_round");
  assert.equal(needs({ ...base, status: "Active", members: [m(true), m(true)] }, 0), "pay_out");
  assert.equal(needs({ ...base, status: "Active", paying: true, members: [m(true), m(true)] }, 0), null);
  assert.equal(needs({ ...base, status: "Finished", members: [m(true, "0"), m(true, "5")] }, 0), "release_deposits");
  assert.equal(needs({ ...base, status: "Finished", members: [m(true, "0")] }, 0), null);
  assert.equal(needs({ ...base, status: "Cancelled", members: [], backers: [{ account_id: "d", amount: "9", due: "3" }] }, 0), "release_deposits");
  // Once a cancelled circle has paid everyone back, it is closed to free storage.
  assert.equal(needs({ ...base, status: "Cancelled", members: [m(false, "0")], backers: [{ account_id: "d", amount: "9", due: "0" }] }, 0), "close_circle");
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

test("the relayer refuses payments the contract would refund, before paying gas", () => {
  const me = "a".repeat(64);
  /** @type {any} */
  const open = { status: "Open", size: 3, contribution: "5000000", round: 0, paying: false, listings: [null, null, null], members: [{ account_id: "o", deposit: "5000000", paid_this_round: false }] };
  /** @type {any} */
  const running = {
    ...open,
    status: "Active",
    round: 1,
    listings: [null, "2000000", null],
    members: [{ account_id: "o", deposit: "5000000", paid_this_round: true }, { account_id: "b", deposit: "5000000", paid_this_round: false }, { account_id: me, deposit: "5000000", paid_this_round: false }],
  };
  assert.equal(paymentProblem("create:5000000:3:86400:join:-:x", 5_000_000n, me, null), null);
  assert.match(String(paymentProblem("create:500000:3:86400:join:-:x", 500_000n, me, null)), /at least \$1/);
  assert.match(String(paymentProblem("create:5000000:21:86400:join:-:x", 5_000_000n, me, null)), /2 to 20/);
  assert.match(String(paymentProblem("create:5000000:3:86400:join:-:x", 1_000_000n, me, null)), /one contribution/);
  assert.match(String(paymentProblem("join:9", 5_000_000n, me, null)), /no such circle/);
  assert.equal(paymentProblem("join:0", 5_000_000n, me, open), null);
  assert.match(String(paymentProblem("join:0", 4_000_000n, me, open)), /one contribution/);
  assert.match(String(paymentProblem("join:0", 5_000_000n, "o", open)), /already in/);
  assert.match(String(paymentProblem("join:0", 5_000_000n, me, running)), /isn't taking/);
  assert.match(String(paymentProblem("join:0", 5_000_000n, me, { ...open, invite_only: true })), /needs an invite/);
  assert.equal(paymentProblem(`join:0:${"ab".repeat(64)}`, 5_000_000n, me, { ...open, invite_only: true }), null);
  assert.equal(paymentProblem("contribute:0:1", 5_000_000n, me, running), null);
  assert.match(String(paymentProblem("contribute:0:0", 5_000_000n, me, running)), /already closed/);
  assert.match(String(paymentProblem("contribute:0:1", 5_000_000n, "o", running)), /already paid/);
  assert.match(String(paymentProblem("contribute:0:1", 5_000_000n, "x", running)), /not in this circle/);
  assert.match(String(paymentProblem("contribute:0:1", 5_000_000n, me, { ...running, paying: true })), /payout is going out/);
  assert.equal(paymentProblem("buy_seat:0:1", 2_000_000n, me, running), null);
  assert.match(String(paymentProblem("buy_seat:0:1", 3_000_000n, me, running)), /price/);
  assert.match(String(paymentProblem("buy_seat:0:2", 2_000_000n, "b", running)), /isn't for sale/);
  assert.match(String(paymentProblem("buy_seat:0:1", 2_000_000n, "b", running)), /earlier than your own/);
  assert.match(String(paymentProblem("buy_seat:0:0", 2_000_000n, me, running)), /already been paid/);
  assert.equal(paymentProblem("back:0", 5_000_000n, "dao.near", running), null);
  assert.match(String(paymentProblem("back:0", 1_000_000n, "dao.near", running)), /at least one contribution/);
  assert.match(String(paymentProblem("back:0", 5_000_000n, "dao.near", { ...running, backing: "1", backers: [{ amount: "5000000" }] })), /already covered/);
  assert.equal(paymentProblem("refill:0", 5_000_000n, me, running), null);
  assert.match(String(paymentProblem("refill:0", 6_000_000n, me, running)), /more deposit/);
});

test("with Redis connected, limits are counted there, shared by every instance", async () => {
  process.env.KV_REST_API_URL = "https://redis.test";
  process.env.KV_REST_API_TOKEN = "t";
  const realFetch = globalThis.fetch;
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {any[]} */
  const seen = [];
  globalThis.fetch = /** @type {any} */ (
    async (/** @type {string} */ url, /** @type {any} */ init) => {
      const cmds = JSON.parse(init.body);
      seen.push({ url, auth: init.headers.authorization, cmds });
      const k = cmds[0][1];
      counts.set(k, (counts.get(k) ?? 0) + 1);
      return new Response(JSON.stringify([{ result: counts.get(k) }, { result: 1 }]));
    }
  );
  try {
    // A fresh copy of the module, which reads the settings when it loads.
    const { allowShared, sharedLimits } = await import(`../server/limit.js?redis=${Date.now()}`);
    assert.equal(sharedLimits(), true);
    // Another instance already counted 2 of the 3 allowed this minute.
    const minute = Math.floor(Date.now() / 60_000);
    counts.set(`limit:shared-test:${minute}`, 2);
    assert.equal(await allowShared("shared-test", 3), true);
    assert.equal(await allowShared("shared-test", 3), false, "the shared count is at the cap");
    assert.equal(seen[0].url, "https://redis.test/pipeline");
    assert.equal(seen[0].auth, "Bearer t");
    assert.deepEqual(seen[0].cmds[1], ["EXPIRE", `limit:shared-test:${minute}`, "120"]);
    // If Redis is down, requests go on with only this instance's limit.
    globalThis.fetch = /** @type {any} */ (async () => { throw new Error("down"); });
    assert.equal(await allowShared("shared-down", 3), true);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("requests NEAR Intents would reject don't use up the relayer's cap for everyone", async () => {
  // 70 joins from new, empty keys: each is turned away by the simulation, and
  // none of them counts towards the cap on what the relayer sends.
  const seed = new Uint8Array(32).fill(9);
  const relayerSigner = await signerFromSeed(seed);
  const cfg = { ...c, relayerKey: `ed25519:${toBase58(new Uint8Array([...seed, ...relayerSigner.publicKey]))}` };
  /** @type {any} */
  const open = { status: "Open", size: 3, contribution: "5000000", round: 0, paying: false, listings: [null, null, null], invite_only: false, members: [{ account_id: "o", deposit: "5000000", paid_this_round: false }] };
  const real = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ init) => {
    const body = JSON.parse(init.body);
    if (body.method === "query" && body.params.method_name === "get_circle") {
      return new Response(JSON.stringify({ result: { result: [...new TextEncoder().encode(JSON.stringify(open))] } }));
    }
    if (body.method === "query" && body.params.method_name === "simulate_intents") {
      return new Response(JSON.stringify({ result: { error: "wasm execution failed: insufficient balance" } }));
    }
    sent++;
    return new Response(JSON.stringify({ error: { name: "HANDLER_ERROR", cause: { name: "UNEXPECTED" } } }));
  });
  try {
    for (let i = 0; i < 70; i++) {
      const empty = await signerFromSeed(new Uint8Array(32).fill(100 + i));
      await assert.rejects(relay({ signed: [await signIntents(empty, a.join(0, 5_000_000n, null))] }, cfg), /NEAR Intents would reject/);
    }
    assert.equal(sent, 0, "nothing was sent");
  } finally {
    globalThis.fetch = real;
  }
});

test("the relayer refuses auth calls the contract would refuse, before paying gas", () => {
  const me = "a".repeat(64);
  const now = Date.now();
  /** @type {any} */
  const open = { status: "Open", organizer: "o", fill_by: String(BigInt(now + 86_400_000) * 1_000_000n), round: 0, listings: [null, null], members: [{ account_id: "o" }, { account_id: me }] };
  /** @type {any} */
  const running = { ...open, status: "Active", round: 1, listings: [null, "5", null], members: [{ account_id: "o" }, { account_id: me }, { account_id: "b" }] };
  assert.equal(authProblem("leave:0", me, open, now), null);
  assert.match(String(authProblem("leave:0", "x", open, now)), /not in this circle/);
  assert.match(String(authProblem("leave:0", me, running, now)), /already started/);
  assert.equal(authProblem("cancel:0", "o", open, now), null);
  assert.match(String(authProblem("cancel:0", me, open, now)), /Only the organizer/);
  assert.equal(authProblem("cancel:0", me, open, now + 2 * 86_400_000), null, "anyone, past fill_by");
  assert.match(String(authProblem("list_seat:0:1:5", me, open, now)), /while the circle is running/);
  assert.equal(authProblem("list_seat:0:1:5", me, running, now), null);
  assert.match(String(authProblem("list_seat:0:2:5", me, running, now)), /owner/);
  assert.match(String(authProblem("list_seat:0:0:5", "o", running, now)), /already been paid/);
  assert.match(String(authProblem("list_seat:0:1:0", me, running, now)), /more than zero/);
  assert.equal(authProblem("unlist_seat:0:1", me, running, now), null);
  assert.match(String(authProblem("unlist_seat:0:2", "b", running, now)), /isn't for sale/);
  assert.match(String(authProblem("list_seat:9:1:5", me, null, now)), /no such circle/);
});

test("the keeper reads every circle, even past a gap left by a closed one", async () => {
  const now = 2_000_000_000_000;
  /** @param {number} id */
  const circle = (id) => ({ id, status: "Finished", paying: false, fill_by: "0", members: [], backers: [], round_deadline: null });
  /** @type {number[]} */
  const froms = [];
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ init) => {
    const { params } = JSON.parse(init.body);
    const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString());
    let out;
    if (params.method_name === "get_config") out = { circle_count: 150 };
    else {
      froms.push(args.from_index);
      out = [];
      for (let id = args.from_index; id < Math.min(150, args.from_index + args.limit); id++) if (id !== 5) out.push(circle(id));
    }
    return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(out))] } }));
  });
  try {
    await keep({}, { ...c, relayerKey: "x" }, now);
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(froms, [0, 100], "circle 5 is closed, and circles 100 to 149 are still read");
});
