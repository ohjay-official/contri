// @ts-check
// Adding money to the private balance from an exchange or wallet.
//
// The deposit goes to a one-time 1Click address and lands on NEAR Intents'
// private ledger, in the member's private account. From there it moves into
// any circle in about ten seconds, and the public chain shows money arriving
// from 1Click, never the exchange or wallet behind it.

import { parseAmount } from "../../lib/contri.js";
import { addPrivately, clearPrivateTopUp, follow, pendingPrivateTopUp, privateBalance, STATUS } from "../private.js";
import { nameOf, usd } from "../state.js";
import { busy, field, h, show } from "../ui.js";
import { local } from "../wallet.js";
import { depositDetails, networkPicker } from "./fund.js";

/** @param {number | null} then the circle account (slot) to go back to, if adding was for a circle */
export async function privateAddScreen(then) {
  const known = then === null ? {} : await local();
  const forCircle = then !== null ? known[then] : undefined;
  const backHref = then !== null ? `#/add/${then}` : "#/";
  const backText = forCircle?.pending?.kind === "create" ? forCircle.pending.name : forCircle?.circle !== undefined ? nameOf(forCircle.circle) : "Your circles";

  const balanceEl = h("strong", { class: "amount" }, "…");
  const progress = h("p", { class: "progress", "aria-live": "polite" });
  const amountInput = /** @type {HTMLInputElement} */ (h("input", { type: "text", inputmode: "decimal", autocomplete: "off", value: "10" }));
  const networks = networkPicker();
  const depositBox = h("div", { class: "deposit" });
  const next = h("div", { class: "actions", hidden: true }, h("a", { class: "button primary", href: backHref }, then !== null ? `Back to ${backText}` : "Your circles"));

  /** Shows a deposit address and follows it until the money arrives. @param {any} q */
  const showDeposit = (q) => {
    depositBox.replaceChildren(...depositDetails(q, "Send exactly this amount. If it can't go through, the money comes back to your private balance.").filter((x) => x !== null));
    progress.textContent = STATUS.PENDING_DEPOSIT;
    const screen = depositBox.closest("section");
    if (!screen) return;
    // Followed in the background, so the button is free for another address.
    follow(q.depositAddress, (st) => (progress.textContent = st === "SUCCESS" ? `Arrived: ${usd(parseAmount(q.receive))} is in your private balance.` : STATUS[st] ?? progress.textContent), screen, 24 * 60).then(async (last) => {
      if (["SUCCESS", "REFUNDED", "FAILED"].includes(last)) await clearPrivateTopUp();
      if (last !== "SUCCESS") return;
      balanceEl.textContent = usd(await privateBalance().catch(() => parseAmount(q.receive)));
      next.hidden = false;
    });
  };

  const getAddress = /** @type {HTMLButtonElement} */ (h("button", { class: "secondary" }, "Get a deposit address"));
  getAddress.addEventListener("click", () =>
    busy(getAddress, "Getting an address", async () => {
      const want = parseAmount(amountInput.value);
      if (want < 1_000_000n) throw new Error("Add at least $1: smaller amounts cost more in fees than they're worth.");
      showDeposit(await addPrivately(networks.value(), want));
      depositBox.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }),
  );

  show(
    h("section", { class: "stack narrow" },
      h("a", { class: "back", href: backHref }, backText),
      h("h1", null, "Add to your private balance"),
      h("p", { class: "balance-line" }, "In your private balance: ", balanceEl),
      h("p", null, "Your private balance is kept on NEAR Intents' private ledger. Nobody looking at the public chain can see it, and when you pay a circle from it, the chain shows the money coming from NEAR Intents, not from your exchange or wallet."),
      progress,
      next,
      field("How much, in dollars", amountInput, "Adding more than one round's worth, and paying from it over time, makes it harder for anyone to match what you send to what you pay."),
      h("p", null, "Choose the network you're sending from. Withdrawing from an exchange works: pick the same network there."),
      networks.el,
      h("div", { class: "actions" }, getAddress),
      depositBox,
    ),
  );

  // A deposit address from before a reload, while it's still valid.
  const pending = await pendingPrivateTopUp();
  if (pending) showDeposit(pending);

  const held = await privateBalance().catch(() => null);
  balanceEl.textContent = held === null ? "can't be read right now" : usd(held);
  if (then !== null && held !== null && held > 0n) next.hidden = false;
}
