// @ts-check
// The circle as a ring: one seat per member in turn order, clockwise from the
// top. The arc fills as rounds are paid out. Seats that already received the
// pot are solid, this round's seat is marked, and a green edge shows who has
// paid this round. Drawn from the contract's state only.

import { seatOf } from "../lib/contri.js";
import { h } from "./ui.js";

const NS = "http://www.w3.org/2000/svg";
const SIZE = 320;
const C = SIZE / 2;
const R = 122;

/** @param {string} tag @param {Record<string, string | number>} attrs @param {...SVGElement} children */
function s(tag, attrs, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

/**
 * @param {import("../lib/contri.js").Circle} c
 * @param {string | null} me the member's account in this circle
 * @param {HTMLElement} center what sits in the middle
 */
export function ring(c, me, center) {
  const n = c.size;
  const done = c.status === "Finished" ? n : c.status === "Active" ? c.round : 0;
  const nodeR = n <= 6 ? 20 : n <= 10 ? 16 : n <= 14 ? 13 : 10;
  const mine = me ? seatOf(c, me) : -1;
  const circumference = 2 * Math.PI * R;

  const svg = s(
    "svg",
    { viewBox: `0 0 ${SIZE} ${SIZE}`, class: "ring-art", "aria-hidden": "true" },
    s("circle", { cx: C, cy: C, r: R, class: "ring-track" }),
    s("circle", {
      cx: C, cy: C, r: R, class: "ring-progress",
      "stroke-dasharray": `${(circumference * done) / n} ${circumference}`,
      transform: `rotate(-90 ${C} ${C})`,
    }),
  );

  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    const x = C + R * Math.cos(angle);
    const y = C + R * Math.sin(angle);
    const m = c.members[i];
    const classes = ["seat"];
    if (!m) classes.push("empty");
    else if (i < done) classes.push("received");
    else if (c.status === "Active" && i === c.round) classes.push("current");
    if (m && c.status === "Active" && m.paid_this_round) classes.push("paid");
    if (i === mine) classes.push("you");
    if (c.listings[i]) classes.push("listed");
    if (i === mine) {
      const lx = C + (R + nodeR + 18) * Math.cos(angle);
      const ly = C + (R + nodeR + 18) * Math.sin(angle);
      svg.append(s("text", { x: lx, y: ly, class: "you-label", "dominant-baseline": "central", "text-anchor": "middle" }, /** @type {any} */ (document.createTextNode("You"))));
    }
    svg.append(
      s("g", { class: classes.join(" ") },
        s("circle", { cx: x, cy: y, r: i === c.round && c.status === "Active" ? nodeR + 4 : nodeR }),
        s("text", { x, y, "dominant-baseline": "central", "text-anchor": "middle", "font-size": Math.round(nodeR * 0.85) }, /** @type {any} */ (document.createTextNode(String(i + 1)))),
      ),
    );
  }

  return h("figure", { class: "ring" }, svg, h("figcaption", { class: "ring-center" }, center));
}
