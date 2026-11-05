// @ts-check
// Your circles: what each one needs from you now.

import { dueFor, payoutDateMs, potSize, roundDeadlineMs, seatOf } from "../../lib/contri.js";
import { privateBalance } from "../private.js";
import { every, fromNow, nameOf, refresh, state, usd, when } from "../state.js";
import { h, show } from "../ui.js";
import { local } from "../wallet.js";

/** One line saying where the member stands. @param {import("../../lib/contri.js").Circle} c @param {string} me */
export function standing(c, me) {
  const due = dueFor(c, me);
  const seat = seatOf(c, me);
  if (c.status === "Open") {
    const left = c.size - c.members.length;
    return { tone: "quiet", text: `Waiting for ${left} more ${left === 1 ? "person" : "people"} to join` };
  }
  if (c.status === "Cancelled") return { tone: "quiet", text: "Cancelled. Deposits go back to members." };
  if (c.status === "Finished") return { tone: "quiet", text: "Finished. Everyone got their turn." };
  const deadline = roundDeadlineMs(c) ?? 0;
  if (due === "pay") return { tone: "due", text: `Pay ${usd(c.contribution)} by ${when(deadline)}` };
  if (due === "wait") return { tone: "due", text: "You missed this round. Your deposit covers it when the round is settled." };
  if (seat === c.round) return { tone: "good", text: `You receive ${usd(potSize(c))} this round` };
  if (seat > c.round) return { tone: "quiet", text: `Paid this round. You receive ${usd(potSize(c))} ${fromNow(payoutDateMs(c, seat) ?? 0)}` };
  return { tone: "quiet", text: "Paid this round. You've had your turn." };
}

export async function homeScreen() {
  show(h("section", { class: "stack" }, h("h1", null, "Your circles"), h("p", { class: "loading" }, "Loading your circles")));
  await refresh();
  const slots = state.slots ?? [];
  const known = await local();

  const rows = [];
  for (const slot of slots) {
    for (const id of slot.circles) {
      const c = state.circles.get(id);
      if (!c) continue;
      const s = standing(c, slot.signer.accountId);
      rows.push(
        h("li", null,
          h("a", { class: "circle-row", href: `#/c/${id}` },
            h("span", { class: "row-title" }, nameOf(id)),
            h("span", { class: "row-sub" }, `${usd(c.contribution)} ${every(c.period_secs)}, ${c.members.length} of ${c.size} members`),
            h("span", { class: `row-status ${s.tone}` }, s.text),
          ),
        ),
      );
    }
    // Something started on this device but not finished: a circle waiting for its first deposit.
    const l = known[slot.index];
    if (!slot.circles.length && l?.pending) {
      const p = l.pending;
      rows.push(
        h("li", null,
          h("a", { class: "circle-row", href: `#/add/${slot.index}` },
            h("span", { class: "row-title" }, p.kind === "create" ? p.name : `Joining ${nameOf(p.circle)}`),
            h("span", { class: "row-sub" }, slot.balance > 0n ? `${usd(slot.balance)} added so far` : "Not started yet"),
            h("span", { class: "row-status due" }, p.kind === "create" ? "Add your first contribution to create it" : "Add your deposit to join"),
          ),
        ),
      );
    } else if (!slot.circles.length && slot.balance > 0n) {
      rows.push(
        h("li", null,
          h("a", { class: "circle-row", href: `#/cash/${slot.index}` },
            h("span", { class: "row-title" }, `${usd(slot.balance)} not in a circle`),
            h("span", { class: "row-sub" }, "Left over from a circle that ended or a top-up"),
            h("span", { class: "row-status good" }, "Cash out"),
          ),
        ),
      );
    }
  }

  show(
    h("section", { class: "stack" },
      h("h1", null, "Your circles"),
      rows.length
        ? h("ul", { class: "circle-list" }, rows)
        : h("div", { class: "empty" },
            h("p", null, "You're not in a circle yet"),
            h("p", null, "Start one and send the invite link to the people you save with. If someone sent you a link, open it on this phone to join."),
          ),
      h("div", { class: "actions" }, h("a", { class: "button primary", href: "#/new" }, "Start a circle")),
      privateCard(),
    ),
  );
}

/** The private balance, read after the screen shows so 1Click never holds it up. */
function privateCard() {
  const amount = h("strong", { class: "amount" }, "…");
  const cash = h("a", { class: "button secondary", href: "#/private/cash", hidden: true }, "Cash out");
  privateBalance().then(
    (b) => {
      amount.textContent = usd(b);
      cash.hidden = b <= 0n;
    },
    () => (amount.textContent = "can't be read right now"),
  );
  return h("div", { class: "stack money" },
    h("h2", null, "Private balance"),
    h("p", { class: "balance-line" }, "In your private balance: ", amount),
    h("p", { class: "hint" }, "Kept on NEAR Intents' private ledger, where nobody can see it. Pay any circle from it, and send payouts back to it."),
    h("div", { class: "actions row" }, h("a", { class: "button secondary", href: "#/private/add" }, "Add privately"), cash),
  );
}
