// Read-only snapshot of Contri on NEAR mainnet, for auditors. Sends no
// transaction and reads no secret. Prints JSON.
const RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.near.org"];
const ARCHIVAL = ["https://archival-rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.near.org"];
const CONTRACT = "circles.contring.near", RELAYER = "contring.near", INTENTS = "intents.near", TOKEN = "nep141:usdt.tether-token.near";

async function rpc(method, params, urls = RPCS) {
  let last;
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20000) });
      const j = await res.json();
      if (j.error) { last = j.error; if (/UNKNOWN|does not exist|NOT_FOUND/i.test(JSON.stringify(j.error))) return { error: j.error }; continue; }
      return j.result;
    } catch (e) { last = String(e); }
  }
  return { error: last };
}
const view = async (account_id, method_name, args = {}) => {
  const r = await rpc("query", { request_type: "call_function", finality: "final", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  if (r?.error) return { error: r.error };
  try { return JSON.parse(Buffer.from(r.result).toString()); } catch { return { raw: Buffer.from(r.result ?? []).toString().slice(0, 4000) }; }
};
const account = (id) => rpc("query", { request_type: "view_account", finality: "final", account_id: id });
const keys = (id) => rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: id });

const out = { checkedAt: new Date().toISOString() };
for (const id of [CONTRACT, RELAYER]) {
  out[id] = {
    account: await account(id),
    access_keys: await keys(id),
    intents_public_keys_of: await view(INTENTS, "public_keys_of", { account_id: id }),
    intents_auth_by_predecessor: await view(INTENTS, "is_auth_by_predecessor_id_enabled", { account_id: id }),
    intents_usdt_balance: await view(INTENTS, "mt_balance_of", { account_id: id, token_id: TOKEN }),
  };
}
const a = out[CONTRACT].account;
if (a?.amount) out[CONTRACT].storage = { near: Number(BigInt(a.amount) / 10n ** 20n) / 10000, storage_usage: a.storage_usage, bytes_covered: Number(BigInt(a.amount) / 10n ** 19n), headroom_bytes: Number(BigInt(a.amount) / 10n ** 19n) - a.storage_usage };
out.get_config = await view(CONTRACT, "get_config");
out.contract_source_metadata = await view(CONTRACT, "contract_source_metadata");
out.nft_total_supply = await view(CONTRACT, "nft_total_supply");
out.circles = await view(CONTRACT, "get_circles", { from_index: 0, limit: 100 });
if (Array.isArray(out.circles)) {
  out.circle_deadlines = {};
  for (const c of out.circles) out.circle_deadlines[c.id] = await view(CONTRACT, "get_round_deadline", { circle_id: c.id });
  out.members = [...new Set(out.circles.flatMap((c) => c.members.map((m) => m.account_id)))];
  out.credits = {};
  for (const m of out.members) out.credits[m] = await view(CONTRACT, "get_credit", { account_id: m });
}
// Every transaction the README links to, as the chain recorded it.
const readme = (await import("node:fs")).readFileSync(new URL("../README.md", import.meta.url), "utf8");
const hashes = [...new Set([...readme.matchAll(/nearblocks\.io\/txns\/([1-9A-HJ-NP-Za-km-z]{43,44})/g)].map((m) => m[1]))];
out.readme_txs = [];
for (const h of hashes) {
  let t;
  for (const sender of [RELAYER, CONTRACT, INTENTS]) {
    t = await rpc("EXPERIMENTAL_tx_status", { tx_hash: h, sender_account_id: sender, wait_until: "NONE" }, ARCHIVAL);
    if (t && !t.error && t.transaction) break;
  }
  if (!t || t.error || !t.transaction) { out.readme_txs.push({ hash: h, error: t?.error ?? "not found" }); continue; }
  const logs = t.receipts_outcome.flatMap((r) => r.outcome.logs.map((l) => `${r.outcome.executor_id}: ${l}`));
  const failures = t.receipts_outcome.filter((r) => r.outcome.status?.Failure).map((r) => `${r.outcome.executor_id}: ${JSON.stringify(r.outcome.status.Failure).slice(0, 300)}`);
  out.readme_txs.push({
    hash: h, signer: t.transaction.signer_id, receiver: t.transaction.receiver_id,
    actions: t.transaction.actions.map((x) => (typeof x === "string" ? x : Object.keys(x)[0] + (x.FunctionCall ? `:${x.FunctionCall.method_name}` : ""))),
    status: Object.keys(t.status ?? {})[0], failures, contri_and_token_logs: logs.filter((l) => /EVENT_JSON|contri|mt_transfer|nep245/.test(l)).map((l) => l.slice(0, 700)),
  });
}
console.log(JSON.stringify(out, null, 1));
