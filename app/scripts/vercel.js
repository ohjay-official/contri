// @ts-check
// Sets up Contri's Vercel project through Vercel's REST API, for
// .github/workflows/web.yml. Needs VERCEL_TOKEN; never prints a secret.
//
//   node scripts/vercel.js setup    create the project if needed, link this
//                                   folder to it (.vercel/project.json), and
//                                   copy the server's settings from the
//                                   environment into its production env vars
//   node scripts/vercel.js domain   print the project's production domain
//   DOMAIN=x node scripts/vercel.js attach   add a custom domain, print its DNS records

import { mkdir, writeFile } from "node:fs/promises";

const API = "https://api.vercel.com";
const TOKEN = process.env.VERCEL_TOKEN ?? "";
const PROJECT = process.env.PROJECT ?? "contri";
const SETTINGS = ["CONTRI_ACCOUNT_ID", "RELAYER_ACCOUNT_ID", "RELAYER_KEY", "ONECLICK_API_KEY"];
const SECRET = new Set(["RELAYER_KEY", "ONECLICK_API_KEY"]);
if (!TOKEN) throw new Error("VERCEL_TOKEN is not set");

/** The team the token is scoped to ("<name>'s projects"); every API call names it. */
let team = "";

/** @param {string} path @param {RequestInit} [init] */
async function api(path, init = {}) {
  if (team) path += `${path.includes("?") ? "&" : "?"}teamId=${team}`;
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function project() {
  let r = await api(`/v9/projects/${PROJECT}`);
  if (r.status === 404) {
    r = await api("/v11/projects", { method: "POST", body: JSON.stringify({ name: PROJECT, framework: null }) });
    if (r.status >= 300) throw new Error(`couldn't create the project: ${r.status} ${r.body?.error?.message ?? ""}`);
    console.log(`created project ${PROJECT}`);
  } else if (r.status >= 300) {
    throw new Error(`couldn't read the project: ${r.status} ${r.body?.error?.message ?? ""}`);
  }
  return r.body;
}

const command = process.argv[2];
const teams = await api("/v2/teams");
const list = /** @type {any[]} */ (teams.body?.teams ?? []);
if (list.length >= 1) {
  team = (list.find((t) => t.slug === process.env.VERCEL_TEAM) ?? list[0]).id;
  console.error(`team: ${list.find((t) => t.id === team)?.name ?? team}`);
}
const p = await project();

if (command === "setup") {
  await mkdir(".vercel", { recursive: true });
  await writeFile(".vercel/project.json", JSON.stringify({ projectId: p.id, orgId: p.accountId }));
  console.log(`linked to ${PROJECT}`);
  for (const key of SETTINGS) {
    const value = process.env[key];
    if (!value) {
      console.log(`${key}: not set yet`);
      continue;
    }
    const r = await api(`/v10/projects/${p.id}/env?upsert=true`, {
      method: "POST",
      body: JSON.stringify({ key, value, type: SECRET.has(key) ? "sensitive" : "encrypted", target: ["production"] }),
    });
    console.log(`${key}: ${r.status < 300 ? "set" : `failed (${r.status} ${r.body?.error?.message ?? ""})`}`);
  }
} else if (command === "domain") {
  const aliases = /** @type {string[]} */ ([...(p.targets?.production?.alias ?? []), ...(p.alias ?? []).map((/** @type {any} */ a) => a.domain)]);
  const custom = aliases.find((a) => !a.endsWith(".vercel.app"));
  const vercel = aliases.filter((a) => a.endsWith(".vercel.app")).sort((a, b) => a.length - b.length)[0];
  console.log(`https://${custom ?? vercel ?? `${PROJECT}.vercel.app`}`);
} else if (command === "attach") {
  // Adds DOMAIN (and www.DOMAIN, redirecting to it) to the project, then prints
  // the DNS records the registrar needs. Safe to run again.
  const domain = process.env.DOMAIN;
  if (!domain) throw new Error("set DOMAIN");
  for (const body of [{ name: domain }, { name: `www.${domain}`, redirect: domain, redirectStatusCode: 308 }]) {
    const r = await api(`/v10/projects/${p.id}/domains`, { method: "POST", body: JSON.stringify(body) });
    const already = r.status === 409 || /already/i.test(r.body?.error?.message ?? "");
    console.log(`${body.name}: ${r.status < 300 ? "added" : already ? "already added" : `failed (${r.status} ${r.body?.error?.message ?? ""})`}`);
  }
  const apex = await api(`/v6/domains/${domain}/config`);
  const www = await api(`/v6/domains/www.${domain}/config`);
  const ipv4 = apex.body?.recommendedIPv4?.[0]?.value?.[0] ?? "76.76.21.21";
  const cname = www.body?.recommendedCNAME?.[0]?.value ?? "cname.vercel-dns.com";
  console.log(JSON.stringify({ records: [{ type: "A", host: "@", value: ipv4 }, { type: "CNAME", host: "www", value: cname.replace(/\.$/, "") }], configured: !apex.body?.misconfigured }, null, 2));
} else {
  throw new Error("usage: node scripts/vercel.js setup | domain | attach");
}
