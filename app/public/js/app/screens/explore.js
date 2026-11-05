// @ts-check
// Every circle on the contract, as anyone on the blockchain can see it: no
// names (they're encrypted), no people, just accounts, amounts and turns.
// Open without signing in, so anyone can check Contri is doing what it says.

import { potSize } from "../../lib/contri.js";
import { getConfig, views } from "../api.js";
import { ring } from "../ring.js";
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
      const center = h("span", null,
        h("span", { class: "big" }, c.status === "Open" ? `${c.members.length}/${c.size}` : c.status === "Active" ? `${c.round + 1}/${c.size}` : c.status === "Finished" ? "Done" : "Off"),
        h("span", null, c.status === "Open" ? "joined" : c.status === "Active" ? "round" : c.status.toLowerCase()),
      );
      return h("li", { class: `explore-card ${c.status.toLowerCase()}` },
        ring(c, null, center),
        h("div", { class: "stack tight" },
          h("h2", null, `Circle ${c.id}`),
          h("p", { class: "sub" }, `${usd(c.contribution)} ${every(c.period_secs)}, ${c.size} members, pot ${usd(potSize(c))}`),
          h("p", { class: "hint" }, `${c.payouts.length} of ${c.size} payouts made${c.payouts.length ? `, last on ${when(Number(BigInt(c.payouts[c.payouts.length - 1].at) / 1_000_000n))}` : ""}. ${c.invite_only ? "Invite only." : "Open to anyone."} ${c.random_order ? "Turns drawn at random." : "Turns in join order."}`),
        ),
      );
    });

  show(
    h("div", { class: "explore-page" },
      intro(),
      h("section", { class: "stack explore-list" },
        h("h2", { class: "rise-words section-words" }, ..."Every circle, as anyone can see it.".split(" ").map((w) => h("span", null, w))),
        h("p", { class: "lead" }, `Read straight from Contri's contract (${cfg.contractId || "not deployed yet"}). Names are encrypted, so you see what any stranger can: amounts, turns and payouts, by accounts that lead nowhere.`),
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
