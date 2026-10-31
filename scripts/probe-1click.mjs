// Read-only probe of the NEAR Intents 1Click API.
// Every quote uses dry: true, so no deposit address is created and no money moves.
// Output: probe-out/results.json and probe-out/summary.md

import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://1click.chaindefuser.com";
const BRIDGE = "https://bridge.chaindefuser.com/rpc";
const KEY = process.env.ONECLICK_API_KEY || "";

// Placeholder addresses for dry quotes only. Nothing is ever sent to them.
const DUMMY_INTENTS_ACCOUNT = "0x1111111111111111111111111111111111111111";
const DUMMY_TRON = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const out = { ranAt: new Date().toISOString(), authenticated: Boolean(KEY), tokens: [], quotes: [], bridge: null, errors: [] };

function headers() {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (KEY) {
    h["X-API-Key"] = KEY;
    h.Authorization = `Bearer ${KEY}`;
  }
  return h;
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 2000); }
  return { status: res.status, body };
}

const deadline = () => new Date(Date.now() + 30 * 60 * 1000).toISOString();

async function quote(label, body) {
  try {
    const r = await getJson(`${BASE}/v0/quote`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    out.quotes.push({ label, request: body, status: r.status, response: r.body });
  } catch (e) {
    out.quotes.push({ label, request: body, error: String(e) });
  }
}

async function main() {
  // 1. Supported tokens
  const t = await getJson(`${BASE}/v0/tokens`, { headers: headers() });
  if (t.status !== 200 || !Array.isArray(t.body)) {
    out.errors.push({ step: "tokens", status: t.status, body: t.body });
  } else {
    const wanted = ["USDT", "USDC"];
    out.tokens = t.body
      .filter((x) => wanted.includes(String(x.symbol).toUpperCase()))
      .map((x) => ({ assetId: x.assetId, blockchain: x.blockchain, symbol: x.symbol, decimals: x.decimals, contractAddress: x.contractAddress, price: x.price }));
    out.chains = [...new Set(t.body.map((x) => x.blockchain))].sort();
  }

  const find = (chain, sym) => out.tokens.find((x) => x.blockchain === chain && String(x.symbol).toUpperCase() === sym);
  const tronUsdt = find("tron", "USDT");
  const nearUsdt = find("near", "USDT");
  const bscUsdt = find("bsc", "USDT");

  // 2. Top-up quotes: Tron USDT -> member's Intents balance, at several sizes
  if (tronUsdt) {
    for (const usd of [1, 2, 5, 20]) {
      for (const dest of [nearUsdt, tronUsdt].filter(Boolean)) {
        await quote(`topup ${usd} USDT tron -> ${dest.blockchain} USDT (INTENTS)`, {
          dry: true,
          swapType: "EXACT_INPUT",
          slippageTolerance: 100,
          originAsset: tronUsdt.assetId,
          depositType: "ORIGIN_CHAIN",
          destinationAsset: dest.assetId,
          amount: String(usd * 10 ** tronUsdt.decimals),
          refundTo: DUMMY_TRON,
          refundType: "ORIGIN_CHAIN",
          recipient: DUMMY_INTENTS_ACCOUNT,
          recipientType: "INTENTS",
          deadline: deadline(),
        });
      }
    }
  }

  // 3. Top-up from BNB Chain USDT (common exchange withdrawal network)
  if (bscUsdt && nearUsdt) {
    await quote("topup 2 USDT bsc -> near USDT (INTENTS)", {
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: bscUsdt.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: nearUsdt.assetId,
      amount: String(2 * 10 ** bscUsdt.decimals),
      refundTo: "0x1111111111111111111111111111111111111111",
      refundType: "ORIGIN_CHAIN",
      recipient: DUMMY_INTENTS_ACCOUNT,
      recipientType: "INTENTS",
      deadline: deadline(),
    });
  }

  // 4. Cash-out quotes: Intents balance -> Tron address, plain and confidential
  if (nearUsdt && tronUsdt) {
    for (const usd of [2, 10]) {
      for (const confidentiality of [undefined, "basic"]) {
        const body = {
          dry: true,
          swapType: "EXACT_INPUT",
          slippageTolerance: 100,
          originAsset: nearUsdt.assetId,
          depositType: "INTENTS",
          destinationAsset: tronUsdt.assetId,
          amount: String(usd * 10 ** nearUsdt.decimals),
          refundTo: DUMMY_INTENTS_ACCOUNT,
          refundType: "INTENTS",
          recipient: DUMMY_TRON,
          recipientType: "DESTINATION_CHAIN",
          deadline: deadline(),
        };
        if (confidentiality) body.confidentiality = confidentiality;
        await quote(`cashout ${usd} USDT near(INTENTS) -> tron${confidentiality ? " confidential:" + confidentiality : ""}`, body);
      }
    }
  }

  // 5. PoA bridge limits for Tron (best effort)
  try {
    const b = await getJson(BRIDGE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "supported_tokens", params: [{ chains: ["tron:mainnet"] }] }),
    });
    out.bridge = b;
  } catch (e) {
    out.errors.push({ step: "bridge", error: String(e) });
  }

  await mkdir("probe-out", { recursive: true });
  await writeFile("probe-out/results.json", JSON.stringify(out, null, 2));

  const lines = [`# 1Click probe`, ``, `Ran: ${out.ranAt}. Authenticated: ${out.authenticated}.`, ``];
  lines.push(`Chains: ${(out.chains || []).join(", ")}`, ``, `## Stablecoins`, ``, `| chain | symbol | assetId | decimals |`, `| --- | --- | --- | --- |`);
  for (const x of out.tokens) lines.push(`| ${x.blockchain} | ${x.symbol} | \`${x.assetId}\` | ${x.decimals} |`);
  lines.push(``, `## Quotes`, ``, `| label | status | amountIn | amountOut | minAmountIn | time (s) | error |`, `| --- | --- | --- | --- | --- | --- | --- |`);
  for (const q of out.quotes) {
    const r = q.response || {};
    const qq = r.quote || {};
    const err = q.error || (q.status !== 200 ? JSON.stringify(r).slice(0, 200) : "");
    lines.push(`| ${q.label} | ${q.status ?? "-"} | ${qq.amountInFormatted ?? ""} | ${qq.amountOutFormatted ?? ""} | ${qq.minAmountIn ?? ""} | ${qq.timeEstimate ?? ""} | ${err.replace(/\|/g, "/")} |`);
  }
  await writeFile("probe-out/summary.md", lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

main().catch(async (e) => {
  out.errors.push({ step: "main", error: String(e) });
  await mkdir("probe-out", { recursive: true });
  await writeFile("probe-out/results.json", JSON.stringify(out, null, 2));
  console.error(e);
});
