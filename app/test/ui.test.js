// @ts-check
// What the app tells a member about a circle, for each state it can be in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { standing } from "../public/js/app/screens/home.js";
import { every } from "../public/js/app/state.js";

const NOW = Date.now();
const ns = (/** @type {number} */ ms) => String(BigInt(Math.round(ms)) * 1_000_000n);
const m = (/** @type {string} */ account_id, paid = false) => ({ account_id, deposit: "5000000", paid_this_round: paid, defaulted: false, missed: 0 });

/** @returns {any} */
function circle(/** @type {object} */ over) {
  return {
    id: 0, name: "", organizer: "a", contribution: "5000000", size: 3, period_secs: 86400, listings: [null, null, null],
    invite_only: true, random_order: false, fill_by: "0", backing: "0", backers: [], created_at: "0",
    started_at: ns(NOW - 3_600_000), round: 0, pot: "0", paying: false, payouts: [], round_deadline: ns(NOW + 82_800_000),
    status: "Active", members: [m("a"), m("b"), m("c")], ...over,
  };
}

test("an open circle says how many more people it needs", () => {
  assert.equal(standing(circle({ status: "Open", members: [m("a")], round_deadline: null }), "a").text, "Waiting for 2 more people to join");
  assert.equal(standing(circle({ status: "Open", members: [m("a"), m("b")], round_deadline: null }), "a").text, "Waiting for 1 more person to join");
});

test("a member who owes this round is asked to pay before the deadline", () => {
  const s = standing(circle({}), "b");
  assert.equal(s.tone, "due");
  assert.match(s.text, /^Pay \$5\.00 by /);
});

test("after paying, members see when their turn comes", () => {
  assert.equal(standing(circle({ members: [m("a", true), m("b"), m("c")] }), "a").text, "You receive $15.00 this round");
  assert.match(standing(circle({ members: [m("a"), m("b", true), m("c")] }), "b").text, /^Paid this round\. You receive \$15\.00 (tomorrow|in \d+ (hours|days))$/);
  assert.equal(standing(circle({ round: 1, members: [m("a", true), m("b"), m("c")] }), "a").text, "Paid this round. You've had your turn.");
});

test("a member who missed the deadline is told the deposit covers it", () => {
  const late = circle({ round_deadline: ns(NOW - 60_000) });
  assert.equal(standing(late, "c").tone, "due");
  assert.match(standing(late, "c").text, /deposit covers it/);
});

test("finished and cancelled circles", () => {
  assert.match(standing(circle({ status: "Finished", round_deadline: null }), "a").text, /^Finished/);
  assert.match(standing(circle({ status: "Cancelled", round_deadline: null }), "a").text, /^Cancelled/);
});

test("schedules read naturally", () => {
  assert.equal(every(86400), "every day");
  assert.equal(every(1209600), "every 2 weeks");
  assert.equal(every(600), "every 10 minutes");
  assert.equal(every(90), "every 90 seconds");
});
