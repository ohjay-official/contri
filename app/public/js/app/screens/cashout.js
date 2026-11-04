// @ts-check
// Cashing out a circle account to an exchange or wallet on any supported chain.

import { formatAmount, parseAmount } from "../../lib/contri.js";
import { signIntents, transfer } from "../../lib/intents.js";
import { getConfig, relay, swap } from "../api.js";
import { usd } from "../state.js";
import { busy, field, h, notice, show, sleep } from "../ui.js";
import { balanceOf, local, signer } from "../wallet.js";
import { NETWORKS } from "./fund.js";

/** @param {number} index */
export async function cashOutScreen(index) {
  const [cfg, s, balance, known] = await Promise.all([getConfig(), signer(index), balanceOf(index), local()]);
  const back = known[index]?.circle;
  const amount = /** @type {HTMLInputElement} */ (h("input", { type: "text", inputmode: "decimal", value: formatAmount(balance).replace(/,/g, "") }));
  const network = /** @type {HTMLSelectElement} */ (h("select", null, NETWORKS.map((n) => h("option", { value: n.id }, `${n.symbol} on ${n.label}`))));
  const address = /** @type {HTMLInputElement} */ (h("input", { type: "text", autocomplete: "off", spellcheck: false, autocapitalize: "off", placeholder: "Your deposit address on that network" }));
  const estimate = h("p", { class: "summary", "aria-live": "polite" });
  const progress = h("p", { class: "progress", "aria-live": "polite" });

  const read = () => {
    const value = parseAmount(amount.value);
    if (value <= 0n) throw new Error("Enter an amount.");
    if (value > balance) throw new Error(`You have ${usd(balance)} here.`);
    if (!address.value.trim()) throw new Error("Paste the address to send to.");
    return { network: network.value, account: s.accountId, amount: value.toString(), address: address.value.trim() };
  };

  const check = h("button", { class: "secondary" }, "See what arrives");
  check.addEventListener("click", () =>
    busy(check, "Checking", async () => {
      const q = await swap("cashout", { ...read(), dry: true });
      estimate.textContent = `About ${q.receive} ${q.symbol} arrives on ${q.label}, in about ${Math.max(1, Math.round(q.seconds / 60))} minute${q.seconds > 90 ? "s" : ""}. Network fee: ${q.fee} ${q.symbol}.`;
    }),
  );

  const go = h("button", { class: "primary" }, "Cash out");
  go.addEventListener("click", () =>
    busy(go, "Sending", async () => {
      const req = read();
      const q = await swap("cashout", req);
      if (!q.depositAddress) throw new Error("1Click didn't give a deposit address. Try again.");
      const r = await relay([await signIntents(s, [transfer(q.depositAddress, cfg.tokenId, req.amount)], { recipient: cfg.intentsId })]);
      await swap("submit", { txHash: r.hash, depositAddress: q.depositAddress }).catch(() => null);
      notice("Sent. It's on its way.");
      progress.textContent = `Sending ${q.receive} ${q.symbol} to your ${q.label} address.`;
      for (let i = 0; i < 120; i++) {
        await sleep(5000);
        if (!progress.isConnected) return;
        const st = await swap("status", { depositAddress: q.depositAddress }).catch(() => null);
        if (st?.status === "SUCCESS") return void (progress.textContent = `Arrived: ${q.receive} ${q.symbol} on ${q.label}.`);
        if (st?.status === "REFUNDED" || st?.status === "FAILED") return void (progress.textContent = "It couldn't be sent and the money came back to this circle's account.");
      }
    }),
  );

  show(
    h("section", { class: "stack narrow" },
      h("a", { class: "back", href: back !== undefined ? `#/c/${back}` : "#/" }, back !== undefined ? "Back to the circle" : "Your circles"),
      h("h1", null, "Cash out"),
      h("p", { class: "balance-line" }, "Available: ", h("strong", { class: "amount" }, usd(balance))),
      field("Amount, in dollars", amount),
      field("Send to", network, "Pick the network your exchange or wallet accepts for this coin. Sending on the wrong network can lose the money."),
      field("Address", address),
      h("div", { class: "actions row" }, check, go),
      estimate,
      progress,
      h("p", { class: "hint" }, "Your money leaves through NEAR Intents. The receiving address is only sent to 1Click, which delivers it."),
    ),
  );
}
