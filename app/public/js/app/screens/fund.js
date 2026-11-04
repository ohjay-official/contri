// @ts-check
// Adding money to a circle account, then doing what it was for: creating a
// circle, joining one, or paying a round.
//
// Money arrives through 1Click: the member sends USDT (or USDC) on a chain
// their exchange or wallet supports to a one-time deposit address, and it
// lands as USDT in this circle's account on NEAR Intents.

import { toHex } from "../../lib/bytes.js";
import { actions, dueFor, findEvent, seatOf } from "../../lib/contri.js";
import { encryptName, inviteSigner, signJoin } from "../../lib/invite.js";
import { getCircle, getConfig, relay, sign, swap } from "../api.js";
import { nameOf, usd } from "../state.js";
import { busy, copy, h, notice, show, sleep } from "../ui.js";
import { balanceOf, decodeSecret, local, remember, signer } from "../wallet.js";

/** Networks shown first are the cheapest for small amounts. */
export const NETWORKS = [
  { id: "bsc", label: "BNB Smart Chain (BEP20)", symbol: "USDT", note: "Lowest fees for small amounts. Most exchanges support it." },
  { id: "sol", label: "Solana", symbol: "USDT", note: "Low fees." },
  { id: "ton", label: "TON", symbol: "USDT", note: "From Telegram wallets." },
  { id: "base", label: "Base", symbol: "USDC", note: "Arrives as USDT." },
  { id: "arb", label: "Arbitrum", symbol: "USDC", note: "Arrives as USDT." },
  { id: "tron", label: "Tron (TRC20)", symbol: "USDT", note: "Minimum about $2.60, and higher fees." },
  { id: "eth", label: "Ethereum (ERC20)", symbol: "USDT", note: "High network fees." },
];

/** @param {number} index the circle account (slot) */
export async function fundScreen(index) {
  const [cfg, known, s] = await Promise.all([getConfig(), local(), signer(index)]);
  const l = known[index] ?? {};
  const a = actions(cfg.contractId, cfg.tokenId);

  // What the money is for.
  /** @type {{ title: string, need: bigint, button: string, run: () => Promise<string> } | null} */
  let purpose = null;
  if (l.pending?.kind === "create") {
    const p = l.pending;
    const contribution = BigInt(p.contribution);
    purpose = {
      title: `Create ${p.name}`,
      need: contribution,
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
      title: `Join ${nameOf(id)}`,
      need: deposit,
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
        title: `Pay round ${round + 1} of ${nameOf(id)}`,
        need: BigInt(c.contribution),
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
      notice("Done.");
      location.hash = next;
    }),
  );

  const depositBox = h("div", { class: "deposit" });
  const networkList = h("div", { class: "networks", role: "radiogroup", "aria-label": "Network you're sending from" },
    NETWORKS.map((n, i) => {
      const input = /** @type {HTMLInputElement} */ (h("input", { type: "radio", name: "network", value: n.id, checked: i === 0 }));
      return h("label", { class: "choice" }, input, h("span", null, h("strong", null, `${n.symbol} on ${n.label}`), h("span", { class: "hint" }, n.note)));
    }),
  );
  const getAddress = /** @type {HTMLButtonElement} */ (h("button", { class: "secondary" }, "Get a deposit address"));

  let balance = 0n;
  let stopped = false;
  /** @type {string | null} */
  let depositAddress = null;

  const render = () => {
    balanceEl.textContent = usd(balance);
    const need = purpose ? purpose.need - balance : 0n;
    actionBtn.disabled = Boolean(purpose) && need > 0n;
    if (purpose && need <= 0n) progress.textContent = "Your money is here.";
  };

  getAddress.addEventListener("click", () =>
    busy(getAddress, "Getting an address", async () => {
      const network = /** @type {HTMLInputElement | null} */ (networkList.querySelector("input:checked"))?.value ?? "bsc";
      const want = purpose ? (purpose.need - balance > 0n ? purpose.need - balance : purpose.need) : 5_000_000n;
      const q = await swap("topup", { network, account: s.accountId, amount: want.toString() });
      depositAddress = q.depositAddress;
      depositBox.replaceChildren(
        ...[h("p", null, `Send at least `, h("strong", null, `${q.send} ${q.symbol}`), ` on `, h("strong", null, q.label), ` to:`),
        h("p", { class: "code-block", translate: "no" }, q.depositAddress),
        h("div", { class: "actions row" }, h("button", { class: "secondary", onclick: () => copy(q.depositAddress, "Address copied") }, "Copy address")),
        q.depositMemo ? h("p", null, "Memo, required: ", h("strong", { class: "code" }, q.depositMemo)) : null,
        h("p", { class: "hint" }, `Only send ${q.symbol} on ${q.label} to this address. Sending more is fine: the extra stays in your balance. It usually arrives about ${Math.max(1, Math.round(q.seconds / 60))} minute${q.seconds > 90 ? "s" : ""} after your exchange or wallet sends it. Use this address once, before ${new Date(q.deadline).toLocaleString()}.`)].filter((x) => x !== null),
      );
      progress.textContent = "Waiting for your deposit.";
      depositBox.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }),
  );

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
      h("h2", null, "Add money"),
      h("p", null, "Choose the network you're sending from. Withdrawing from an exchange works: pick the same network there."),
      networkList,
      h("div", { class: "actions" }, getAddress),
      depositBox,
      nearAccount,
    ),
  );

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
      }
    } catch {
      // Keep trying quietly; the next poll may work.
    }
    await sleep(5000);
    stopped = !screen?.isConnected;
  }
}

/** 1Click's swap states, in the member's words. @type {Record<string, string>} */
const STATUS = {
  PENDING_DEPOSIT: "Waiting for your deposit.",
  KNOWN_DEPOSIT_TX: "Your deposit is on its way.",
  INCOMPLETE_DEPOSIT: "Less arrived than this address needs. Check the amount you sent.",
  PROCESSING: "Deposit received. Converting it to USDT.",
  SUCCESS: "Arrived.",
  REFUNDED: "The deposit couldn't be converted and was refunded to this circle's account.",
  FAILED: "The deposit failed. Keep this deposit address: it is how the deposit can be traced.",
};
