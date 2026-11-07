# Audit progress (WIP branch, not deployed)

Auditors done: 1 judge, 2 contract, 3 economics, 4 server, 5 on-chain, 6 claims, 8 integration. All 8 done (a7.md added).
Summaries: a1.md a2.md a3a4.md a5.md a6.md a8.md (this folder). Proof tests copied here too.

## Done on this branch (app/server, tested locally: 50/50 app tests, tsc 0)
- relay.js: global relay cap counted only after simulation (a1 H2, a4 #1) + test "requests NEAR Intents would reject don't use up the relayer's cap"
- limit.js: IP-hash salt from RELAYER_KEY, not the Upstash token (a6 M-3)
- wallet.js: confirmRecentPasskey before join and buying a turn (a6 M-6)
- cashout.js: FAILED no longer says "money came back" (a6 M-1)
- site.js: all sections visible to automated browsers and print (a1 M5); live-browser.mjs fails if any stay hidden
- deploy.js: lock checks NEAR Intents predecessor auth before/after (a5 F3); comment fix (a6 L-5); status.js reports it

## In progress: contract (NOT compiled yet; needs CI)
- Arrears: a member's misses not covered by their own deposit are held back from their own payout; repays backing first, rest shared to short-paid members at finish (a3 #1 CRITICAL). Own-round miss excused. Member.owed/backed, Circle.recovered/excused/held. MEMBER_BYTES 122. Borsh layout change => close circle 0 before upgrade.
## Next
- contract: anyone can cancel an Open circle with no members (a2 M-1); GAS_FOR_PAYOUT 60 (a2 L-1); lib.rs:315-319 comment (a1 L3, keep line count irrelevant now since redeploy); tests for all; reproducible build (a1 M6, a5 F5); keeper pages to circle_count (a3 #6)
- lock hardening: code-hash pin, rotate to fresh key first, is_account_locked (a2 L-2)
- server: bind tickets to signer+amount, single use (a4 #2); mirror on_auth checks (a4 #5, a3 #3); invite-only pre-check (a4 #4); psubmit ticket (a4 #7); swap-create allowShared (a4 #8); keeper single-flight + budget (a4 #6); min_gas total cap (a3 #13)
- app: credits claim button + discover gap 10 + count credits/other assets (a8 F2 F3); refunded-asset visibility/reclaim (a8 F1); TON cash-out warning (a8 F4); pay path checks contributed event (a8 F8); private move deadline cap (a8 F7)
- CI: persist-credentials false, pin cargo-near, token via env (a4 #3, #11)
- docs/copy: all a6 items, a5 F2 (Intents roles), README run-your-own, video link
- then re-run auditors 1, 2, 6, 7; then lock (needs "go"); then $2 run (private balance only), replace proof table
