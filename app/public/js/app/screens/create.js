// @ts-check
// Starting a circle: the rules, then the organizer's first contribution.

import { parseAmount } from "../../lib/contri.js";
import { MAX_NAME_BYTES, newSecret } from "../../lib/invite.js";
import { utf8 } from "../../lib/bytes.js";
import { every, state, usd } from "../state.js";
import { field, h, notice, show } from "../ui.js";
import { encodeSecret, freshSlot, remember } from "../wallet.js";

const PERIODS = [
  ["86400", "Every day"],
  ["604800", "Every week"],
  ["1209600", "Every 2 weeks"],
  ["2592000", "Every 30 days"],
  ["600", "Every 10 minutes (to try it out)"],
];

export function createScreen() {
  const name = /** @type {HTMLInputElement} */ (h("input", { type: "text", maxlength: 60, autocomplete: "off", required: true, placeholder: "Yaba traders" }));
  const amount = /** @type {HTMLInputElement} */ (h("input", { type: "text", inputmode: "decimal", autocomplete: "off", required: true, placeholder: "5" }));
  const size = /** @type {HTMLSelectElement} */ (h("select", null, Array.from({ length: 19 }, (_, i) => h("option", { value: i + 2, selected: i + 2 === 5 }, String(i + 2)))));
  const period = /** @type {HTMLSelectElement} */ (h("select", null, PERIODS.map(([v, label]) => h("option", { value: v }, label))));
  const joinOrder = /** @type {HTMLInputElement} */ (h("input", { type: "radio", name: "order", value: "join", checked: true, id: "order-join" }));
  const randomOrder = /** @type {HTMLInputElement} */ (h("input", { type: "radio", name: "order", value: "random", id: "order-random" }));
  const summary = h("p", { class: "summary", "aria-live": "polite" });

  const update = () => {
    let a;
    try {
      a = parseAmount(amount.value || "0");
    } catch {
      summary.textContent = "";
      return;
    }
    const n = Number(size.value);
    const secs = Number(period.value);
    summary.textContent = a > 0n
      ? `Each round, one member receives ${usd(a * BigInt(n))}. The circle runs ${n} rounds, ${every(secs)}. Everyone puts down ${usd(a)} as a deposit when they join, which comes back at the end.`
      : "";
  };
  for (const el of [amount, size, period]) el.addEventListener("input", update);

  const form = h("form", { class: "stack", novalidate: true },
    field("Circle name", name, "Only people with your invite link can read it. It's encrypted on this phone before it's saved."),
    field("Amount each member pays per round, in dollars (USDT)", amount),
    field("Number of members, including you", size),
    field("How often", period),
    h("fieldset", { class: "choices" },
      h("legend", null, "Who receives the pot first"),
      h("label", { class: "choice" }, joinOrder, h("span", null, h("strong", null, "In the order people join"), h("span", { class: "hint" }, "You join first, so you receive first."))),
      h("label", { class: "choice" }, randomOrder, h("span", null, h("strong", null, "Drawn at random"), h("span", { class: "hint" }, "Contri draws the order on chain once everyone has joined. Nobody can pick it."))),
    ),
    summary,
    h("div", { class: "actions" }, h("button", { class: "primary", type: "submit" }, "Continue")),
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const n = name.value.trim();
      if (!n) throw new Error("Give the circle a name.");
      if (utf8(n).length > MAX_NAME_BYTES) throw new Error("That name is too long.");
      const contribution = parseAmount(amount.value);
      if (contribution < 1_000_000n) throw new Error("The amount each round has to be at least $1.");
      const index = await freshSlot(state.slots ?? []);
      await remember(index, {
        secret: encodeSecret(newSecret()),
        pending: { kind: "create", name: n, contribution: contribution.toString(), size: Number(size.value), periodSecs: Number(period.value), random: randomOrder.checked },
      });
      location.hash = `#/add/${index}`;
    } catch (err) {
      notice(err instanceof Error ? err.message : String(err), "error");
    }
  });

  show(
    h("section", { class: "stack narrow" },
      h("a", { class: "back", href: "#/" }, "Your circles"),
      h("h1", null, "Start a circle"),
      form,
    ),
  );
}
