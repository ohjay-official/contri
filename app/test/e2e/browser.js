// @ts-check
// The real app in a real browser, against the real NEAR Intents contract on
// a local NEAR sandbox. Two members, each with their own browser and passkey
// (a WebAuthn virtual authenticator with PRF), click through a whole circle:
// sign up, start a circle, invite, join, pay, get paid. Top-ups are the one
// step done outside the browser: the sandbox has no 1Click, so the test sends
// USDT into the account the app shows, as 1Click would.
//
// Run by contract/sandbox/tests/e2e.rs (`the_app_works_in_a_browser`) with the
// same environment as sandbox.js, plus SHOTS (where screenshots go).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { signerFromSecretKey } from "../../public/js/lib/keys.js";
import { sendTransaction, TGAS } from "../../public/js/lib/near.js";

const env = /** @param {string} k */ (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};
const RPC = env("NEAR_RPC");
const INTENTS = env("INTENTS_ID");
const SHOTS = process.env.SHOTS ?? "e2e-shots";
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
await mkdir(SHOTS, { recursive: true });

// The app's own server: static pages and the /api handlers, set up for the sandbox.
const server = spawn(process.execPath, [fileURLToPath(new URL("../../dev/server.js", import.meta.url))], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "inherit", "inherit"],
});
for (let i = 0; i < 50; i++) {
  if (await fetch(`${BASE}/app`).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}

const funder = await signerFromSecretKey(env("FUNDER_KEY"), env("FUNDER_ID"));
/** Sends USDT into a member's NEAR Intents account, as a 1Click top-up would. @param {string} account @param {bigint} amount */
async function topUp(account, amount) {
  await sendTransaction(RPC, funder, funder.accountId, [
    { functionCall: { method: "ft_transfer_call", args: { receiver_id: INTENTS, amount: amount.toString(), msg: account }, gas: 100n * TGAS, deposit: 1n } },
  ]);
}

const browser = await chromium.launch();
let step = 0;

/** A member: their own browser profile and passkey. @param {string} name */
async function member(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = /** @type {string[]} */ ([]);
  page.on("pageerror", (/** @type {Error} */ e) => errors.push(String(e)));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  const shot = async (/** @type {string} */ what) => {
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${String(++step).padStart(2, "0")}-${name}-${what}.png`, fullPage: true });
  };
  return { name, page, shot, errors };
}

/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * On the add-money screen: read the circle account, top it up as 1Click
 * would, wait for the app to see the money, then press the action button.
 * @param {Awaited<ReturnType<typeof member>>} m @param {string} label the button's text starts with this
 */
async function fundAndAct(m, label) {
  await m.page.click("text=Already have USDT on NEAR Intents?");
  const account = (await m.page.locator("details.more .code-block").textContent())?.trim() ?? "";
  assert.match(account, /^[0-9a-f]{64}$/, "the app shows a fresh implicit account");
  await m.shot("add-money");
  await topUp(account, 5_000_000n);
  await m.page.waitForFunction(
    (/** @type {string} */ l) => [...document.querySelectorAll("button")].some((b) => b.textContent?.startsWith(l) && !b.disabled),
    label,
    { timeout: 30_000 },
  );
  await m.page.getByRole("button", { name: new RegExp(`^${esc(label)}`) }).click();
  return account;
}

try {
  console.log("browser e2e: two members, two browsers, one circle");

  // Ada signs up with a passkey and starts a circle.
  const ada = await member("ada");
  await ada.page.goto(`${BASE}/app`);
  await ada.shot("open");
  await ada.page.click("text=Create a passkey");
  await ada.page.getByRole("link", { name: "Start a circle" }).click();
  await ada.page.fill("input[placeholder='Yaba traders']", "Ikeja friends");
  await ada.page.fill("input[placeholder='5']", "5");
  await ada.page.selectOption("select >> nth=0", "2");
  await ada.page.selectOption("select >> nth=1", "600");
  await ada.shot("start-a-circle");
  await ada.page.click("button[type=submit]");
  await fundAndAct(ada, "Create circle and pay");

  // The circle exists, with Ada in seat 1 and the invite link open.
  await ada.page.waitForSelector("details.share .code-block", { timeout: 30_000 });
  const link = (await ada.page.locator("details.share .code-block").textContent())?.trim() ?? "";
  assert.match(link, /\/join#\d+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(await ada.page.locator("h1").textContent(), "Ikeja friends", "the name decrypts from chain");
  await ada.shot("circle-created");

  // Bayo opens the link in his own browser, signs up, tops up and joins.
  const bayo = await member("bayo");
  await bayo.page.goto(link);
  await bayo.page.waitForSelector(".facts");
  assert.equal(await bayo.page.locator("h1").textContent(), "Ikeja friends");
  assert.ok(!bayo.page.url().includes(link.split("#")[1]), "the invite secret is removed from the address bar");
  await bayo.page.reload();
  await bayo.page.waitForSelector(".facts");
  assert.equal(await bayo.page.locator("h1").textContent(), "Ikeja friends", "a reload keeps the invite");
  await bayo.shot("invite");
  await bayo.page.click("text=Join this circle");
  await bayo.page.click("text=Create a passkey");
  await bayo.page.waitForSelector("h1:has-text('Join Ikeja friends')");
  await fundAndAct(bayo, "Join and pay");
  await bayo.page.waitForSelector(".ring", { timeout: 30_000 });
  await bayo.page.waitForSelector("text=Add money to pay $5.00", { timeout: 30_000 });
  await bayo.shot("joined");

  // Round 1. Each member's first $5 became their deposit, so each adds $5 more and pays.
  for (const m of [ada, bayo]) {
    await m.page.goto(`${BASE}/app#/`);
    await m.page.waitForSelector(".circle-list");
    await m.page.click(".circle-row");
    await m.page.waitForSelector(".ring");
    const add = m.page.getByRole("link", { name: /^Add money to pay/ });
    if (await add.count()) {
      await add.click();
      await fundAndAct(m, "Pay $5.00");
      await m.page.waitForSelector(".ring", { timeout: 30_000 });
    } else {
      await m.page.click("text=Pay $5.00 for round 1");
    }
    await m.page.waitForSelector(".notice", { timeout: 30_000 });
  }

  // Bayo's payment was the last one: the contract paid the pot to Ada in the same transaction.
  await ada.page.reload();
  await ada.page.waitForSelector(".ring");
  await ada.page.waitForSelector("text=Received $10.00", { timeout: 30_000 });
  await ada.shot("paid-out");

  for (const m of [ada, bayo]) assert.deepEqual(m.errors, [], `${m.name}'s page had no errors`);
  console.log("browser e2e: passed");
} finally {
  await browser.close();
  server.kill();
}
