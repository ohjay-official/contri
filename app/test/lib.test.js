// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBase58, fromBase64, fromHex, toBase58, toHex, uintLE, utf8 } from "../public/js/lib/bytes.js";
import { actions, dueFor, formatAmount, parseAmount } from "../public/js/lib/contri.js";
import { nep413Hash, signIntents, transfer, versionedNonce } from "../public/js/lib/intents.js";
import { decryptName, encryptName, inviteLink, inviteSigner, joinMessage, parseInvite, signJoin } from "../public/js/lib/invite.js";
import { circleSigner, signerFromSecretKey, signerFromSeed, verify } from "../public/js/lib/keys.js";
import { encodeTransaction, events } from "../public/js/lib/near.js";

// Reference values from Python's `cryptography` (independent ed25519).
const SEED42 = new Uint8Array(32).fill(42);
const PUB42 = "197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61";
const SIG42 = "05e6f1e7cf8a2f9658d732b83e03af7dad7fa23623490099fd526e40390c27c7424613e752ac8d2991286e26835ec8a3db71336e81b1f47cbddcaae0e45fed0c";

test("base58 matches known values and round-trips", () => {
  assert.equal(toBase58(new Uint8Array(32)), "11111111111111111111111111111111");
  assert.equal(toBase58(utf8("hello world")), "StV1DL6CwTryKyV");
  assert.equal(toBase58(Uint8Array.of(0, 0, 1)), "112");
  for (const b of [Uint8Array.of(0), Uint8Array.of(0, 255, 3), fromHex(PUB42)]) assert.deepEqual(fromBase58(toBase58(b)), b);
  assert.throws(() => fromBase58("0OIl"));
});

test("little-endian integers", () => {
  assert.equal(toHex(uintLE(2 ** 31 + 413, 4)), "9d010080");
  assert.equal(toHex(uintLE(1n, 16)), "01" + "00".repeat(15));
  assert.throws(() => uintLE(256, 1));
});

test("ed25519 keys from a seed match an independent implementation", async () => {
  const s = await signerFromSeed(SEED42);
  assert.equal(s.accountId, PUB42);
  assert.equal(s.publicKeyStr, `ed25519:${toBase58(fromHex(PUB42))}`);
  assert.equal(toHex(await s.sign(utf8("contri"))), SIG42);
  assert.ok(await verify(s.publicKey, utf8("contri"), fromHex(SIG42)));
  assert.ok(!(await verify(s.publicKey, utf8("contri!"), fromHex(SIG42))));
});

test("a wallet's exported secret key gives the same signer", async () => {
  const s = await signerFromSeed(SEED42);
  const exported = `ed25519:${toBase58(new Uint8Array([...SEED42, ...s.publicKey]))}`;
  const r = await signerFromSecretKey(exported, "relayer.near");
  assert.equal(r.accountId, "relayer.near");
  assert.equal(toHex(r.publicKey), PUB42);
  const wrong = `ed25519:${toBase58(new Uint8Array([...SEED42, ...new Uint8Array(32)]))}`;
  await assert.rejects(signerFromSecretKey(wrong, "x.near"));
});

test("each circle gets its own unrelated account from one secret", async () => {
  const secret = new Uint8Array(32).fill(7);
  const a = await circleSigner(secret, "contri.near", 0);
  const b = await circleSigner(secret, "contri.near", 1);
  const again = await circleSigner(secret, "contri.near", 0);
  const other = await circleSigner(secret, "contri2.near", 0);
  assert.equal(a.accountId, again.accountId);
  assert.notEqual(a.accountId, b.accountId);
  assert.notEqual(a.accountId, other.accountId);
  assert.match(a.accountId, /^[0-9a-f]{64}$/);
});

test("NEP-413 signed intents verify against the payload", async () => {
  const s = await signerFromSeed(SEED42);
  const intents = [transfer("contri.near", "nep141:usdt.tether-token.near", 5_000_000n, { msg: "join:0" })];
  const signed = await signIntents(s, intents, { now: Date.parse("2026-11-05T00:00:00Z") });
  const msg = JSON.parse(signed.payload.message);
  assert.equal(msg.signer_id, PUB42);
  assert.equal(msg.deadline, "2026-11-05T00:10:00Z");
  assert.deepEqual(msg.intents, [{ intent: "transfer", receiver_id: "contri.near", tokens: { "nep141:usdt.tether-token.near": "5000000" }, msg: "join:0" }]);
  const nonce = fromBase64(signed.payload.nonce);
  assert.equal(nonce.length, 32);
  assert.equal(nonce[0], 0);
  const hash = await nep413Hash(signed.payload.message, nonce, "intents.near");
  assert.ok(await verify(s.publicKey, hash, fromBase58(signed.signature.slice(8))));
});

test("contract messages", () => {
  const a = actions("contri.near", "nep141:usdt.tether-token.near");
  const create = a.create({ contribution: 5_000_000n, size: 5, periodSecs: 86400, random: true, inviteKeyHex: "ab".repeat(32), name: "v1.abc" });
  assert.equal(create[0].msg, `create:5000000:5:86400:random:${"ab".repeat(32)}:v1.abc`);
  assert.equal(a.join(3, 5_000_000n, null)[0].msg, "join:3");
  assert.equal(a.join(3, 5_000_000n, "cd".repeat(64))[0].msg, `join:3:${"cd".repeat(64)}`);
  assert.equal(a.contribute(3, 2, "5000000")[0].min_gas, "100000000000000");
  assert.deepEqual(a.leave(3), [{ intent: "auth_call", contract_id: "contri.near", msg: "leave:3" }]);
  assert.equal(a.listSeat(1, 2, 1_000_000n)[0].msg, "list_seat:1:2:1000000");
  assert.equal(a.claimCredit()[0].msg, "claim_credit");
});

test("amounts", () => {
  assert.equal(parseAmount("5"), 5_000_000n);
  assert.equal(parseAmount("2.5"), 2_500_000n);
  assert.equal(parseAmount(" 0.000001 "), 1n);
  assert.throws(() => parseAmount("1.0000001"));
  assert.throws(() => parseAmount("-1"));
  assert.equal(formatAmount(5_000_000n), "5.00");
  assert.equal(formatAmount("2500000"), "2.50");
  assert.equal(formatAmount(1_234_567_890_000n), "1,234,567.89");
  assert.equal(formatAmount(1n), "0.000001");
});

test("invite links carry a secret that opens the name and signs joins", async () => {
  const secret = new Uint8Array(32).fill(9);
  const link = inviteLink("https://contri.app", 12, secret);
  assert.match(link, /^https:\/\/contri\.app\/join#12\.[A-Za-z0-9_-]{43}$/);
  const parsed = parseInvite(new URL(link).hash);
  assert.ok(parsed);
  assert.equal(parsed.circle, 12);
  assert.deepEqual(parsed.secret, secret);
  assert.equal(parseInvite("#12.short"), null);

  const stored = await encryptName(secret, "Lagos Market Ajo");
  assert.ok(stored.startsWith("v1.") && stored.length < 256);
  assert.equal(await decryptName(secret, stored), "Lagos Market Ajo");
  assert.equal(await decryptName(new Uint8Array(32).fill(1), stored), null);
  assert.equal(await decryptName(secret, "plain name"), null);
  await assert.rejects(encryptName(secret, "x".repeat(101)));

  const member = "a".repeat(64);
  const sig = await signJoin(secret, "contri.near", 12, member, 5_000_000n);
  const key = await inviteSigner(secret);
  assert.ok(await verify(key.publicKey, utf8(joinMessage("contri.near", 12, member, 5_000_000n)), fromHex(sig)));
  assert.equal(joinMessage("contri.near", 12, member, 5n), `contri-join:contri.near:12:${member}:5`);
});

test("what a member has to do", () => {
  const base = {
    id: 0, name: "", organizer: "o", contribution: "5", size: 2, period_secs: 60, listings: [], invite_only: false, random_order: false,
    fill_by: "0", backing: "0", backers: [], created_at: "0", started_at: "0", round: 0, pot: "0", paying: false, payouts: [],
  };
  const m = (/** @type {string} */ account_id, paid = false) => ({ account_id, deposit: "5", paid_this_round: paid, defaulted: false, missed: 0 });
  /** @type {any} */
  const open = { ...base, status: "Open", members: [m("a")], round_deadline: null };
  assert.equal(dueFor(open, "a"), "wait");
  assert.equal(dueFor(open, "b"), "join");
  /** @type {any} */
  const active = { ...base, status: "Active", members: [m("a", true), m("b")], round_deadline: "120000000000" };
  assert.equal(dueFor(active, "a", 0), "paid");
  assert.equal(dueFor(active, "b", 0), "pay");
  assert.equal(dueFor(active, "b", 200_000), "wait");
  assert.equal(dueFor(active, "c", 0), "none");
});

test("transactions encode as borsh", () => {
  const bytes = encodeTransaction({
    signerId: "a.near",
    publicKey: new Uint8Array(32).fill(1),
    nonce: 7n,
    receiverId: "b.near",
    blockHash: new Uint8Array(32).fill(2),
    actions: [{ functionCall: { method: "m", args: { x: 1 }, gas: 30_000_000_000_000n, deposit: 1n } }],
  });
  const hex = toHex(bytes);
  const expected = [
    "06000000" + toHex(utf8("a.near")),
    "00" + "01".repeat(32),
    "0700000000000000",
    "06000000" + toHex(utf8("b.near")),
    "02".repeat(32),
    "01000000",
    "02" + "01000000" + toHex(utf8("m")) + "07000000" + toHex(utf8('{"x":1}')) + toHex(uintLE(30_000_000_000_000n, 8)) + toHex(uintLE(1n, 16)),
  ].join("");
  assert.equal(hex, expected);
});

test("events are read from logs", () => {
  const logs = ["refund: wrong amount", 'EVENT_JSON:{"standard":"contri","version":"1.0.0","event":"circle_created","data":[{"circle":4}]}'];
  assert.deepEqual(events(logs, "contri")[0].data, [{ circle: 4 }]);
  assert.equal(events(logs, "nep171").length, 0);
});

test("versioned nonces carry the salt and deadline NEAR Intents checks", async () => {
  const n = versionedNonce("0a0b0c0d", Date.parse("2026-11-05T00:10:00Z"));
  assert.equal(n.length, 32);
  assert.equal(toHex(n.slice(0, 5)), "5628f6c600");
  assert.equal(toHex(n.slice(5, 9)), "0a0b0c0d");
  assert.equal(toHex(n.slice(9, 17)), toHex(uintLE(BigInt(Date.parse("2026-11-05T00:10:00Z")) * 1_000_000n, 8)));
  const s = await signerFromSeed(SEED42);
  const signed = await signIntents(s, [], { now: Date.parse("2026-11-05T00:00:00.400Z"), salt: "0a0b0c0d" });
  const nonce = fromBase64(signed.payload.nonce);
  assert.equal(toHex(nonce.slice(0, 4)), "5628f6c6");
  // The nonce's deadline is the intent's deadline, to the second.
  assert.equal(JSON.parse(signed.payload.message).deadline, "2026-11-05T00:10:00Z");
  assert.equal(toHex(nonce.slice(9, 17)), toHex(uintLE(BigInt(Date.parse("2026-11-05T00:10:00Z")) * 1_000_000n, 8)));
});
