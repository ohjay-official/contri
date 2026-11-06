# Contri security audit

Date: 2026-11-05. Target: `circles.contring.near` (NEAR mainnet), repo at `/home/claude/contri` as of this afternoon (contract `contract/src/lib.rs` unchanged during the audit; server files re-read after the `oneclick.js` / lock changes).

Scope: the contract, the relayer, keeper, 1Click and private-balance server code, the app's key, session and invite handling, CSP, and the deploy, lock and CI workflows. Reference for NEAR Intents behaviour: `near/intents` at `d340060` (the commit the sandbox CI uses), read from source.

## On-chain state when audited (block 223162501, read-only RPC)

| | |
|---|---|
| `circles.contring.near` balance | 1.07751 NEAR |
| storage used | 101,007 bytes = 1.01007 NEAR locked, so **6,744 bytes of headroom (0.0674 NEAR)** |
| access keys on the contract | one FullAccess key, `ed25519:8ikg3ZpEFprsK79HQUwWA4MBKsnWQAoCejoJDcDEyK3x` |
| access keys on `contring.near` (relayer/keeper) | the **same** single FullAccess key `ed25519:8ikg3...` |
| relayer balance | 0.598 NEAR |
| contract USDT on intents.near | 0 (circle_count 1) |
| intents.near `public_keys_of(circles.contring.near)` | `[]` |

## Summary

| ID | Severity | Finding | Confirmed |
|---|---|---|---|
| C-1 | CRITICAL | Users never pay for storage. About 12 spam circles (0.000001 USDT each, gas paid by Contri's relayer) use up the headroom. After that, every payout callback fails *after the money has been sent*, `paying` stays true forever, and the circle and all its deposits are frozen. It also happens without an attacker. | Unit tests + real-runtime sandbox |
| H-1 | HIGH | A zero pot sends an `mt_transfer` of 0, which intents.near always rejects. The circle stalls for good, and each keeper run retries it and burns gas (public `GET /api/keeper`, plus a GitHub cron every 10 minutes). | Unit + JS tests, intents source |
| H-2 | HIGH | The relayer pays 300 Tgas for any `auth_call` to Contri from a fresh, unfunded key, and for transfers of any token to any account. It has no rate limit. A few hundred requests drain it, and then nobody can pay or be settled on time. | JS test |
| H-3 | HIGH | The contract's only upgrade key is the relayer's hot key, held in Vercel's runtime and in GitHub Actions jobs that run unpinned third-party installers alongside `VERCEL_TOKEN`. Compromising any of them lets an attacker redeploy and take all the USDT. | On chain + workflows |
| M-1 | MEDIUM | Anyone with the invite link signs their own join, so they choose their own deposit (1 unit up to (size-1) contributions). This confirms the claims reviewer's finding. | Unit + JS tests |
| M-2 | MEDIUM | Backing is split by the amount each backer put in, not by shares. A late backer pays for losses that happened before they joined, and an early backer working with a defaulter can extract money from a later backer. | Unit test |
| M-3 | MEDIUM | Deadlines are absolute. After a late settle, the next round is already past its deadline and anyone can settle it at once, before anyone could pay. Every deposit is drained and every member is recorded as defaulted. | Unit test |
| M-4 | MEDIUM | `/api/swap` is an open, unthrottled proxy for Contri's 1Click partner key, including confidential routing, which only works with that key. | Code review |
| L-1..L-6 | LOW | Full-scan views; the phone does not check destinations; a seat purchase can bypass deposit protection; ICS injection; keeper starvation; duplicate sends from retries | see below |
| I-1..I-8 | INFO | | |

**Do not run the `[lock]` workflow before fixing C-1 and H-1.** A locked contract makes both freezes permanent, and the deploy key is currently the only way to rescue a frozen circle (by upgrading).

---

## CRITICAL

### C-1. The contract pays for all storage and keeps no reserve. Spam, or ordinary growth, makes payout callbacks fail after the transfer, which freezes circles permanently

**Where**
- `contract/src/lib.rs:934`: the only lower bound on a circle is `contribution > 0`, so 1 unit (0.000001 USDT) is accepted.
- `lib.rs:920-978` (`internal_create`), `:980-1039` (`internal_join`), `:1119-1146` (`internal_back`): user-triggered storage growth with no fee and no reserve check. The intents path pays nothing. The direct `create_circle` takes `CREATE_FEE` = 0.01 NEAR (`:61`), but a full circle needs up to about 0.068 NEAR.
- `lib.rs:1262-1269` `start_payout` saves `paying = true`, then `lib.rs:1290-1334` `finalize_payout` (the `on_payout` callback) **grows storage**. It pushes a `PayoutRecord` (`:1310`, about 112 B) and, in the last round, creates a `Record` for every member (`:1319-1328`, about 117 B each).
- `lib.rs:811`, `:849`, `:1046`, `:1079`, `:861-864`, `:1230-1238`: every way out requires `!paying` or a finished or cancelled status. Nothing can clear a stuck `paying`.
- `lib.rs:854-857` `add_credit` (from `on_sent`) also grows storage. When the contract has no room, the credit for a failed transfer cannot be stored, and that money becomes unaccounted for.

**Scenario (attacker).** The attacker funds one throwaway implicit account with a few micro-USDT on intents.near. It signs `create:1:20:60:join:-:<256 bytes>` transfer intents and submits them through `/api/relay`, so Contri pays the gas. Each one costs Contri about 585 bytes. About 12 of them consume the 6,744-byte headroom. Sybil joins (about 90 B each) then fill what is left until headroom is below about 90 B.

From then on, contributions and `settle_round` still succeed because they do not grow storage. The last contribution of every round calls `start_payout`. The `mt_transfer` to the recipient succeeds and the pot leaves. Then `on_payout` needs at least 112 B and fails with `LackBalanceForState`. Its state change is reverted, so `paying` stays `true` and `round` never advances. The circle can no longer be contributed to, settled, paid, released, cancelled or closed. The pot was paid, but **every other member's deposit, plus any backing, is frozen.** Topping up NEAR afterwards does not help, because the callback is gone. Only a contract upgrade can recover it, and that becomes impossible after `[lock]`. The attacker can keep headroom pinned near zero indefinitely. The cost to the attacker is micro-USDT, which they get back by cancelling and releasing.

**Scenario (no attacker).** A single 20-member circle grows by 6,811 B over its life. The final `on_payout` alone adds 2,452 B, which is more than the whole headroom. The first large real circle would freeze in its last round. A 5-member circle uses 2,011 B, so the current balance holds 3 of them. Contract rewards (30% of the gas Contri burns) add roughly 10 to 20 B per receipt. That offsets part of the organic growth, but not spam and not the 2.4 KB final callback.

**Confirmed**
- Unit tests (`audit_spam_circles_brick_storage`, `audit_one_real_twenty_member_circle_outgrows_the_headroom`, `audit_five_member_circle_storage`, `audit_paying_flag_has_no_recovery`). Output:
  - `585 bytes per spam circle; 12 circles exhaust 6744 bytes of headroom`
  - `20-member circle uses 2231 B when full, 6811 B by the end; the final on_payout callback alone adds 2452 B`
  - `paying stuck: 30000000 units frozen with no way out`
- **Real NEAR runtime** (near-sandbox 2.14.0, Contri wasm built from this source, intents.near replaced by a mock that implements `mt_transfer` and delivers `mt_on_transfer`; test `storage_spam_freezes_a_running_circle_forever`). The account was trimmed to mainnet's headroom. Results:
  - Creates fail after 11 spam circles (`LackBalanceForState`); headroom ends at 30 bytes.
  - On the victim's last payment, `mt_transfer` ran (the pot left) and then `on_payout` failed with `LackBalanceForState`. The circle shows `paying=true, round=4, status=Active`.
  - After a **2 NEAR top-up**, `settle_round`, `pay_out` and `release_deposits` all still fail. The circle stays frozen holding 25 USDT of deposits.

**Minimal fix**
1. **Now:** send 2 to 5 NEAR to `circles.contring.near`. This buys time against organic growth only.
2. **Code:** make the callbacks storage-neutral, so they can never fail on storage:
   - When a circle starts, pre-fill `payouts` with `size` placeholder records and overwrite them in place in `finalize_payout`.
   - Move the `Record` writes out of `finalize_payout` and into `release_deposits`, which is user-triggered and can safely fail and be retried.
3. **Code:** add a reserve guard to every user-triggered path that grows storage (create, join, back by a new backer). Refuse, which refunds the transfer, when `env::account_balance() < (env::storage_usage() + worst_case_bytes) * env::storage_byte_cost() + RESERVE`. Use the circle's maximum size as the worst case for create, and roughly 0.25 to 0.5 NEAR as `RESERVE`.
4. **Code:** set a real minimum contribution (for example `>= 1_000_000`, $1, which the UI already enforces) and cap open circles per organizer.

---

## HIGH

### H-1. A zero pot never pays out: the circle stalls for good and the keeper burns gas on it forever

**Where:** `lib.rs:823-843` (`internal_settle`) adds `min(deposit, contribution)` and backing to the pot. When every member is unpaid and has no deposit or backing left, the pot is 0, and `start_payout` (`:1262`) still sends `mt_transfer` with `amount: "0"`. intents.near rejects zero amounts unconditionally (`defuse/src/contract/tokens/nep245/core.rs`, `internal_mt_batch_transfer`: `if amount == 0 { return Err(DefuseError::InvalidIntent) }`). `on_payout` then sees `Failed`, clears `paying`, and keeps `round`. Since every member is marked `paid_this_round`, `pay_out` is always allowed and always fails. In `app/public/js/lib/contri.js:138`, `needs()` returns `"pay_out"` for this circle on every keeper run.

**Scenario:** two sybils make a circle with contribution 1 and period 60 seconds (relayed for free), then never pay. Round 0 settles from their deposits. In round 1 the pot is 0, and the circle is stuck permanently. Each `GET /api/keeper` (public, no authentication) sends up to 10 `pay_out` transactions (100 Tgas each) signed by `contring.near`. The GitHub `keeper.yml` cron does the same every 10 minutes. Ten such circles also fill `todo.slice(0, 10)` (`server/keeper.js:285`) whenever their ids come first, which starves real circles of settles and releases. Any refill or backing sent to the stuck circle is trapped. This also happens naturally in an abandoned circle.

**Confirmed:** unit test `audit_zero_pot_payout_loops_forever` (5 consecutive zero-amount `mt_transfer` attempts; afterwards refill and back are still accepted and trapped). JS test `AUDIT keeper` (10 stuck circles produce 10 `pay_out` transactions per `keep()` call: 30 transactions over 3 calls).

**Minimal fix:** in `start_payout`, when `c.pot.0 == 0`, close the round without a transfer. Save the circle and call `self.finalize_payout(id, round, U128(0), true)` inline, which records the full shortfall. Skip zero-amount `send`s as well (they are already skipped in release and leave). In the keeper, stop retrying a circle after N failed `pay_out` attempts, and do not let failing circles occupy the 10 slots.

### H-2. The relayer and keeper can be drained for free, which blocks all payments and leads to mass defaults

**Where:** `app/server/relay.js:67-86` (`checkIntent`) and `:94-134` (`relay`); `app/api/relay.js`; `app/api/keeper.js:7`. There is no rate limit, no proof of membership and no balance check. `execute_intents` is always sent with 300 Tgas (`relay.js:114`).
- `auth_call` to Contri with **any** `msg` is relayed. An implicit account needs no funds, and `simulate_intents` passes.
- A `transfer` without `msg` is relayed for **any token to any receiver** (`relay.js:76-80`). Contri becomes a free gas station for NEAR Intents.
- Each request can carry 2 payloads of 2 intents each.

**Scenario:** a script generates fresh keys and posts `{signed:[authCall(contri,"x")..]}` in a loop. Each request costs `contring.near` the burnt gas plus NEP-536's refund penalty on 300 Tgas prepaid, roughly 0.002 to 0.005 NEAR. So 0.598 NEAR lasts a few hundred requests. Once the account is empty:
- Members, who hold no NEAR, cannot pay.
- The keeper, which uses the same account, cannot settle.
- When deadlines pass, anyone with NEAR calls `settle_round`. Deposits are consumed, every member is recorded as defaulted, and recipients receive short pots (shortfall). This is made worse by M-3.

The attacker can also use the free relayer to run C-1 and H-1.

**Confirmed:** JS test `AUDIT relayer`. 40 requests from 40 fresh, unfunded keys each turned into an `execute_intents` signed by the relayer. A transfer of `nep141:any-token.near` to `someone-else.near` was relayed too.

**Minimal fix:**
- Rate-limit `/api/relay` and `/api/keeper` per IP and per signer (Vercel Firewall rate-limit rules, or KV).
- Relay only:
  - (a) transfers of `c.tokenId` to Contri, with a `msg` that parses under Contri's grammar;
  - (b) transfers of `c.tokenId` to a 1Click deposit address this server issued in the last 30 minutes (keep an HMAC ticket from `/api/swap`);
  - (c) `auth_call`s whose `msg` parses and whose signer is a member or organizer of that circle (one `get_circle` view).
- Lower the gas to what is needed (about 100 Tgas).
- Alert when the balance drops below a threshold, and keep the keeper on a separate account.

### H-3. The contract's upgrade key is the relayer's hot key, exposed to the serverless runtime and to unpinned CI installers

**Where:**
- On chain, both `circles.contring.near` and `contring.near` hold the single FullAccess key `ed25519:8ikg3ZpE...`.
- `app/scripts/deploy.js:29` uses `RELAYER_KEY` as the deploy key, and `:83` (`addFullAccessKey: parent.publicKey`) gives the contract the relayer's key.
- `RELAYER_KEY` is copied into Vercel's production env (`app/scripts/vercel.js`, `SETTINGS`), so every `/api/*` function runtime holds the contract's upgrade key.
- `.github/workflows/keeper.yml` runs with `RELAYER_KEY` every 10 minutes.
- `.github/workflows/web.yml:33` puts `VERCEL_TOKEN` in workflow-wide env, and the same job runs `npm install -g vercel@latest` (`:74`), `npm install` with no lockfile (`:137`), and `npx playwright install --with-deps`.
- `deploy.yml` and `contract.yml` pipe `cargo-near` `latest/download/...installer.sh` into `sh`.

**Scenario:** any of these can be used to steal all the contract's USDT: a malicious or compromised npm package or CLI release in that job (which sees `VERCEL_TOKEN`, deploys a function and reads `RELAYER_KEY`), a Vercel account or project compromise, a leaked Actions secret, or a compromised `cargo-near` installer. The attacker deploys new code to `circles.contring.near` and transfers the contract's USDT out through intents. This is not an outsider exploit on its own, but it is one supply-chain step away, and the key sits in an internet-facing runtime.

**Minimal fix (before users join):**
1. Add a new FullAccess key held offline (hardware wallet) to `circles.contring.near`, and delete `ed25519:8ikg3...` from it.
2. Rotate `contring.near`'s key, so the relayer's key can only sign for `contring.near`.
3. Keep `CONTRI_DEPLOYER_KEY` only in the deploy step.
4. Move `VERCEL_TOKEN` into the single deploy step's env.
5. Pin the `vercel` and `cargo-near` versions (with checksums) and commit `package-lock.json`.
6. Lock only after C-1 and H-1 are fixed and redeployed. The improved lock script, which deletes every key and checks `public_keys_of` on intents, is correct.

---

## MEDIUM

### M-1. An invitee picks their own deposit (confirming the claims reviewer)

**Where:** `lib.rs:994-1002` accepts any `amount <= max_deposit()` (that is, up to `(size-1)·contribution`) that is signed by the invite key. In `app/public/js/lib/invite.js:25-27` and `:73-76`, the invite **signing** key is `HKDF(link secret)`, so everyone holding the link holds it. `app/public/js/app/screens/fund.js:103` shows the joiner signs their own `join_message`. Every circle the app creates is invite-only (`fund.js` always passes `inviteKeyHex`).

**Scenario:** Mallory receives the link and signs `contri-join:<contract>:<id>:<her account>:1`. She joins with a 0.000001 USDT deposit, while the UI tells everyone the deposit is one contribution. When she defaults, her deposit covers nothing, and the recipient's pot is short by a full contribution for each round she misses. The contract's comment that the organizer chooses the deposit (`lib.rs:384-389`) cannot be true with a shared key.

**Confirmed:** contract test `audit_invitee_chooses_own_deposit` (joins with deposit 1). JS test `AUDIT invite` (the link secret signs valid joins for deposits of 1, 5,000,000 and 95,000,000).

**Minimal fix:** in the invite branch, require `amount >= c.contribution.0`, or `== contribution` to match the UI. If per-person deposits are still wanted, have the organizer sign each joiner's message with a key that is **not** in the link.

### M-2. Backing pays back by amount put in, so late backers absorb earlier losses

**Where:** `lib.rs:1421-1436` (`close_backing` splits what is left by `b.amount`), and `:1119-1146` (`back` is allowed while a circle is Active, after losses).

**Scenario:** a coop backs 10, and a default uses 5 of it. A DAO then backs 100. At the end, 105 is left and it is split 10:100. The coop gets 9.55 back when its fair share is 5, and the DAO gets 95.45 back after a 100 deposit even though nothing was lost after it joined. An attacker can be the early backer and work with a member who defaults (or default themselves after taking an early pot). They then recover the loss from any DAO that backs later, for example through the Trezu integration.

**Confirmed:** unit test `audit_late_backer_pays_for_earlier_losses`: `coop ... gets 9545455; DAO put 100 ... gets 95454545`.

**Minimal fix:** use share accounting. On `back`, mint `shares = backing == 0 ? amount : amount * total_shares / backing`, and in `close_backing` split by shares. Alternatively, refuse new backing once any backing has been used.

### M-3. Absolute round deadlines let a late settle make the next round instantly settleable

**Where:** `lib.rs:230-232`: `round_deadline = started_at + (round+1)·period`, which does not depend on when the round actually opened. `:812` lets anyone settle once that time has passed.

**Scenario:** round r is settled late. The keeper may be down or drained (H-2), or GitHub cron may run late. With 10-minute periods, a delay longer than one period is common. Round r+1 opens already past its deadline, and anyone settles it in the next block. Every unpaid member's deposit is taken, everyone is recorded as defaulted, and once deposits run out the recipient gets a short pot. Members never had a chance to pay.

**Confirmed:** unit test `audit_late_settle_makes_next_round_instantly_settleable` (round 1 was settled 1 second after it opened, and all members are marked defaulted).

**Minimal fix:** store `round_opened_at`, set when the circle starts and in `finalize_payout`. Use `deadline = max(started_at + (round+1)·period, round_opened_at + period)`, or at least `round_opened_at + max(period/2, 1h)`.

### M-4. `/api/swap` is an open proxy for Contri's 1Click partner key

**Where:** `app/api/swap.js:23-27`; `app/server/oneclick.js:70` (`confidentiality: "basic"` only when the key is set), `:78`, `:118`; `app/server/confidential.js:102`, `:142`, `:190`, `:208`. Every action accepts any account or vault and any amount. There is no authentication and no rate limit, and `dry: false` creates real deposit addresses.

**Scenario:**
- Anyone gets Contri-keyed confidential deposit routes for their own accounts, which is a free anonymizing on-ramp and off-ramp attributed to Contri's partner key.
- Anyone can flood quotes until 1Click rate-limits or revokes the key. Then every member's top-ups and cash-outs fail, members cannot fund payments, and missed rounds follow (see M-3).

**Minimal fix:** rate-limit `/api/swap` per IP. Require a signature from the circle or vault account named in the request (a NEP-413 payload the server checks, like `psignin`) before spending the key. Cap amounts, and keep a short-lived record of issued deposit addresses, which also feeds the relayer allowlist in H-2.

---

## LOW

**L-1. Views scan every circle** (`lib.rs:635-642` `get_circles_for`, `:762-779` `circles`/`each_seat`, used by `nft_*`). In the sandbox this cost about 0.095 Tgas per small circle (5.3 Tgas with 41 circles), more for full ones. RPC view limits break `get_circles_for` at roughly 1,000 to 3,000 circles, and the app's `discover()` (`wallet.js`) depends on it to find a member's accounts. Today C-1 caps the number of circles first. Fix: keep a per-account index (`"a"+account -> Vec<u64>`) updated on join, leave and buy, and page the NFT views by circle.

**L-2. The phone does not check destinations.** In `lib/private.js:20-44`, `checkPrivateMove` binds signer, token, amount, a single intent and no call. But `depositAddress` comes from the same `/api/swap` response (`app/private.js` `moveOut`), and `payload.recipient` and `payload.nonce` are never checked. Signed moves can be valid for 7 days. `moveHome`, direct cash-outs and top-ups trust server-supplied addresses entirely. The server or 1Click can redirect any move to a 64-hex account of their choosing (JS test `AUDIT private move`). Because the same server ships the app's JavaScript, this adds no new trust. However, the claim "the phone checks each intent" does not cover the destination. Fix: return and verify 1Click's quote signature over `{depositAddress, recipient, amountIn}`, check `payload.recipient` against the expected private-ledger verifier, and cap validity at about 30 minutes.

**L-3. A seat purchase can bypass deposit protection** (`lib.rs:1074-1117`). A member with a low deposit can buy the current or earliest seat, take the pot, and default on the rest. Deposits belong to the person, not the seat. This is mostly a design issue, made worse by M-1. Fix: require the buyer's deposit to cover the rounds left after their new seat, or disable sales into the current round.

**L-4. ICS injection through the circle name** (`screens/circle.js:303-325`). The decrypted name, which the organizer controls, goes into `SUMMARY:` with only `,` and `;` escaped. CR/LF can inject `URL:`, `ATTACH:` or alarm text into members' calendars. Fix: strip `\r\n` and escape `\\` as RFC 5545 requires.

**L-5. Public `GET /api/keeper`** runs a full `get_circles` scan and up to 10 transactions on every call. This is covered by the H-1 and H-2 fixes (rate limit, failure back-off).

**L-6. Retries can send a transaction twice.** `lib/near.js` resends the same signed transaction to the next endpoint after a 5xx, and `sendTransaction` re-signs with a new nonce on `InvalidNonce`. If the first send actually executed, the action is sent again. NEAR Intents nonces and contract guards make the second one fail, so only gas is wasted. Fix: after a 5xx or timeout, query `tx` status by hash before re-signing.

## INFO

- I-1. `close_backing` computes `left * b.amount` (`lib.rs:1430`) in u128. This is safe for USDT's supply. With an 18-decimal token it could overflow inside `on_payout` and trigger the C-1 freeze. Use a `mul_div` or u256 if `token_id` ever changes.
- I-2. `on_auth` is not payable. Direct intents users who attach wNEAR to an AuthCall lose it (NEAR Intents does not refund it). The relayer already refuses attached deposits.
- I-3. Randomness comes from `env::random_seed_array()` inside the join that fills the circle. The joiner cannot make the join depend on the draw. Only block or chunk producers could bias it, which is acceptable at these stakes.
- I-4. The sealed session (`lib/session.js`) only protects against copying storage off the device. Any script on the same origin can unseal it. I found no XSS sinks: `h()` builds text nodes, there is no `innerHTML` or `eval`, and attributes come only from constants or numeric ids. The CSP is strict (`script-src 'self'`, no inline code, `connect-src 'self'`, `frame-ancestors 'none'`). In device-key mode the secret is stored in plaintext in localStorage until Lock, which now removes it.
- I-5. `CREATE_FEE` (0.01 NEAR) underfunds a full circle (up to about 0.068 NEAR). See C-1.
- I-6. On-chain `Record`s can be farmed with sybil circles. Do not treat them as reputation.
- I-7. Contract rewards (30% of burnt gas) slowly add NEAR. This offsets part of normal use but is far below the spam rate in C-1.
- I-8. Passkey PRF secrets are bound to the rpId (the domain). A passkey created on a `*.vercel.app` alias gives different keys from one on `contri.ng`. Serve the app from only one origin.

---

## Checked and found sound

- **`mt_on_transfer`.** It requires `predecessor == intents_id` (`lib.rs:888-890`), exactly one token equal to `token_id` (anything else is refunded in full), and a strictly parsed `msg`. Every `Err` path returns before any state is written, and the full `amount` is refunded. The refund semantics match intents `mt_resolve_transfer` at d340060: it refunds `min(returned, amount, receiver balance)`, a panic refunds everything, and `["0"]` keeps the payment. No path refunds and also credits, so a refund can be neither claimed twice nor lost. A different predecessor or token cannot credit anyone.
- **`on_auth`.** It takes the intents-verified `signer_id` and the same predecessor check. Every action checks ownership.
- **Payout integrity.** `paying` serializes payouts. `finalize_payout` checks the round, and only an explicit `Failed` keeps the pot (a success value of any length counts as paid), so there is no double payout. A failed transfer keeps the pot for `pay_out` to retry. The recipient is `members[round]` at both start and finish, and seats cannot be swapped while `paying`. The gas is sufficient: the final-round `on_payout` for a 20-member circle burns 5.20 of its 15 Tgas (sandbox).
- **Pot and deposit accounting.** Per circle, money held = `pot + Σ deposits + backing + Σ backer.due`, and every path keeps it balanced: join, contribute, settle, back, refill, payout, release, leave, cancel. `close_backing` hands out exactly what is left, with rounding dust going to the first backer. `release` zeroes each amount before sending, a failed send becomes a credit, and `claim_credit` zeroes before sending, so a credit cannot be claimed twice. Releases are gas-bounded and can be resumed. Exceptions: C-1 (credits cannot be stored when out of room) and H-1.
- **Seat sales.** Only the owner can list, only while Active, only unpaid seats, and the price must be above 0. The buyer must already be a member in a later seat (so no buying your own or an earlier seat), must pay the exact price (front-running a price change just refunds), and cannot buy while `paying`. Both listings are cleared on the swap, a seat cannot be sold after its payout, and the seller is paid from the buyer's amount.
- **Joins.** The invite signature binds contract, circle, account and deposit, so it cannot be replayed on another circle, contract or account. Joins are refused when the circle is not Open, is full, or the account is already a member. Leave and cancel only work while Open. `fill_by` lets anyone cancel an abandoned circle. Circle ids are never reused.
- **Init and access control.** `#[init]` refuses a second init. `owner_id` has no privileged methods, and there is no upgrade method in the contract. Callbacks are `#[private]`.
- **Lock script (current).** It deletes every access key in one transaction, refuses if intents.near holds `public_keys_of` the contract, and verifies that nothing is left afterwards. Mainnet currently shows `public_keys_of = []`.
- **Relayer correctness filters** (not abuse filters): the NEP-413 signature is verified locally, the recipient must be `intents.near`, the deadline is within 30 minutes, only `transfer` and `auth_call` are allowed, `auth_call` must target Contri with no NEAR attached, `msg` and `min_gas` go only to Contri with `min_gas` at most 150 Tgas, and implicit signers must match the key. Replays are stopped by intents' nonces.
- **Web app.** No HTML injection: there is no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `eval`. `h()` sets listeners only for function values, and links are built from numeric ids. The seat SVG is drawn by the contract and shown through `<img>`, which cannot run script. Invite secrets stay in the URL fragment and are removed from the address bar. `Referrer-Policy: no-referrer` is set.

## Proofs of concept (all in the scratchpad; the repository was not modified)

- Contract unit PoCs: the `audit_*` tests appended to `/tmp/claude-0/-home-claude/918ef2cf-0b44-596c-8ab2-d4bb6f089ff4/scratchpad/sec/contri/contract/src/tests.rs`. Run them with `cargo test audit_ -- --nocapture`. All 80 tests pass (72 original plus 8 audit tests). Log: `/tmp/claude-0/-home-claude/918ef2cf-0b44-596c-8ab2-d4bb6f089ff4/scratchpad/sec/contract-audit-tests.log`.
- Real-runtime sandbox PoCs: `/tmp/claude-0/-home-claude/918ef2cf-0b44-596c-8ab2-d4bb6f089ff4/scratchpad/sec/poc/` (mock intents in `mock/src/lib.rs`, tests in `runner/tests/poc.rs`). The sandbox runs through `/tmp/claude-0/-home-claude/918ef2cf-0b44-596c-8ab2-d4bb6f089ff4/scratchpad/sec/shim/near-sandbox` (an LD_PRELOAD shim for this container's open-files limit). Logs: `/tmp/claude-0/-home-claude/918ef2cf-0b44-596c-8ab2-d4bb6f089ff4/scratchpad/sec/sandbox-storage-poc.log` and `/tmp/claude-0/-home-claude/918ef2cf-0b44-596c-8ab2-d4bb6f089ff4/scratchpad/sec/sandbox-gas-poc.log`.
- App and server PoCs: `/tmp/claude-0/-home-claude/918ef2cf-0b44-596c-8ab2-d4bb6f089ff4/scratchpad/sec/contri/app/test/audit.test.js`. Run with `/opt/node22/bin/node --test test/audit.test.js`. All 44 app tests pass. Log: `/tmp/claude-0/-home-claude/918ef2cf-0b44-596c-8ab2-d4bb6f089ff4/scratchpad/sec/app-audit-tests.log`.

Not covered: a sandbox run against the real defuse wasm. Zero-amount rejection and refund semantics were confirmed from the defuse source at d340060, and `simulate_intents` accepting an unfunded `auth_call` was inferred from that source. I also did not test against live 1Click.
