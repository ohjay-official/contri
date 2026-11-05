// @ts-check
// Help: where each top-up, move and cash-out is, and its details for support.
//
// Contri can't move, freeze or return anyone's money: the member's keys come
// from their passkey, and the pot is held by the contract. What support can
// do is find where a payment is. Every top-up and cash-out goes through a
// one-time 1Click deposit address; this screen asks 1Click where each one is,
// and copies the details a member sends to support.

import { swap } from "../api.js";
import { STATUS } from "../private.js";
import { busy, copy, h, show } from "../ui.js";
import { moves } from "../wallet.js";
import { NETWORKS } from "./fund.js";

/** What each kind of move is, in the member's words. */
const KIND = {
  topup: "Top-up to a circle",
  cashout: "Cash-out from a circle",
  "private-topup": "Top-up to your private balance",
  "private-to-circle": "From your private balance to a circle",
  "to-private": "From a circle to your private balance",
  "private-cashout": "Cash-out from your private balance",
};

/** @param {number} ms */
const when = (ms) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/** Long addresses, shortened to fit a phone: 0x7d3A5b…0819. @param {string} a */
const short = (a) => (a.length > 20 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a);

export async function helpScreen() {
  const list = await moves();
  // Cash-outs from the private balance record the network's id; show its name and coin.
  const net = (/** @type {string | undefined} */ n) => NETWORKS.find((x) => x.id === n);
  const network = (/** @type {string | undefined} */ n) => net(n)?.label ?? n;
  /** @param {import("../wallet.js").Move} m */
  const amountOf = (m) => (m.kind === "private-cashout" && m.amount ? `${m.amount} ${net(m.network)?.symbol ?? "USDT"} (after fees)` : m.amount);

  const items = list.map((m) => {
    const status = h("span", { class: "row-status quiet" }, "Checking…");
    /** @type {string} */
    let state = "";
    const details = () =>
      [
        "Contri support request",
        `What: ${KIND[m.kind] ?? m.kind}`,
        m.amount ? `Amount: ${amountOf(m)}${m.network ? ` on ${network(m.network)}` : ""}` : null,
        `When: ${when(m.at)}`,
        `1Click deposit address: ${m.depositAddress}`,
        `Status: ${state || "unknown"} (checked ${when(Date.now())})`,
        m.account ? `Circle account: ${m.account}` : null,
        m.to ? `Sent to: ${m.to}` : null,
        m.tx ? `NEAR transaction: ${m.tx}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    const copyBtn = /** @type {HTMLButtonElement} */ (h("button", { class: "secondary" }, "Copy details for support"));
    copyBtn.addEventListener("click", () => busy(copyBtn, "Copying", () => copy(details(), "Details copied")));
    swap("status", { depositAddress: m.depositAddress }).then(
      (st) => {
        state = st.status;
        status.textContent = STATUS[st.status] ?? st.status;
        status.className = `row-status ${st.status === "SUCCESS" ? "good" : st.status === "FAILED" || st.status === "REFUNDED" || st.status === "INCOMPLETE_DEPOSIT" ? "due" : "quiet"}`;
      },
      () => (status.textContent = "Couldn't check right now"),
    );
    return h("li", { class: "stack move" },
      h("span", { class: "row-title" }, KIND[m.kind] ?? m.kind),
      h("span", { class: "row-sub" }, [amountOf(m), m.network ? `on ${network(m.network)}` : null, when(m.at)].filter(Boolean).join(", ")),
      status,
      h("span", { class: "hint", translate: "no" }, `Deposit address ${short(m.depositAddress)}`),
      h("div", { class: "actions" }, copyBtn),
    );
  });

  show(
    h("section", { class: "stack narrow" },
      h("a", { class: "back", href: "#/" }, "Your circles"),
      h("h1", null, "Help"),
      h("p", null, "Contri never has your keys: they're made on this phone from your passkey, and each pot is held by a contract nobody can change. What we can do is find where a payment is."),
      h("h2", null, "Your top-ups and cash-outs"),
      items.length
        ? h("ul", { class: "circle-list" }, items)
        : h("p", { class: "hint" }, "Nothing yet. Top-ups and cash-outs you make on this phone show here."),
      h("h2", null, "Something not right?"),
      h("ul", { class: "stack" },
        h("li", null, "A top-up usually arrives within a few minutes. If it says Waiting for your deposit long after you sent it, check you sent the right coin on the right network."),
        h("li", null, "If a payment into a circle didn't go through, your money stayed in that circle's account. Open the circle to try again."),
        h("li", null, "A top-up or cash-out that can't go through is refunded to your own account or private balance, never to anyone else."),
      ),
      h("p", null, "Still stuck? Tap Copy details for support on the payment, and send it to Contri on ", h("a", { href: "https://x.com/Oh_Jay0", target: "_blank", rel: "noopener noreferrer" }, "X (@Oh_Jay0)"), ". The details include your circle account and addresses, so sending them tells us they're yours. Never send your recovery code: nobody from Contri will ever ask for it."),
    ),
  );
}
