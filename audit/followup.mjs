// Read-only follow-up for the Contri on-chain audit (a5). No keys, no transactions.
// Run: node followup.mjs > followup.json   (Node 22, plain fetch)
// Confirms:
//  1. Who holds NEAR Intents admin roles (DAO, UnrestrictedWithdrawer, UnrestrictedAccountManager, ...)
//     and whether intents.near was built with the "far" feature (force_add_public_keys).
//  2. Whether intents.near has circles.contring.near locked (is_account_locked).
//  3. Contri's storage reservation counters ("R" reserved bytes, "F"/"G" first reserved/slotted circle).
//  4. The key GzzRpgJ added, and which code hash circles.contring.near ran at each README transaction.
const RPC = ["https://archival-rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.near.org"];
const C = "circles.contring.near", R = "contring.near", I = "intents.near";
async function rpc(method, params) {
  let last;
  for (const url of RPC) {
    try {
      const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20000) })).json();
      if (j.error) { last = j.error; continue; }
      return j.result;
    } catch (e) { last = String(e); }
  }
  return { error: last };
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
async function view(account_id, method_name, args = {}, block) {
  const r = await rpc("query", { request_type: "call_function", ...(block ? { block_id: block } : { finality: "final" }), account_id, method_name, args_base64: b64(args) });
  if (r?.error) return { error: JSON.stringify(r.error).slice(0, 300) };
  try { return JSON.parse(Buffer.from(r.result).toString()); } catch { return { raw: Buffer.from(r.result ?? []).toString().slice(0, 2000) }; }
}
const out = { checkedAt: new Date().toISOString(), intents: {}, contri_state: {}, readme_code: [] };

// 1-2. NEAR Intents roles and account lock
out.intents.super_admins = await view(I, "acl_get_super_admins", { skip: 0, limit: 50 });
out.intents.role_variants = await view(I, "acl_role_variants");
const roles = Array.isArray(out.intents.role_variants) ? out.intents.role_variants : ["DAO", "FeesManager", "RelayerKeysManager", "UnrestrictedWithdrawer", "PauseManager", "Upgrader", "UnpauseManager", "UnrestrictedAccountLocker", "UnrestrictedAccountUnlocker", "SaltManager", "GarbageCollector", "UnrestrictedAccountManager"];
out.intents.grantees = {};
for (const role of roles) out.intents.grantees[role] = await view(I, "acl_get_grantees", { role, skip: 0, limit: 50 });
out.intents.source_metadata = await view(I, "contract_source_metadata");
out.intents.is_paused = await view(I, "pa_all_paused");
for (const id of [C, R]) {
  out.intents[id] = {
    is_account_locked: await view(I, "is_account_locked", { account_id: id }),
    public_keys_of: await view(I, "public_keys_of", { account_id: id }),
    auth_by_predecessor: await view(I, "is_auth_by_predecessor_id_enabled", { account_id: id }),
  };
}
// "far" feature: an ABI listing force_add_public_keys means intents.near can add keys to any account.
const abi = await rpc("query", { request_type: "call_function", finality: "final", account_id: I, method_name: "__contract_abi", args_base64: "" });
out.intents.abi_available = !abi?.error;

// 3. Contri storage counters (borsh u64, little endian)
for (const [k, prefix] of [["R_reserved_bytes", "R"], ["F_first_reserved_circle", "F"], ["G_first_slotted_circle", "G"]]) {
  const s = await rpc("query", { request_type: "view_state", finality: "final", account_id: C, prefix_base64: Buffer.from(prefix).toString("base64") });
  const v = s?.values?.find((x) => Buffer.from(x.key, "base64").toString() === prefix);
  out.contri_state[k] = v ? Buffer.from(v.value, "base64").readBigUInt64LE().toString() : s?.error ? { error: s.error } : null;
}
const all = await rpc("query", { request_type: "view_state", finality: "final", account_id: C, prefix_base64: "" });
out.contri_state.keys = all?.values?.map((x) => ({ key_prefix: Buffer.from(x.key, "base64").subarray(0, 1).toString(), key_len: Buffer.from(x.key, "base64").length, value_len: Buffer.from(x.value, "base64").length })) ?? all;

// 4. The deploy tx's AddKey, and the code hash in force at each README transaction
const hashes = ["GzzRpgJXzz3hoz3jMUioYpdpu8Q8Ag9fPfCzgP9usWHp", "BwMEkbXbqnfnmu4N8NssHbiv2FXbRFQGtKWhQS2Y44jt", "Emi3RfFtsJo8sZaJDLwdKAHg57xNASBA6X99Zt64pfR3", "CANkBfZx5LsHoktSJr9MvMN9R3gSjjY5C1VEN9VGbXHe", "4r349ov6rHvWg43G5dY1ZLiGJ5n6Zn7Xn1MeZ7KDAuTV", "E38hi5ZqWPKkWcLY8rEVbjnp3aFGjjoWRjZY3asFbVsT", "Gtiv9gp1J3hn5NU729dL2d5DK9xURnP98YfrurbbfLCy", "5kN1RW3fT86pbqQJQQLtCBAd1U6u9p67ir9pJN366UdV"];
for (const h of hashes) {
  const t = await rpc("EXPERIMENTAL_tx_status", { tx_hash: h, sender_account_id: R, wait_until: "NONE" });
  if (!t?.transaction) { out.readme_code.push({ hash: h, error: t?.error ?? "not found" }); continue; }
  const addKey = t.transaction.actions.filter((a) => a.AddKey).map((a) => a.AddKey);
  const contriReceipt = t.receipts_outcome.find((r) => r.outcome.executor_id === C);
  const block = contriReceipt?.block_hash ?? t.transaction_outcome.block_hash;
  const acct = await rpc("query", { request_type: "view_account", block_id: block, account_id: C });
  const blk = await rpc("block", { block_id: block });
  out.readme_code.push({ hash: h, add_key: addKey.length ? addKey : undefined, contri_block: block, block_time: blk?.header ? new Date(Number(BigInt(blk.header.timestamp) / 1000000n)).toISOString() : null, code_hash_then: acct?.code_hash ?? acct });
}
console.log(JSON.stringify(out, null, 1));
