// @ts-check
// Every circle on the contract, as anyone on the blockchain can see it: no
// names (they're encrypted), no people, just accounts, amounts and turns.
// Open without signing in, so anyone can check Contri is doing what it says.

import { potSize } from "../../lib/contri.js";
import { getConfig, views } from "../api.js";
import { every, usd, when } from "../state.js";
import { h, show } from "../ui.js";

export async function exploreScreen() {
  show(h("section", { class: "stack" }, h("h1", null, "Live circles"), h("p", { class: "loading" }, "Reading the contract")));
  const cfg = await getConfig();
  /** @type {import("../../lib/contri.js").Circle[]} */
  const circles = [];
  for (let from = 0; ; from += 100) {
    const [page] = await views([{ contract: "contri", method: "get_circles", args: { from_index: from, limit: 100 } }]);
    circles.push(...page);
    if (page.length < 100) break;
  }
  const paidOut = circles.flatMap((c) => c.payouts).reduce((sum, p) => sum + BigInt(p.amount), 0n);
  const running = circles.filter((c) => c.status === "Active").length;

  const cards = circles
    .slice()
    .reverse()
    .map((c) => {
      const status = { Open: "Filling up", Active: "Running", Finished: "Finished", Cancelled: "Cancelled" }[c.status] ?? c.status;
      const last = c.payouts.length ? when(Number(BigInt(c.payouts[c.payouts.length - 1].at) / 1_000_000n)) : null;
      return h("li", { class: `explore-card ${c.status.toLowerCase()}` },
        dial(c),
        h("div", { class: "ec-body" },
          h("div", { class: "ec-top" }, h("h2", null, `Circle ${c.id}`), h("span", { class: `ec-status ${c.status.toLowerCase()}` }, status)),
          h("p", { class: "ec-pot" }, usd(potSize(c)), h("span", null, " pot")),
          h("p", { class: "ec-meta" }, `${usd(c.contribution)} ${every(c.period_secs)} · ${c.size} members`),
          h("ul", { class: "ec-tags" },
            h("li", null, c.invite_only ? "Invite only" : "Open to anyone"),
            h("li", null, c.random_order ? "Turns drawn at random" : "Turns in join order"),
            last ? h("li", null, `Last payout ${last}`) : null,
          ),
        ),
      );
    });

  show(
    h("div", { class: "explore-page" },
      intro(),
      h("section", { class: "stack explore-list" },
        h("h2", { class: "rise-words section-words" }, ..."Every circle, as anyone can see it.".split(" ").map((w) => h("span", null, w))),
        h("p", { class: "lead" }, `Read straight from Contri's contract (${cfg.contractId || "not deployed yet"}). Names are encrypted, so you see what any stranger can: amounts, turns and payouts, by accounts that don't name anyone.`),
        circles.length
          ? h("p", null, h("strong", null, `${usd(paidOut)}`), ` paid out so far across ${circles.length} circle${circles.length === 1 ? "" : "s"}, ${running} running now.`)
          : h("p", { class: "empty" }, "No circles yet"),
        h("ul", { class: "explore" }, cards),
      ),
    ),
  );
}

/**
 * The opening: a full-screen statement over a looping video, its words rising
 * in one after another.
 */
function intro() {
  const words = "Every turn paid by code, not by a collector.".split(" ");
  const heading = h("h1", { class: "rise-words" }, ...words.map((w, i) => {
    const span = h("span", null, w);
    span.style.setProperty("--delay", `${150 + i * 80}ms`);
    return span;
  }));
  const sub = h("p", { class: "rise" }, "Every circle on Contri, live from the blockchain. Scroll to see them.");
  sub.style.setProperty("--delay", "900ms");
  return h("section", { class: "video-intro" },
    h("video", { class: "video-bg", src: "/media/circles.mp4", poster: "/media/circles.jpg", autoplay: true, muted: true, loop: true, playsinline: true, "aria-hidden": "true" }),
    h("div", { class: "video-intro-copy" }, heading, sub),
  );
}

/**
 * A circle as a dial: one segment per turn, lit as turns are paid (or, while
 * it fills up, per member who has joined), the current turn pulsing, and a
 * ring of ticks turning slowly around it.
 * @param {import("../../lib/contri.js").Circle} c
 */
function dial(c) {
  const NS = "http://www.w3.org/2000/svg";
  const el = (/** @type {string} */ tag, /** @type {Record<string, string | number>} */ attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  const svg = el("svg", { viewBox: "0 0 120 120", class: "dial", "aria-hidden": "true" });
  const ticks = el("g", { class: "dial-ticks" });
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const r0 = i % 5 ? 56 : 54;
    ticks.append(el("line", { x1: 60 + r0 * Math.cos(a), y1: 60 + r0 * Math.sin(a), x2: 60 + 58 * Math.cos(a), y2: 60 + 58 * Math.sin(a) }));
  }
  svg.append(ticks);
  const n = Math.max(1, c.size);
  const lit = c.status === "Open" ? c.members.length : c.status === "Finished" ? n : c.status === "Active" ? c.round : 0;
  const R = 44, gap = n > 1 ? 0.12 : 0;
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + (i / n) * Math.PI * 2 + gap / 2;
    const a1 = -Math.PI / 2 + ((i + 1) / n) * Math.PI * 2 - gap / 2;
    const p = (/** @type {number} */ a) => `${(60 + R * Math.cos(a)).toFixed(2)} ${(60 + R * Math.sin(a)).toFixed(2)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d = n === 1 ? `M 60 ${60 - R} A ${R} ${R} 0 1 1 59.99 ${60 - R}` : `M ${p(a0)} A ${R} ${R} 0 ${large} 1 ${p(a1)}`;
    const cls = i < lit ? "seg lit" : c.status === "Active" && i === c.round ? "seg now" : "seg";
    const seg = el("path", { d, class: cls });
    seg.style.setProperty("--i", String(i));
    svg.append(seg);
  }
  const big = c.status === "Open" ? `${c.members.length}/${c.size}` : c.status === "Cancelled" ? "Off" : `${Math.min(c.payouts.length, c.size)}/${c.size}`;
  const label = c.status === "Open" ? "joined" : c.status === "Cancelled" ? "cancelled" : "turns paid";
  const t1 = el("text", { x: 60, y: 60, class: "dial-big", "text-anchor": "middle", "dominant-baseline": "central" });
  t1.textContent = big;
  const t2 = el("text", { x: 60, y: 80, class: "dial-small", "text-anchor": "middle" });
  t2.textContent = label;
  svg.append(t1, t2);
  return svg;
}
