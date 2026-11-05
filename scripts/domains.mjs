// Checks whether candidate domains for Contri are registered (RDAP), and,
// with VERCEL_TOKEN, asks Vercel too. Output: domains-out/domains.md

import { mkdir, writeFile } from "node:fs/promises";

const NAMES = [
  "contri.xyz", "contri.app", "contri.money", "contri.cash", "contri.africa", "contri.co", "contri.fund",
  "contri.finance", "contri.one", "contri.so", "contri.site", "contri.online", "contri.club", "contri.ng",
  "usecontri.com", "getcontri.com", "joincontri.com", "contriajo.com", "contri-ajo.com", "mycontri.app",
  "contriapp.xyz", "contri.com", "contri.io", "contri.org", "ajocircle.xyz", "contri.com.ng",
];
const token = process.env.VERCEL_TOKEN || "";

const UA = { "User-Agent": "contri-domain-check/1.0 (github.com/ohjay-official/contri)", Accept: "application/rdap+json" };
let bootstrap = null;
async function rdapBase(tld) {
  bootstrap ??= await fetch("https://data.iana.org/rdap/dns.json", { headers: UA }).then((r) => r.json());
  for (const [tlds, urls] of bootstrap.services) if (tlds.includes(tld)) return urls[0];
  return null;
}

async function rdap(name) {
  try {
    const base = await rdapBase(name.split(".").pop());
    if (!base) return "no RDAP for this ending";
    const res = await fetch(`${base.replace(/\/$/, "")}/domain/${name}`, { headers: UA });
    if (res.status === 404) return "not registered";
    if (res.ok) {
      const j = await res.json();
      const exp = (j.events || []).find((e) => e.eventAction === "expiration")?.eventDate?.slice(0, 10);
      return `registered${exp ? ` (expires ${exp})` : ""}`;
    }
    return `unknown (${res.status})`;
  } catch (e) {
    return `unknown (${String(e).slice(0, 40)})`;
  }
}

let team = "";
async function vercel(name) {
  if (!token) return "";
  const q = (path) => fetch(`https://api.vercel.com${path}${team ? `${path.includes("?") ? "&" : "?"}teamId=${team}` : ""}`, { headers: { Authorization: `Bearer ${token}` } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })).catch((e) => ({ status: 0, body: { error: String(e) } }));
  const a = await q(`/v1/registrar/domains/${name}/availability`);
  if (a.status !== 200) return `? (${a.status} ${JSON.stringify(a.body).slice(0, 80)})`;
  if (!a.body.available) return "taken";
  const p = await q(`/v1/registrar/domains/${name}/price`);
  return `available: ${JSON.stringify(p.body).slice(0, 120)}`;
}

if (token) {
  const t = await fetch("https://api.vercel.com/v2/teams", { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => ({}));
  team = t.teams?.[0]?.id ?? "";
}
const lines = ["# Domain check", "", `Checked ${new Date().toISOString()}`, "", "| domain | RDAP | Vercel |", "| --- | --- | --- |"];
for (const n of NAMES) lines.push(`| ${n} | ${await rdap(n)} | ${await vercel(n)} |`);
await mkdir("domains-out", { recursive: true });
await writeFile("domains-out/domains.md", lines.join("\n") + "\n");
console.log(lines.join("\n"));
