// Runs the app's real discover() with a mocked /api/rpc. Slots 0 and 1 are in use,
// slots 2-4 were emptied (cancelled circle closed by the keeper, deposit cashed out),
// slot 5 holds a running circle and 40 USDT. Fresh device: nothing in localStorage.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const W = await import(process.argv[2] + "/app/public/js/app/wallet.js");
const { circleSigner } = await import(process.argv[2] + "/app/public/js/lib/keys.js");
const secret = new Uint8Array(32).fill(7);
const contract = "circles.contring.near";
const acct = [];
for (let i = 0; i < 10; i++) acct.push((await circleSigner(secret, contract, i)).accountId);
const state = { [acct[0]]: { circles: [0], bal: "0" }, [acct[1]]: { circles: [1], bal: "0" }, [acct[5]]: { circles: [3], bal: "40000000" } };
globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  if (url === "/api/config") return json({ contractId: contract, tokenId: "nep141:usdt.tether-token.near", intentsId: "intents.near" });
  if (url === "/api/rpc") return json(body.calls.map((c) => ({ ok: c.method === "get_circles_for" ? (state[c.args.account_id]?.circles ?? []) : (state[c.args.account_id]?.bal ?? "0") })));
  throw new Error("unexpected " + url);
};
await W.useRestoredSecret(secret);
const slots = await W.discover();
console.log("found slots:", slots.map((s) => s.index), "| slot 5 (running circle, $40) found:", slots.some((s) => s.index === 5));
