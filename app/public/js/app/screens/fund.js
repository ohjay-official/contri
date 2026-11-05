// @ts-check
// Adding money to a circle account, then doing what it was for: creating a
// circle, joining one, or paying a round.
//
// Money arrives two ways: from the member's private balance (one tap, about
// ten seconds), or through 1Click: the member sends USDT (or USDC) on a chain
// their exchange or wallet supports to a one-time deposit address, and it
// lands as USDT in this circle's account on NEAR Intents.

import { toHex } from "../../lib/bytes.js";
import { actions, dueFor, findEvent, formatAmount, parseAmount, seatOf } from "../../lib/contri.js";
import { decryptName, encryptName, inviteSigner, signJoin } from "../../lib/invite.js";
import { getCircle, getConfig, relay, sign, swap } from "../api.js";
import { follow, moveOut, privateBalance, STATUS } from "../private.js";
import { nameOf, usd } from "../state.js";
import { busy, copy, field, h, notice, show, sleep } from "../ui.js";
import { balanceOf, decodeSecret, local, remember, signer } from "../wallet.js";

/** Networks shown first are the cheapest for small amounts. */
export const NETWORKS = [
  { id: "bsc", label: "BNB Smart Chain (BEP20)", symbol: "USDT", note: "Lowest fees for small amounts. Most exchanges support it." },
  { id: "sol", label: "Solana", symbol: "USDT", note: "Low fees" },
  { id: "ton", label: "TON", symbol: "USDT", note: "From Telegram wallets" },
  { id: "base", label: "Base", symbol: "USDC", note: "Arrives as USDT" },
  { id: "arb", label: "Arbitrum", symbol: "USDC", note: "Arrives as USDT" },
  { id: "tron", label: "Tron (TRC20)", symbol: "USDT", note: "Minimum about $2.60, and higher fees" },
  { id: "eth", label: "Ethereum (ERC20)", symbol: "USDT", note: "High network fees" },
];

/** The list of networks to send from, first one chosen. */
export function networkPicker() {
  const el = h("div", { class: "networks", role: "radiogroup", "aria-label": "Network you're sending from" },
    NETWORKS.map((n, i) => {
      const input = /** @type {HTMLInputElement} */ (h("input", { type: "radio", name: "network", value: n.id, checked: i === 0 }));
      return h("label", { class: "choice" }, input, h("span", null, h("strong", null, `${n.symbol} on ${n.label}`), h("span", { class: "hint" }, n.note)));
    }),
  );
  const value = () => /** @type {HTMLInputElement | null} */ (el.querySelector("input:checked"))?.value ?? "bsc";
  return { el, value };
}

/**
 * Where and how much to send, for a 1Click deposit address.
 * @param {{ depositAddress: string, depositMemo: string | null, send: string, symbol: string, label: string, seconds: number, deadline: string }} q
 * @param {string} extra what happens to more or less than asked
 */
export function depositDetails(q, extra) {
  return [
    h("p", null, `Send `, h("strong", null, `${q.send} ${q.symbol}`), ` on `, h("strong", null, q.label), ` to:`),
    h("p", { class: "code-block", translate: "no" }, q.depositAddress),
    h("div", { class: "actions row" }, h("button", { class: "secondary", onclick: () => copy(q.depositAddress, "Address copied") }, "Copy address")),
    q.depositMemo ? h("p", null, "Memo, required: ", h("strong", { class: "code" }, q.depositMemo)) : null,
    h("p", { class: "hint" }, `Only send ${q.symbol} on ${q.label} to this address. ${extra} It usually arrives about ${Math.max(1, Math.round(q.seconds / 60))} minute${q.seconds > 90 ? "s" : ""} after your exchange or wallet sends it. Use this address once, before ${new Date(q.deadline).toLocaleString()}.`),
  ];
}

/** @param {number} index the circle account (slot) */
export async function fundScreen(index) {
  const [cfg, known, s] = await Promise.all([getConfig(), local(), signer(index)]);
  const l = known[index] ?? {};
  // The circle's name, read with its invite key: this screen can open straight after a reload.
  const circleName = async (/** @type {number} */ id, /** @type {{ name: string }} */ c) => (l.secret && (await decryptName(decodeSecret(l.secret), c.name))) || nameOf(id);
  const a = actions(cfg.contractId, cfg.tokenId);

  // What the money is for.
  /** @type {{ title: string, need: bigint, whole: bigint, button: string, run: () => Promise<string> } | null} */
  let purpose = null;
  if (l.pending?.kind === "create") {
    const p = l.pending;
    const contribution = BigInt(p.contribution);
    purpose = {
      title: `Create ${p.name}`,
      need: contribution,
      whole: contribution * BigInt(p.size + 1),
      button: `Create circle and pay ${usd(contribution)} deposit`,
      run: async () => {
        if (!l.secret) throw new Error("This circle's invite secret is missing on this device. Start again.");
        const secret = decodeSecret(l.secret);
        const intents = a.create({
          contribution, size: p.size, periodSecs: p.periodSecs, random: p.random,
          inviteKeyHex: toHex((await inviteSigner(secret)).publicKey),
          name: await encryptName(secret, p.name),
        });
        const r = await relay([await sign(s, intents)]);
        const created = findEvent(r.events, "circle_created");
        if (!created) throw new Error(r.notes[0] ?? "The circle wasn't created and your money stayed in your balance.");
        await remember(index, { circle: created.circle, pending: undefined });
        return `#/c/${created.circle}?share`;
      },
    };
  } else if (l.pending?.kind === "join") {
    const id = l.pending.circle;
    const c = await getCircle(id);
    if (!c) throw new Error("That circle no longer exists.");
    const deposit = BigInt(c.contribution);
    purpose = {
      title: `Join ${await circleName(id, c)}`,
      need: deposit,
      whole: deposit + BigInt(c.contribution) * BigInt(c.size),
      button: `Join and pay ${usd(deposit)} deposit`,
      run: async () => {
        const sig = l.secret && c.invite_only ? await signJoin(decodeSecret(l.secret), cfg.contractId, id, s.accountId, deposit) : null;
        const r = await relay([await sign(s, a.join(id, deposit, sig))]);
        if (!findEvent(r.events, "joined")) throw new Error(`${r.notes[0] ?? "You weren't added"}. Your deposit is back in your balance.`);
        await remember(index, { circle: id, pending: undefined });
        return `#/c/${id}`;
      },
    };
  } else if (l.circle !== undefined) {
    const id = l.circle;
    const c = await getCircle(id);
    if (c && dueFor(c, s.accountId) === "pay" && seatOf(c, s.accountId) >= 0) {
      const round = c.round;
      purpose = {
        title: `Pay round ${round + 1} of ${await circleName(id, c)}`,
        need: BigInt(c.contribution),
        whole: BigInt(c.contribution) * BigInt(c.size - round),
        button: `Pay ${usd(c.contribution)}`,
        run: async () => {
          await relay([await sign(s, a.contribute(id, round, c.contribution))]);
          return `#/c/${id}`;
        },
      };
    }
  }

  const balanceEl = h("strong", { class: "amount" }, "…");
  const progress = h("p", { class: "progress", "aria-live": "polite" });
  const actionBtn = /** @type {HTMLButtonElement} */ (h("button", { class: "primary", disabled: true }, purpose?.button ?? "Done"));
  actionBtn.addEventListener("click", () =>
    busy(actionBtn, "Signing and sending", async () => {
      if (!purpose) return void (location.hash = "#/");
      const next = await purpose.run();
      notice("Done");
      location.hash = next;
    }),
  );

  const depositBox = h("div", { class: "deposit" });
  const networks = networkPicker();
  const getAddress = /** @type {HTMLButtonElement} */ (h("button", { class: "secondary" }, "Get a deposit address"));
  const amountInput = h("input", { type: "text", inputmode: "decimal", autocomplete: "off" });
  /** @param {bigint} v */
  const setAmount = (v) => (amountInput.value = formatAmount(v > 0n ? v : 1_000_000n, { up: true }).replace(/,/g, ""));
  const amountChoices = h("div", { class: "actions row" });

  let balance = 0n;
  let stopped = false;
  /** @type {string | null} */
  let depositAddress = null;

  const render = () => {
    balanceEl.textContent = usd(balance);
    const need = purpose ? purpose.need - balance : 0n;
    actionBtn.disabled = Boolean(purpose) && need > 0n;
    if (purpose && need <= 0n) progress.textContent = "Your money is here";
  };

  getAddress.addEventListener("click", () =>
    busy(getAddress, "Getting an address", async () => {
      const network = networks.value();
      const want = parseAmount(amountInput.value);
      if (want < 1_000_000n) throw new Error("Add at least $1: smaller amounts cost more in fees than they're worth.");
      const q = await swap("topup", { network, account: s.accountId, amount: want.toString() });
      depositAddress = q.depositAddress;
      // Kept for this circle account, so it's still here if the phone reloads the page.
      await remember(index, { deposit: q });
      depositBox.replaceChildren(...depositDetails(q, "Sending more is fine: the extra stays in this circle's account.").filter((x) => x !== null));
      progress.textContent = "Waiting for your deposit";
      depositBox.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }),
  );

  // From the private balance: shown once it's known to hold something.
  const privateBox = h("div", { class: "stack", hidden: true });
  const showPrivate = (/** @type {bigint} */ held) => {
    const short = purpose ? purpose.need - balance : 0n;
    const move = short > 0n && short < held ? short : held;
    const moveBtn = /** @type {HTMLButtonElement} */ (h("button", { class: "primary" }, `Move ${usd(move)} here`));
    moveBtn.addEventListener("click", () =>
      busy(moveBtn, "Moving", async () => {
        const q = await moveOut({ to: s.accountId }, move);
        notice("Moving from your private balance");
        progress.textContent = `Moving ${usd(move)} from your private balance. It takes about ${q.seconds} seconds.`;
        privateBox.hidden = true;
        const screen = privateBox.closest("section");
        if (screen) follow(q.depositAddress, (st) => st !== "SUCCESS" && (progress.textContent = STATUS[st] ?? progress.textContent), screen);
      }),
    );
    privateBox.replaceChildren(
      h("h2", null, "From your private balance"),
      h("p", { class: "balance-line" }, "In your private balance: ", h("strong", { class: "amount" }, usd(held))),
      h("div", { class: "actions" }, moveBtn),
    );
    privateBox.hidden = held <= 0n;
  };

  // Two ways in, side by side: straight to this circle, or privately through the private balance.
  const direct = /** @type {HTMLInputElement} */ (h("input", { type: "radio", name: "route", value: "direct", checked: true }));
  const viaPrivate = /** @type {HTMLInputElement} */ (h("input", { type: "radio", name: "route", value: "private" }));
  const routes = h("div", { class: "networks", role: "radiogroup", "aria-label": "How to add money" },
    h("label", { class: "choice" }, direct, h("span", null, h("strong", null, "Straight from an exchange or wallet"), h("span", { class: "hint" }, "Quickest. The public chain can link this circle to the address you send from."))),
    h("label", { class: "choice" }, viaPrivate, h("span", null, h("strong", null, "Privately, through your private balance"), h("span", { class: "hint" }, "Your exchange stays off the public chain. Add to your private balance, then move it here in one tap."))),
  );
  const directForm = h("div", { class: "stack" },
    field("How much, in dollars", amountInput, "Adding enough for every round at once saves a network fee each round. Anything not used stays in this account, and you can cash it out."),
    amountChoices,
    h("p", null, "Choose the network you're sending from. Withdrawing from an exchange works: pick the same network there."),
    networks.el,
    h("div", { class: "actions" }, getAddress),
    depositBox,
  );
  const privateRoute = h("div", { class: "stack", hidden: true },
    h("p", null, "Send from your exchange to your private balance first. When it arrives, come back here and move it into this circle in one tap."),
    h("div", { class: "actions" }, h("a", { class: "button primary", href: `#/private/add/${index}` }, "Add to your private balance")),
  );
  const pickRoute = () => {
    directForm.hidden = !direct.checked;
    privateRoute.hidden = direct.checked;
  };
  direct.addEventListener("change", pickRoute);
  viaPrivate.addEventListener("change", pickRoute);

  const nearAccount = h("details", { class: "more" },
    h("summary", null, "Already have USDT on NEAR Intents?"),
    h("p", null, "Transfer it inside NEAR Intents (for example from near.com) to this circle's account:"),
    h("p", { class: "code-block", translate: "no" }, s.accountId),
    h("div", { class: "actions row" }, h("button", { class: "secondary", onclick: () => copy(s.accountId, "Account copied") }, "Copy account")),
  );

  show(
    h("section", { class: "stack narrow" },
      h("a", { class: "back", href: l.circle !== undefined ? `#/c/${l.circle}` : "#/" }, l.circle !== undefined ? nameOf(l.circle) : "Your circles"),
      h("h1", null, purpose?.title ?? "Add money"),
      h("p", { class: "balance-line" }, "In this circle's account: ", balanceEl, purpose ? ` of ${usd(purpose.need)} needed` : null),
      progress,
      h("div", { class: "actions" }, actionBtn),
      privateBox,
      h("h2", null, "Add money"),
      routes,
      directForm,
      privateRoute,
      nearAccount,
    ),
  );

  // Suggested amounts: what's missing now, or enough for the whole circle.
  balance = await balanceOf(index).catch(() => 0n);
  if (!purpose || purpose.need > balance) privateBalance().then(showPrivate, () => null);
  const short = purpose ? purpose.need - balance : 5_000_000n;
  setAmount(short);
  // A deposit address from before a reload, while it's still valid.
  if (l.deposit && Date.parse(l.deposit.deadline) > Date.now()) {
    depositAddress = l.deposit.depositAddress;
    depositBox.replaceChildren(...depositDetails(l.deposit, "Sending more is fine: the extra stays in this circle's account.").filter((x) => x !== null));
    progress.textContent = STATUS.PENDING_DEPOSIT;
  }
  if (purpose && purpose.whole - balance > short) {
    amountChoices.append(
      h("button", { class: "secondary", type: "button", onclick: () => setAmount(short) }, `Just this: $${formatAmount(short > 0n ? short : 0n, { up: true })}`),
      h("button", { class: "secondary", type: "button", onclick: () => setAmount(purpose.whole - balance) }, `Every round: $${formatAmount(purpose.whole - balance, { up: true })}`),
    );
  }

  // Watch the balance until the screen changes.
  const view = document.getElementById("view");
  const screen = view?.firstElementChild;
  while (!stopped) {
    try {
      balance = await balanceOf(index);
      render();
      if (depositAddress && purpose && balance < purpose.need) {
        const st = await swap("status", { depositAddress }).catch(() => null);
        if (st?.status) progress.textContent = STATUS[st.status] ?? progress.textContent;
        if (["SUCCESS", "REFUNDED", "FAILED"].includes(st?.status)) {
          await remember(index, { deposit: undefined });
          depositAddress = null;
        }
      }
    } catch {
      // Keep trying quietly; the next poll may work.
    }
    await sleep(5000);
    stopped = !screen?.isConnected;
  }
}
