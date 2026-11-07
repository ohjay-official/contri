// Read-only: every transaction that touched one circle, with the contract's
// events in each, from the nearblocks indexer and NEAR RPC.
// Usage: node audit/circle-txs.mjs <circle id> [hours back]
const id = Number(process.argv[2]);
const hours = Number(process.argv[3] ?? 6);
const CONTRACT = "circles.contring.near";
const RPC = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.near.org"];
const since = Date.now() - hours * 3_600_000;

async function json(url, init) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, init).catch(() => null);
    if (r?.ok) return r.json();
    await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
  }
  throw new Error(`failed: ${url}`);
}
async function rpc(method, params) {
  for (const u of RPC) {
    const r = await json(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).catch(() => null);
    if (r?.result) return r.result;
  }
  return null;
}
const ms = (t) => Number(BigInt(String(t.block_timestamp ?? t.receipt_block?.block_timestamp ?? t.block?.block_timestamp ?? 0)) / 1_000_000n);

const seen = new Map();
for (const kind of ["receipts", "txns-only", "txns"]) {
  for (let page = 1; page <= 4; page++) {
    const d = await json(`https://api.nearblocks.io/v1/account/${CONTRACT}/${kind}?per_page=100&page=${page}&order=desc`).catch((e) => (console.error(String(e)), null));
    const rows = d?.txns ?? d?.receipts ?? [];
    if (!rows.length) break;
    for (const t of rows) {
      const hash = t.transaction_hash ?? t.originated_from_transaction_hash;
      const signer = t.signer_account_id ?? t.receipt_outcome?.executor_account_id ?? t.predecessor_account_id;
      if (hash && ms(t) >= since && !seen.has(hash)) seen.set(hash, { hash, signer, at: new Date(ms(t)).toISOString() });
    }
    if (ms(rows[rows.length - 1]) < since) break;
    await new Promise((s) => setTimeout(s, 1200));
  }
}
console.error(`${seen.size} transactions in the window`);

const out = [];
for (const t of [...seen.values()].sort((a, b) => a.at.localeCompare(b.at))) {
  let r = null;
  for (const sender of [t.signer, "contring.near", "intents.near"]) {
    if (!sender) continue;
    r = await rpc("EXPERIMENTAL_tx_status", { tx_hash: t.hash, sender_account_id: sender, wait_until: "NONE" });
    if (r) break;
  }
  if (!r) { console.error(`no status for ${t.hash}`); continue; }
  const events = [];
  for (const ro of r.receipts_outcome ?? []) {
    for (const log of ro.outcome.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(log.slice(11));
        for (const d of e.data ?? []) if (d.circle === id) events.push({ standard: e.standard, event: e.event, ...d });
      } catch {}
    }
  }
  const failed = (r.receipts_outcome ?? []).some((ro) => ro.outcome.status?.Failure);
  if (events.length) out.push({ hash: t.hash, at: t.at, signer: r.transaction.signer_id, receiver: r.transaction.receiver_id, method: r.transaction.actions?.[0]?.FunctionCall?.method_name ?? null, failed, events });
}
console.log(JSON.stringify(out, null, 1));
