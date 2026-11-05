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

async function rdap(name) {
  try {
    const res = await fetch(`https://rdap.org/domain/${name}`, { redirect: "follow", headers: { Accept: "application/rdap+json" } });
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
  const q = (path) => fetch(`https://api.vercel.com${path}${team ? `${path.includes("?") ? "&" : "?"}teamId=${team}` : ""}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => ({}));
  const status = await q(`/v4/domains/status?name=${name}`);
  const price = status.available ? await q(`/v4/domains/price?name=${name}`) : {};
  return status.available === undefined ? "?" : status.available ? `available, $${price.price ?? "?"} / ${price.period ?? "?"}y at Vercel` : "taken";
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
