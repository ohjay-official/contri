// @ts-check
// The private balance: the member's private account, the check every move out
// of it passes before the phone signs, and the server's handling of 1Click.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fromBase64, toBase58, toBase64 } from "../public/js/lib/bytes.js";
import { nep413Hash, signIntents, transfer } from "../public/js/lib/intents.js";
import { circleSigner, vaultSigner } from "../public/js/lib/keys.js";
import { checkPrivateMove } from "../public/js/lib/private.js";
import { spare } from "../public/js/app/screens/cashout.js";
import { privateBalance, privateHome, privateMove, privateSignIn, privateSubmit, privateTopUp } from "../server/confidential.js";
import { formatDown } from "../server/oneclick.js";

const TOKEN = "nep141:usdt.tether-token.near";
const IMT = `imt:51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe:${TOKEN}`;
const DEPOSIT = "d21a25d61d8741f8dcd9c7ec172a93e413df8976c64869e806dd71742e453fa2";
/** @type {import("../server/config.js").Config} */
const c = {
  network: "mainnet", rpcUrl: "http://127.0.0.1:1", contractId: "circles.contring.near", intentsId: "intents.near", tokenId: TOKEN,
  relayerId: "contring.near", relayerKey: "", oneClickUrl: "https://1click.test", oneClickKey: "partner-key", feeBps: 25, feeAccount: "contring.near",
};
const secret = new Uint8Array(32).fill(9);
const vault = await vaultSigner(secret, c.contractId);

/** What 1Click's generate-intent returned in the probe, for this vault. */
const generated = (over = {}, intent = {}) =>
  JSON.stringify({
    deadline: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    intents: [{ intent: "transfer", receiver_id: DEPOSIT, tokens: { [IMT]: "5000000" }, ...intent }],
    signer_id: vault.accountId,
    ...over,
  });

/** Signs a payload the way the app does. @param {string} message */
async function signed(message, signer = vault) {
  const payload = { message, nonce: toBase64(new Uint8Array(32).fill(7)), recipient: "intents.far" };
  const sig = await signer.sign(await nep413Hash(payload.message, fromBase64(payload.nonce), payload.recipient));
  return { standard: "nep413", payload, public_key: signer.publicKeyStr, signature: `ed25519:${toBase58(sig)}` };
}

/** Replaces fetch with 1Click answers, and records the requests. @param {(path: string, body: any) => any} answer */
function fake1Click(answer) {
  /** @type {{ path: string, body: any, headers: Record<string, string> }[]} */
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    const path = url.replace(c.oneClickUrl, "");
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, body, headers: init?.headers ?? {} });
    const r = answer(path, body);
    return new Response(JSON.stringify(r ?? {}), { status: r ? 201 : 500 });
  });
  return calls;
}
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

test("the private account is the member's own, separate from every circle account", async () => {
  assert.equal((await vaultSigner(secret, c.contractId)).accountId, vault.accountId);
  for (let i = 0; i < 5; i++) assert.notEqual((await circleSigner(secret, c.contractId, i)).accountId, vault.accountId);
  assert.notEqual((await vaultSigner(new Uint8Array(32).fill(8), c.contractId)).accountId, vault.accountId);
  assert.match(vault.accountId, /^[0-9a-f]{64}$/);
});

test("the phone signs a move only if it is exactly what the member asked", () => {
  const expect = { signer: vault.accountId, tokenId: TOKEN, depositAddress: DEPOSIT, amount: "5000000" };
  assert.deepEqual(checkPrivateMove(generated(), expect), { receiver: DEPOSIT, amount: "5000000" });
  assert.ok(checkPrivateMove(generated({}, { tokens: { [TOKEN]: "5000000" } }), expect), "an unwrapped token id is fine too");
  const refused = (/** @type {string} */ m, /** @type {RegExp} */ why) => assert.throws(() => checkPrivateMove(m, expect), why);
  refused(generated({ signer_id: "a".repeat(64) }), /isn't from your private account/);
  refused(generated({}, { receiver_id: "b".repeat(64) }), /isn't the quoted deposit address/);
  refused(generated({}, { receiver_id: "evil.near" }), /isn't a deposit address/);
  refused(generated({}, { tokens: { [IMT]: "5000001" } }), /isn't the one you asked for/);
  refused(generated({}, { tokens: { [`imt:x:nep141:wrap.near`]: "5000000" } }), /different token/);
  refused(generated({}, { tokens: { [IMT]: "5000000", [`imt:x:${TOKEN}`]: "1" } }), /more than one token/);
  refused(generated({}, { msg: "{}" }), /carries a call/);
  refused(generated({}, { intent: "token_diff" }), /expected a transfer/);
  refused(generated({ intents: [] }), /exactly one intent/);
  refused(generated({ deadline: new Date(Date.now() - 1000).toISOString() }), /deadline/);
  refused(generated({ deadline: new Date(Date.now() + 30 * 86_400_000).toISOString() }), /deadline/);
  refused("not json", /isn't JSON/);
});

test("sign-in passes an empty signed intent to 1Click and returns its session", async () => {
  const calls = fake1Click((path) => (path === "/v0/auth/authenticate" ? { accessToken: "a.b.c", expiresIn: 900 } : null));
  const empty = await signIntents(vault, [], { validForMs: 4 * 60_000, salt: "0a0b0c0d" });
  assert.deepEqual(await privateSignIn({ signed: empty }, c), { session: "a.b.c", expiresIn: 900 });
  assert.equal(calls[0].headers["X-API-Key"], "partner-key");
  assert.deepEqual(calls[0].body, { signedData: empty });

  await assert.rejects(privateSignIn({ signed: await signIntents(vault, [transfer(DEPOSIT, TOKEN, 1n)]) }, c), /signs no intents/);
  const forged = { ...empty, public_key: (await circleSigner(secret, c.contractId, 0)).publicKeyStr };
  await assert.rejects(privateSignIn({ signed: forged }, c), /signature doesn't match/);
  assert.equal(calls.length, 1, "nothing refused reaches 1Click");
});

test("the private balance counts USDT, wrapped or not, and nothing else", async () => {
  const calls = fake1Click(() => ({ balances: [
    { tokenId: IMT, available: "4000000", source: "private" },
    { tokenId: TOKEN, available: "1000000", source: "private" },
    { tokenId: "imt:x:nep141:wrap.near", available: "999999999", source: "private" },
  ] }));
  assert.deepEqual(await privateBalance({ session: "header.payload.signature-xyz" }, c), { amount: "5000000" });
  assert.equal(calls[0].headers.Authorization, "Bearer header.payload.signature-xyz");
  await assert.rejects(privateBalance({}, c), /sign in/);
});

test("adding privately asks 1Click for a deposit that lands on the private ledger", async () => {
  const calls = fake1Click(() => ({ quote: { depositAddress: "0x" + "ab".repeat(20), amountIn: "5025000000000000000", amountOut: "5021000", timeEstimate: 35, deadline: "2026-11-06T00:00:00Z" } }));
  const q = await privateTopUp({ network: "bsc", vault: vault.accountId, amount: "5000000" }, c);
  const body = calls[0].body;
  assert.equal(body.recipient, vault.accountId);
  assert.equal(body.recipientType, "CONFIDENTIAL_INTENTS");
  assert.equal(body.refundType, "CONFIDENTIAL_INTENTS");
  assert.equal(body.confidentiality, "basic");
  assert.equal(body.amount, "5040000000000000000", "asks 0.75% over (fees, and Contri's 0.25%), rounded up to the cent, in BSC's 18 decimals");
  assert.deepEqual(body.appFees, [{ recipient: "contring.near", fee: 25 }]);
  assert.equal(q.contriFee, "0.25%");
  assert.equal(q.contriFeeUsd, "0.02", "0.25% of 5.025 sent, rounded up to the cent");
  assert.equal(q.send, "5.03");
  assert.equal(q.receive, "5.02");
  await assert.rejects(privateTopUp({ network: "nope", vault: vault.accountId, amount: "5000000" }, c), /unsupported network/);
  await assert.rejects(privateTopUp({ network: "bsc", vault: "Not An Account", amount: "5000000" }, c), /invalid account/);
});

test("a move out of the private balance: quote, intent, the phone's signature, submit", async () => {
  const message = generated();
  const calls = fake1Click((path, body) => {
    if (path === "/v0/quote") return { quote: { depositAddress: DEPOSIT, amountOut: "5000000", timeEstimate: 10, withdrawFee: "0" } };
    if (path === "/v0/generate-intent") return { intent: { standard: "nep413", payload: { message, nonce: toBase64(new Uint8Array(32).fill(7)), recipient: "intents.far" } } };
    if (path === "/v0/submit-intent") return body.signedData ? { intentHash: "hash" } : null;
    return null;
  });
  const circle = (await circleSigner(secret, c.contractId, 0)).accountId;
  const q = /** @type {any} */ (await privateMove({ vault: vault.accountId, to: circle, amount: "5000000" }, c));
  assert.equal(calls[0].body.depositType, "CONFIDENTIAL_INTENTS");
  assert.equal(calls[0].body.recipient, circle);
  assert.equal(calls[0].body.recipientType, "INTENTS");
  assert.equal(calls[0].body.refundTo, vault.accountId);
  assert.deepEqual(calls[1].body, { type: "swap_transfer", standard: "nep413", signerId: vault.accountId, depositAddress: DEPOSIT });
  assert.equal(q.receive, "5.00");

  // The phone checks, signs, and the server passes it on.
  checkPrivateMove(q.intent.payload.message, { signer: vault.accountId, tokenId: TOKEN, depositAddress: q.depositAddress, amount: "5000000" });
  const s = await signed(q.intent.payload.message);
  assert.deepEqual(await privateSubmit({ signed: s }, c), { intentHash: "hash" });
  assert.deepEqual(calls[2].body, { type: "swap_transfer", signedData: s });

  // The server won't submit what isn't a plain move, or isn't signed by its signer.
  await assert.rejects(privateSubmit({ signed: await signed(generated({}, { msg: "x" })) }, c), /not submitted: the transfer carries a call/);
  await assert.rejects(privateSubmit({ signed: { ...s, signature: (await signed(generated({}, { tokens: { [IMT]: "1" } }))).signature } }, c), /signature doesn't match/);
  await assert.rejects(privateSubmit({ signed: await signed(message, await circleSigner(secret, c.contractId, 1)) }, c), /isn't the signer's/);
  assert.equal(calls.length, 3, "nothing refused reaches 1Click");

  // To another chain: the address must fit the network.
  await assert.rejects(privateMove({ vault: vault.accountId, network: "bsc", address: "T123", amount: "5000000" }, c), /isn't a BNB/);
  const dry = /** @type {any} */ (await privateMove({ vault: vault.accountId, network: "bsc", address: "0x" + "22".repeat(20), amount: "5000000", dry: true }, c));
  assert.equal(calls.at(-1)?.body.dry, true);
  assert.equal(dry.intent, undefined, "a dry run builds no intent");
});

test("a payout goes home to the private balance through a public deposit account", async () => {
  const calls = fake1Click(() => ({ quote: { depositAddress: DEPOSIT, amountOut: "5000000", timeEstimate: 10 } }));
  const circle = (await circleSigner(secret, c.contractId, 2)).accountId;
  const q = await privateHome({ from: circle, vault: vault.accountId, amount: "5000000" }, c);
  assert.equal(calls[0].body.depositType, "INTENTS");
  assert.equal(calls[0].body.recipientType, "CONFIDENTIAL_INTENTS");
  assert.equal(calls[0].body.refundTo, circle, "a failed move comes back to the circle account");
  assert.equal(q.depositAddress, DEPOSIT);
});

test("amounts that arrive round down to the cent", () => {
  assert.equal(formatDown(4_980_241_982_256_981_250n, 18), "4.98");
  assert.equal(formatDown(5_021_999n, 6), "5.02");
  assert.equal(formatDown(9n, 6), "0.00");
});

test("moving money out never takes what the member still owes this circle", () => {
  const me = "m";
  const base = { contribution: "1000000", size: 4, round: 1, status: "Active", members: [{ account_id: "x" }, { account_id: me, paid_this_round: false, defaulted: false, missed: 0 }] };
  const c1 = /** @type {any} */ ({ ...base, round_deadline: String(BigInt(Date.now() + 3_600_000) * 1_000_000n) });
  assert.equal(spare(5_000_000n, c1, me), 2_000_000n, "owes this round and two more");
  const paid = /** @type {any} */ ({ ...c1, members: [{ account_id: "x" }, { account_id: me, paid_this_round: true, defaulted: false, missed: 0 }] });
  assert.equal(spare(5_000_000n, paid, me), 3_000_000n);
  assert.equal(spare(1_000_000n, paid, me), 0n);
  assert.equal(spare(5_000_000n, /** @type {any} */ ({ ...paid, status: "Finished" }), me), 5_000_000n);
  assert.equal(spare(5_000_000n, null, me), 5_000_000n);
});

test("top-ups and cash-outs take the confidential route when Contri has a partner key", async () => {
  const { topUp, cashOut } = await import("../server/oneclick.js");
  const calls = fake1Click(() => ({ quote: { depositAddress: "0x" + "ab".repeat(20), amountIn: "3020000000000000000", minAmountIn: "2989800000000000000", amountOut: "3019389", timeEstimate: 35, deadline: "2026-11-06T00:00:00Z" } }));
  await topUp({ network: "bsc", account: vault.accountId, amount: "3000000" }, c);
  await cashOut({ network: "bsc", account: vault.accountId, amount: "3000000", address: "0x" + "22".repeat(20), dry: true }, c);
  assert.equal(calls[0].body.confidentiality, "basic");
  assert.equal(calls[1].body.confidentiality, "basic");
  await topUp({ network: "bsc", account: vault.accountId, amount: "3000000" }, { ...c, oneClickKey: "" });
  assert.equal(calls[2].body.confidentiality, undefined, "1Click refuses confidential quotes without a key");
});
