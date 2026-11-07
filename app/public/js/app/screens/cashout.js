// @ts-check
// Moving money out of a circle account or the private balance.
//
// From a circle account: into the private balance (free, about ten seconds),
// or to an exchange or wallet on any supported chain.
// From the private balance: to an exchange or wallet.

import { dueFor, formatAmount, parseAmount, seatOf } from "../../lib/contri.js";
import { transfer } from "../../lib/intents.js";
import { getCircle, getConfig, relay, sign, swap } from "../api.js";
import { follow, moveHome, moveOut, privateBalance, STATUS } from "../private.js";
import { usd } from "../state.js";
import { busy, field, h, notice, show } from "../ui.js";
import { balanceOf, confirmWithPasskey, local, logMove, signer, vault } from "../wallet.js";
import { NETWORKS } from "./fund.js";

/**
 * What a circle account can give up without leaving the member short for the
 * rounds they still owe.
 * @param {bigint} balance @param {import("../../lib/contri.js").Circle | null} c @param {string} me
 */
export function spare(balance, c, me) {
  if (!c || c.status !== "Active" || seatOf(c, me) < 0) return balance;
  const owed = BigInt(c.contribution) * BigInt(c.size - c.round - (dueFor(c, me) === "pay" ? 0 : 1));
  return balance > owed ? balance - owed : 0n;
}

/** @param {number | "private"} from a circle account (slot), or the private balance */
export async function cashOutScreen(from) {
  const fromPrivate = from === "private";
  const [cfg, known] = await Promise.all([getConfig(), local()]);
  const s = fromPrivate ? null : await signer(from);
  const balance = fromPrivate ? await privateBalance() : await balanceOf(from);
  const circleId = fromPrivate ? undefined : known[from]?.circle;
  const c = circleId !== undefined ? await getCircle(circleId).catch(() => null) : null;
  const free = s ? spare(balance, c, s.accountId) : balance;

  const amount = /** @type {HTMLInputElement} */ (h("input", { type: "text", inputmode: "decimal", value: formatAmount(free).replace(/,/g, "") }));
  const network = /** @type {HTMLSelectElement} */ (h("select", null, NETWORKS.map((n) => h("option", { value: n.id }, `${n.symbol} on ${n.label}`))));
  const address = /** @type {HTMLInputElement} */ (h("input", { type: "text", autocomplete: "off", spellcheck: false, autocapitalize: "off", placeholder: "Your deposit address on that network" }));
  const estimate = h("p", { class: "summary", "aria-live": "polite" });
  const progress = h("p", { class: "progress", "aria-live": "polite" });

  // Where to: a circle account can also send to the private balance.
  const toPrivate = /** @type {HTMLInputElement} */ (h("input", { type: "radio", name: "dest", value: "private", checked: true }));
  const toChain = /** @type {HTMLInputElement} */ (h("input", { type: "radio", name: "dest", value: "chain" }));
  // TON exchanges credit deposits by a comment (memo), which 1Click can't
  // add, so a TON cash-out is for your own wallet only.
  const tonNote = h("p", { class: "callout", hidden: true }, "TON: send only to your own wallet. Exchanges need a memo to credit a TON deposit, and this can't add one, so money sent to an exchange may never arrive.");
  network.addEventListener("change", () => (tonNote.hidden = network.value !== "ton"));
  const chainFields = h("div", { class: "stack" },
    field("Send to", network, "Pick the network your exchange or wallet accepts for this coin. Sending on the wrong network can lose the money. Trying a small amount first is safest."),
    tonNote,
    field("Address", address),
  );
  const destination = fromPrivate
    ? null
    : h("div", { class: "networks", role: "radiogroup", "aria-label": "Where to" },
        h("label", { class: "choice" }, toPrivate, h("span", null, h("strong", null, "Your private balance"), h("span", { class: "hint" }, "Free, about ten seconds. Pay your next circle from it."))),
        h("label", { class: "choice" }, toChain, h("span", null, h("strong", null, "An exchange or wallet"), h("span", { class: "hint" }, "On any supported network"))),
      );
  const going = () => (fromPrivate || toChain.checked ? "chain" : "private");

  const check = /** @type {HTMLButtonElement} */ (h("button", { class: "secondary" }, "See what arrives"));
  const go = /** @type {HTMLButtonElement} */ (h("button", { class: "primary" }, "Cash out"));
  // What happens to the money on the way out, for the destination chosen.
  const note = h("p", { class: "hint" });
  const sync = () => {
    const chain = going() === "chain";
    chainFields.hidden = !chain;
    check.hidden = !chain;
    go.textContent = chain ? "Cash out" : "Move to private balance";
    estimate.textContent = "";
    note.textContent = fromPrivate
      ? "The money leaves NEAR Intents' private ledger through 1Click. The public chain shows the payment to your address, not where it came from."
      : chain
        ? "Your address goes through Contri's server to 1Click, which delivers the money there by its confidential route, so it can't be looked up publicly."
        : "The money goes to NEAR Intents' private ledger. The public chain shows it leaving this circle's account, not where it went.";
  };
  toPrivate.addEventListener("change", sync);
  toChain.addEventListener("change", sync);

  const read = () => {
    // Left as shown, the amount means all of it: the shown figure is rounded down to the cent.
    const value = amount.value.trim() === formatAmount(free).replace(/,/g, "") ? free : parseAmount(amount.value);
    if (value <= 0n) throw new Error("Enter an amount.");
    if (value > balance) throw new Error(`You have ${usd(balance)} here.`);
    if (going() === "private") return { value, network: "", address: "" };
    if (!address.value.trim()) throw new Error("Paste the address to send to.");
    return { value, network: network.value, address: address.value.trim() };
  };

  check.addEventListener("click", () =>
    busy(check, "Checking", async () => {
      const r = read();
      const q = fromPrivate
        ? await swap("pmove", { vault: (await vault()).accountId, amount: r.value.toString(), network: r.network, address: r.address, dry: true })
        : await swap("cashout", { account: s?.accountId, amount: r.value.toString(), network: r.network, address: r.address, dry: true });
      const n = NETWORKS.find((x) => x.id === r.network);
      estimate.textContent = `About ${q.receive} ${n?.symbol} arrives on ${n?.label}, in about ${Math.max(1, Math.round(q.seconds / 60))} minute${q.seconds > 90 ? "s" : ""}. Network fee: ${q.fee} ${n?.symbol}.${q.contriFee ? ` Contri's ${q.contriFee} cash-out fee: $${q.contriFeeUsd}, shared with 1Click.` : ""} Both are already taken off what arrives.`;
    }),
  );

  go.addEventListener("click", () =>
    busy(go, "Sending", async () => {
      const r = read();
      // Money leaving Contri for an outside address can't be pulled back: ask for the passkey again.
      if (going() === "chain") await confirmWithPasskey();
      const n = NETWORKS.find((x) => x.id === r.network);
      /** @type {{ depositAddress: string, receive: string }} */
      let q;
      let arrived;
      if (fromPrivate) {
        q = await moveOut({ network: r.network, address: r.address }, r.value);
        arrived = `Arrived: ${q.receive} ${n?.symbol} on ${n?.label}.`;
      } else if (going() === "private") {
        q = await moveHome(/** @type {number} */ (from), r.value);
        arrived = `Arrived: ${usd(r.value)} is in your private balance.`;
      } else {
        const c1 = await swap("cashout", { network: r.network, account: s?.accountId, amount: r.value.toString(), address: r.address });
        if (!c1.depositAddress) throw new Error("1Click didn't give a deposit address. Try again.");
        const tx = await relay([await sign(/** @type {import("../../lib/keys.js").Signer} */ (s), [transfer(c1.depositAddress, cfg.tokenId, r.value)])], [c1.ticket]);
        await swap("submit", { txHash: tx.hash, depositAddress: c1.depositAddress }).catch(() => null);
        await logMove({ kind: "cashout", depositAddress: c1.depositAddress, amount: `${c1.receive} ${n?.symbol} (after fees)`, network: n?.label, account: s?.accountId, to: r.address, tx: tx.hash });
        q = c1;
        arrived = `Arrived: ${q.receive} ${n?.symbol} on ${n?.label}.`;
      }
      notice("Sent. It's on its way.");
      progress.textContent = "On its way";
      buttons.hidden = true; // one send per visit: no double sends
      const screen = progress.closest("section");
      if (!screen) return;
      const back = fromPrivate ? "your private balance" : "this circle's account";
      follow(q.depositAddress, (st) => {
        progress.textContent = st === "SUCCESS" ? arrived : st === "REFUNDED" ? `It couldn't be sent and the money came back to ${back}.` : st === "FAILED" ? `It failed. Keep this deposit address (${q.depositAddress}) and open Help: it is how the money can be traced.` : STATUS[st] ?? progress.textContent;
      }, screen, 15);
    }),
  );
  const buttons = h("div", { class: "actions row" }, check, go);

  const backHref = fromPrivate || circleId === undefined ? "#/" : `#/c/${circleId}`;
  show(
    h("section", { class: "stack narrow" },
      h("a", { class: "back", href: backHref }, backHref === "#/" ? "Your circles" : "Back to the circle"),
      h("h1", null, fromPrivate ? "Cash out your private balance" : "Move money out"),
      h("p", { class: "balance-line" }, fromPrivate ? "In your private balance: " : "In this circle's account: ", h("strong", { class: "amount" }, usd(balance))),
      free < balance ? h("p", { class: "hint" }, `${usd(balance - free)} stays for the rounds you still pay.`) : null,
      field("Amount, in dollars", amount),
      destination,
      chainFields,
      buttons,
      estimate,
      progress,
      note,
    ),
  );
  sync();
}
