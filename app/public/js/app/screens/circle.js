// @ts-check
// One circle: the ring, what you owe or receive, members, the turn market,
// payouts, and this circle's money.

import { actions, dueFor, needs, parseAmount, payoutDateMs, potSize, roundDeadlineMs, seatOf, shortAccount } from "../../lib/contri.js";
import { inviteLink } from "../../lib/invite.js";
import { getCircle, getConfig, keep, relay, sign, views } from "../api.js";
import { ring } from "../ring.js";
import { every, fromNow, nameOf, refresh, slotFor, usd, when } from "../state.js";
import { busy, copy, field, h, notice, show } from "../ui.js";
import { decodeSecret, labels, local, setLabel } from "../wallet.js";
import { standing } from "./home.js";

/** @param {number} id @param {boolean} openShare */
export async function circleScreen(id, openShare = false) {
  await refresh();
  const slot = slotFor(id);
  let c = await getCircle(id);
  if (!c) {
    show(h("section", { class: "stack narrow" }, h("a", { class: "back", href: "#/" }, "Your circles"), h("h1", null, "Circle not found"), h("p", null, "It may have been closed after everyone was paid back.")));
    return;
  }
  // A round past its deadline with someone unpaid, or deposits still to return:
  // ask the keeper to do it, then show the result.
  if (needs(c, Date.now())) {
    await keep(id);
    c = (await getCircle(id)) ?? c;
  }
  const deadline = roundDeadlineMs(c);

  const cfg = await getConfig();
  const a = actions(cfg.contractId, cfg.tokenId);
  const me = slot?.signer.accountId ?? null;
  const mySeat = me ? seatOf(c, me) : -1;
  const known = slot ? (await local())[slot.index] : undefined;
  const secret = known?.secret ? decodeSecret(known.secret) : null;
  const balance = slot?.balance ?? 0n;
  const isOrganizer = me !== null && c.organizer === me;

  /** Signs as this circle's account and relays, then reloads the screen. @param {object[]} intents @param {string} done */
  const act = async (intents, done) => {
    if (!slot) throw new Error("You're not in this circle.");
    const r = await relay([await sign(slot.signer, intents)]);
    if (!r.events.length && r.notes.length) throw new Error(r.notes[0]);
    notice(done);
    await circleScreen(id);
  };

  // ---- The ring's centre ----
  /** @type {HTMLElement} */
  let center;
  if (c.status === "Open") center = h("span", null, h("span", { class: "big" }, `${c.members.length}/${c.size}`), h("span", null, "joined"));
  else if (c.status === "Active") {
    const payee = c.members[c.round]?.account_id;
    center = h("span", null,
      h("span", { class: "big" }, usd(potSize(c))),
      h("span", null, payee === me ? "to you this round" : `to turn ${c.round + 1}`),
      h("span", { class: "small" }, deadline ? `round closes ${fromNow(deadline)}` : ""),
    );
  } else center = h("span", null, h("span", { class: "big" }, c.status === "Finished" ? "Done" : "Cancelled"), h("span", null, c.status === "Finished" ? `${c.size} rounds paid out` : "deposits returned"));

  // ---- What to do now ----
  const primary = [];
  if (me && c.status === "Active" && dueFor(c, me) === "pay") {
    if (balance >= BigInt(c.contribution)) {
      const pay = h("button", { class: "primary" }, `Pay ${usd(c.contribution)} for round ${c.round + 1}`);
      const round = c.round;
      pay.addEventListener("click", () => busy(pay, "Paying", () => act(a.contribute(id, round, c.contribution), "Paid")));
      primary.push(pay);
    } else {
      primary.push(h("a", { class: "button primary", href: `#/add/${slot?.index}` }, `Add money to pay ${usd(c.contribution)}`));
    }
  }
  // Reminders: the remaining round deadlines as a calendar file. Made on this phone; nothing is sent anywhere.
  if (me && mySeat >= 0 && c.status === "Active") {
    const cal = h("button", { class: "secondary", type: "button" }, "Add payment reminders to my calendar");
    cal.addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([calendar(c, nameOf(id), mySeat)], { type: "text/calendar" }));
      const a = h("a", { href: url, download: `contri-${id}.ics` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });
    primary.push(cal);
  }
  const share = secret && c.status === "Open" ? shareBox(nameOf(id), inviteLink(location.origin, id, secret), openShare) : null;

  // ---- Members in turn order ----
  const names = await labels();
  /** @param {string} account */
  const who = (account) => (account === me ? "You" : names[account] ?? shortAccount(account));
  /** Lets the member name someone, on this phone only. @param {string} account */
  const nameButton = (account) => {
    const btn = h("button", { class: "text small", type: "button" }, names[account] ? "Rename" : "Name");
    btn.addEventListener("click", () => {
      const input = h("input", { type: "text", maxlength: 40, value: names[account] ?? "", "aria-label": `Name for ${shortAccount(account)}` });
      const save = h("button", { class: "secondary", type: "submit" }, "Save");
      const form = h("form", { class: "name-form" }, input, save);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        await setLabel(account, input.value);
        await circleScreen(id);
      });
      btn.replaceWith(form);
      input.focus();
    });
    return btn;
  };
  const members = h("ol", { class: "members" },
    Array.from({ length: c.size }, (_, i) => {
      const m = c.members[i];
      if (!m) return h("li", { class: "member empty" }, h("span", { class: "who" }, "Open seat"));
      const tags = [];
      const paidOut = c.payouts.find((p) => p.round === i);
      if (paidOut) tags.push(h("span", { class: "tag good" }, `Received ${usd(paidOut.amount)}`));
      else if (c.status === "Active" && i === c.round) tags.push(h("span", { class: "tag strong" }, "Receives this round"));
      if (c.status === "Active") tags.push(m.paid_this_round ? h("span", { class: "tag good" }, "Paid") : h("span", { class: "tag due" }, "Not paid yet"));
      if (m.missed) tags.push(h("span", { class: "tag bad" }, `Missed ${m.missed}`));
      if (c.listings[i]) tags.push(h("span", { class: "tag" }, `For sale at ${usd(/** @type {string} */ (c.listings[i]))}`));
      return h("li", { class: `member${m.account_id === me ? " me" : ""}` },
        h("span", { class: "who", translate: "no" }, who(m.account_id), m.account_id === c.organizer ? h("span", { class: "role" }, "organizer") : null),
        m.account_id === me ? null : nameButton(m.account_id),
        h("span", { class: "tags" }, tags),
        h("span", { class: "deposit-note" }, `Deposit ${usd(m.deposit)}`),
      );
    }),
  );

  // ---- The turn market ----
  const market = [];
  if (me && c.status === "Active" && mySeat > c.round) {
    const listed = c.listings[mySeat];
    if (listed) {
      const unlist = h("button", { class: "secondary" }, "Take my turn off sale");
      unlist.addEventListener("click", () => busy(unlist, "Updating", () => act(a.unlistSeat(id, mySeat), "Your turn is off sale")));
      market.push(h("p", null, `Your turn (${mySeat + 1}) is for sale at ${usd(listed)}. Whoever buys it swaps turns with you and pays you that amount.`), unlist);
    } else {
      const price = /** @type {HTMLInputElement} */ (h("input", { type: "text", inputmode: "decimal", placeholder: "1" }));
      const list = h("button", { class: "secondary" }, "Put my turn up for sale");
      list.addEventListener("click", () => busy(list, "Listing", () => act(a.listSeat(id, mySeat, parseAmount(price.value)), "Your turn is for sale")));
      market.push(
        h("p", null, `You receive the pot in round ${mySeat + 1}, ${fromNow(payoutDateMs(c, mySeat) ?? 0)}. If you can wait, another member who needs cash sooner can buy your turn: you swap places and they pay you.`),
        field("Your price, in dollars", price),
        list,
      );
    }
    for (let i = Math.max(c.round, 0); i < mySeat; i++) {
      const p = c.listings[i];
      if (!p) continue;
      const buy = h("button", { class: "secondary" }, `Buy turn ${i + 1} for ${usd(p)}`);
      buy.addEventListener("click", () =>
        busy(buy, "Buying", async () => {
          if (balance < BigInt(p)) throw new Error(`Add ${usd(BigInt(p) - balance)} to this circle's account first.`);
          await act(a.buySeat(id, i, p), `Turn ${i + 1} is yours`);
        }),
      );
      market.push(h("p", null, `Turn ${i + 1} is for sale. Buying it moves you to round ${i + 1} and the seller to your round ${mySeat + 1}.`), buy);
    }
  }

  // ---- Leaving, cancelling ----
  const manage = [];
  if (me && c.status === "Open" && mySeat >= 0 && !isOrganizer) {
    const leave = h("button", { class: "text danger" }, "Leave this circle");
    leave.addEventListener("click", () => busy(leave, "Leaving", () => act(a.leave(id), "You left. Your deposit is back in your balance.")));
    manage.push(leave);
  }
  if (isOrganizer && c.status === "Open") {
    const cancel = h("button", { class: "text danger" }, "Cancel this circle");
    cancel.addEventListener("click", () => busy(cancel, "Cancelling", () => act(a.cancel(id), "Cancelled. Deposits are going back to members.")));
    manage.push(cancel);
  }

  // The member's seat NFT, drawn by the contract from the circle's live state.
  let seatNft = null;
  if (me && mySeat >= 0 && (c.status === "Active" || c.status === "Finished")) {
    const [token] = await views([{ contract: "contri", method: "nft_token", args: { token_id: `${id}:${mySeat}` } }]).catch(() => [null]);
    const media = token?.metadata?.media;
    if (typeof media === "string" && media.startsWith("data:image/svg+xml")) {
      seatNft = h("div", { class: "seat-nft" },
        h("img", { src: media, alt: `Your seat: turn ${mySeat + 1} of ${c.size}`, width: 120, height: 120 }),
        h("div", null,
          h("h2", null, "Your seat"),
          h("p", { class: "hint" }, `Turn ${mySeat + 1} is an NFT you own (token ${id}:${mySeat} on ${cfg.contractId}). The contract redraws it every round, and it changes hands when you sell your turn.`),
        ),
      );
    }
  }

  const s = me ? standing(c, me) : null;
  show(
    h("section", { class: "stack" },
      h("a", { class: "back", href: "#/" }, "Your circles"),
      h("h1", null, nameOf(id)),
      h("p", { class: "sub" }, `${usd(c.contribution)} ${every(c.period_secs)}, ${c.size} members, pot ${usd(potSize(c))}`),
      ring(c, me, center),
      s ? h("p", { class: `status ${s.tone}` }, s.text) : h("p", { class: "status quiet" }, "You're watching this circle; you're not a member."),
      primary.length ? h("div", { class: "actions" }, primary) : null,
      share,
      seatNft,
      h("h2", null, c.status === "Open" && c.random_order ? "Members" : "Members, in turn order"),
      h("p", { class: "hint" }, "Members show as account numbers. Name the ones you know: names stay on this phone."),
      c.status === "Open" && c.random_order ? h("p", { class: "hint" }, "Turns are drawn at random on chain when the circle is full, so these seat numbers will change.") : null,
      members,
      market.length ? h("div", { class: "stack" }, h("h2", null, "Swap turns"), market) : null,
      c.payouts.length
        ? h("div", { class: "stack" },
            h("h2", null, "Payouts"),
            h("ul", { class: "payouts" },
              c.payouts.map((p) =>
                h("li", null,
                  h("span", null, `Round ${p.round + 1}: ${usd(p.amount)} to ${p.to === me ? "you" : who(p.to)}`),
                  h("span", { class: "hint" }, when(Number(BigInt(p.at) / 1_000_000n)), BigInt(p.shortfall) > 0n ? `, ${usd(p.shortfall)} short` : ""),
                ),
              ),
            ),
          )
        : null,
      slot
        ? h("div", { class: "stack money" },
            h("h2", null, "This circle's money"),
            h("p", { class: "balance-line" }, "In your account for this circle: ", h("strong", { class: "amount" }, usd(balance))),
            h("p", { class: "hint" }, "Payouts and returned deposits land here. This account is used for this circle only, so it isn't linked to your other circles."),
            h("div", { class: "actions row" },
              h("a", { class: "button secondary", href: `#/add/${slot.index}` }, "Add money"),
              balance > 0n ? h("a", { class: "button secondary", href: `#/cash/${slot.index}` }, "Move money out") : null,
            ),
          )
        : null,
      manage.length ? h("div", { class: "actions" }, manage) : null,
    ),
  );
}

/** The invite link, with ways to send it. @param {string} name @param {string} link @param {boolean} open */
function shareBox(name, link, open) {
  const text = `Join my savings circle "${name}" on Contri: ${link}`;
  return h("details", { class: "share", open },
    h("summary", null, "Invite people"),
    h("p", null, "Anyone with this link can see the circle and join, so send it only to the people you're saving with. The part after # never reaches any server."),
    h("p", { class: "code-block", translate: "no" }, link),
    h("div", { class: "actions row" },
      h("a", { class: "button primary", href: `https://wa.me/?text=${encodeURIComponent(text)}`, target: "_blank", rel: "noopener noreferrer" }, "Send on WhatsApp"),
      h("button", { class: "secondary", onclick: () => copy(link, "Link copied") }, "Copy link"),
    ),
  );
}

/**
 * An iCalendar file with one event per remaining round: due 2 hours before the
 * deadline, with an alarm, and the member's own payout round marked.
 * @param {import("../../lib/contri.js").Circle} c @param {string} name @param {number} seat
 */
function calendar(c, name, seat) {
  const stamp = (/** @type {number} */ ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const start = Number(BigInt(c.started_at) / 1_000_000n);
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Contri//Savings circle//EN", "CALSCALE:GREGORIAN"];
  for (let r = c.round; r < c.size; r++) {
    const deadline = start + (r + 1) * c.period_secs * 1000;
    const due = Math.max(deadline - 2 * 3_600_000, start + r * c.period_secs * 1000);
    const yours = r === seat ? ` You receive ${usd(potSize(c))}.` : "";
    lines.push(
      "BEGIN:VEVENT",
      `UID:contri-${c.id}-${r}@contri`,
      `DTSTAMP:${stamp(Date.now())}`,
      `DTSTART:${stamp(due)}`,
      `DTEND:${stamp(deadline)}`,
      `SUMMARY:${name}: pay ${usd(c.contribution)} for round ${r + 1}`.replace(/[,;]/g, "\\$&"),
      `DESCRIPTION:Open Contri and pay before the round closes.${yours}`.replace(/[,;]/g, "\\$&"),
      "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT1H", "DESCRIPTION:Contri payment due", "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
