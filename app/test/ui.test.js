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

test("an app's built-in browser is told apart from Chrome and Safari", async () => {
  const { inAppBrowser } = await import("../public/js/lib/support.js");
  const real = [
    "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ];
  const inApp = [
    "Mozilla/5.0 (Linux; Android 14; SM-A546E; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; SM-A546E; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.0;]",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  ];
  for (const ua of real) assert.equal(inAppBrowser(ua), false, ua);
  for (const ua of inApp) assert.equal(inAppBrowser(ua), true, ua);
});

test("an invite says what the circle is before the link", async () => {
  const { inviteMessage } = await import("../public/js/app/screens/circle.js");
  const c = circle({ contribution: "1000000", size: 2, period_secs: 600 });
  assert.equal(inviteMessage(c, "Test"), 'Join my savings circle "Test" on Contri: $1.00 every 10 minutes, 2 members, pot $2.00. Tap to join:');
});
