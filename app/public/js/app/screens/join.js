// @ts-check
// Opening an invite link: see the circle, then join with a deposit.
// The link's secret is read from the address bar once and kept for this tab
// (main.js), then on this device once the member joins.

import { potSize } from "../../lib/contri.js";
import { decryptName } from "../../lib/invite.js";
import { getCircle } from "../api.js";
import { every, refresh, state, usd, when } from "../state.js";
import { h, notice, show } from "../ui.js";
import { encodeSecret, freshSlot, local, remember, unlocked } from "../wallet.js";
import { unlockScreen } from "./unlock.js";

/** @param {{ circle: number, secret: Uint8Array }} invite */
export async function joinScreen(invite) {
  const c = await getCircle(invite.circle);
  if (!c) {
    show(h("section", { class: "stack narrow" }, h("h1", null, "This invite doesn't work"), h("p", null, "The circle in this link doesn't exist. Ask for a new link."), h("a", { class: "button secondary", href: "/app" }, "Open Contri")));
    return;
  }
  const name = (await decryptName(invite.secret, c.name)) ?? `Circle ${c.id}`;
  const left = c.size - c.members.length;

  const details = h("dl", { class: "facts" },
    h("dt", null, "Each round"), h("dd", null, `${usd(c.contribution)} from every member, ${every(c.period_secs)}`),
    h("dt", null, "The pot"), h("dd", null, `${usd(potSize(c))} to one member each round, ${c.size} rounds`),
    h("dt", null, "Deposit to join"), h("dd", null, `${usd(c.contribution)}. It covers a payment you miss and comes back when the circle ends.`),
    h("dt", null, "Turn order"), h("dd", null, c.random_order ? "Drawn at random on chain once everyone has joined" : "The order people join"),
    h("dt", null, "Members"), h("dd", null, `${c.members.length} of ${c.size} joined`),
  );

  const go = async () => {
    await refresh();
    const already = (state.slots ?? []).find((s) => s.circles.includes(c.id));
    if (already) {
      await remember(already.index, { secret: encodeSecret(invite.secret), circle: c.id });
      location.hash = `#/c/${c.id}`;
      return;
    }
    const known = await local();
    const pending = Object.entries(known).find(([, l]) => l.pending?.kind === "join" && l.pending.circle === c.id);
    const index = pending ? Number(pending[0]) : await freshSlot(state.slots ?? []);
    await remember(index, { secret: encodeSecret(invite.secret), pending: { kind: "join", circle: c.id } });
    location.hash = `#/add/${index}`;
  };

  const join = h("button", { class: "primary" }, "Join this circle");
  join.addEventListener("click", () => {
    if (unlocked()) go().catch((e) => notice(e.message, "error"));
    else unlockScreen(() => go().catch((e) => notice(e.message, "error")), `You're joining ${name}.`);
  });

  const closed = c.status !== "Open" || left <= 0;
  show(
    h("section", { class: "stack narrow" },
      h("p", { class: "kicker" }, "You're invited to a savings circle"),
      h("h1", null, name),
      details,
      closed
        ? h("p", { class: "callout" }, c.status === "Open" ? "This circle is full" : `This circle ${c.status === "Active" ? "has already started" : "is closed"}. Ask the organizer about the next one.`)
        : h("div", { class: "actions" }, join),
      h("p", { class: "hint" }, `No collector holds the money: a contract on NEAR keeps it and pays each round's pot by itself. Open until ${when(Number(BigInt(c.fill_by) / 1_000_000n))} for members to join.`),
    ),
  );
}
