# Contri: first-round screening report (NEAR HACKATHON, Nov 1-14 2026)

Judged on 5 November 2026 from a fresh clone of https://github.com/ohjay-official/contri (HEAD `06e8096`, 85 commits) and the live site https://contri.ng. Nothing else on the machine was read. No money was spent and nothing was signed on mainnet.

Evidence folder: `/tmp/claude-0/-home-claude/918ef2cf-0b44-596c-8ab2-d4bb6f089ff4/scratchpad/judge/`
(`shots-live/`, `shots-mock/`, `shots-mock-member/`, `chain/`, `tsc.log`, `cargo-test.log`, `scripts/`)

---

## Verdict in one paragraph

Contri is the most finished kind of hackathon entry: a real mainnet contract, a polished phone-first app, passkey-derived keys, gasless NEP-413 intents, 1Click top-ups, and a real use of Confidential Intents, all backed by unusually strong tests (unit, sandbox end-to-end against the real NEAR Intents contract, and a browser end-to-end with a virtual PRF passkey). Every mainnet transaction in the README checks out. But the headline promise, "nobody can run with the money, not even us", is false today: the contract account still has a full-access key, and it is the same hot key the relayer uses on Vercel and in GitHub Actions. The offline demo dead-ends on its main action, the only real test path costs about $6 and two phones, and the idea (on-chain ROSCA) is familiar. Passes screening on "runs and does what the README says"; loses serious points with the human panel unless the lock and the demo path are fixed.

## Scores

| Criterion | Score | Why |
| --- | --- | --- |
| Technical implementation | **7/10** | Strong: 99.7 KB hand-sized contract, 72 unit tests (CI), 5 sandbox e2e tests against a real `intents.near` build, browser e2e with a WebAuthn PRF virtual authenticator, NEP-413 signing in WebCrypto with no runtime deps, relayer that simulates before submitting, on-chain code hash matches the CI build. Docked for: contract still upgradeable by a hot key; relayer is an open gas station; master secret persisted indefinitely and revealable without re-auth; hand-rolled JSON parser in a money contract (fuzzed, but more audit surface); no Cargo.lock, `non-reproducible-wasm` build, NEP-330 `build_info: null`; offline mock broken. |
| Design (UX/UI) | **7/10** | Genuinely good: restrained palette, real typography, plain-language copy, dark mode, no horizontal scroll on any screen at 390px, fast (landing 0.3-1.4 s, API 150-900 ms), strict CSP. Docked for: the add-money screen is a long scroll (route choice, private box, 7 network cards, then the address at the bottom, while the action button sits at the top); circles show as "Circle 0" and members as hex; finished circles show "Deposit $0.00"; landing has no real product screenshot. |
| Impact | **6/10** | Real problem for a very large population (ajo/esusu/susu collectors who vanish). But users need USDT and an exchange, there is no naira path, recipient default risk (the classic ROSCA failure) is only covered by a one-contribution deposit, and mainnet traction is one finished 2-member $1 circle ($4 paid out). |
| Originality | **5/10** | On-chain ROSCAs are a well-worn hackathon idea. The fresh parts are the combination: one unlinkable account per circle from one passkey, a Confidential Intents private balance, signed invites with encrypted names, and tradeable turns. |
| Sustainability | **4/10** | No fee or revenue; relayer funded with 0.598 NEAR and open to anyone; one maintainer; support via a personal X handle; keeper on a GitHub Actions cron; contract upgrade authority is a hot key in CI and Vercel; own live checks already trip RPC 429s. |

**Overall: about 5.8/10.** Competitive in a track, not yet a favourite.

## Track fit

| Track | Fit | Chance of placing (rough) | Notes |
| --- | --- | --- | --- |
| **Real-World Money** | Strong (7/10) | ~25% as is, ~40% with the lock + a video | Real people's savings, stablecoin rails, cross-chain top-ups from exchanges, gasless passkey UX, a verified real-money run. Weakness: it is consumer P2P savings, not "something a normal company could use tomorrow"; default risk unanswered. |
| Privacy & Private AI | Moderate (6/10) | ~15% | Real Confidential Intents integration (sign-in, quotes, generate/submit intent) probed on mainnet, per-circle unlinkable accounts, encrypted names, no PII. But amounts/timing are public, 1Click and Contri's server see links, no private AI, and the private path had one real-money run. |
| NFTs That Do Something | Weak (3/10) | <10% | Seats are NEP-171-shaped views/events with an SVG drawn from live state, and turns can be swapped in-contract. No `nft_transfer`, owners are keyless implicit accounts no wallet shows, and no seat sale ever happened on mainnet. |
| Open Innovation | Weak (3/10) | <5% | "Something we haven't seen": savings circles on chain have been seen many times. |

**Emphasize one track: Real-World Money**, with privacy as the differentiator ("a private ajo"), not as a separate pitch. Claiming four tracks reads as unfocused.

---

## Ranked findings

### BLOCKER

**B1. "Not even us" is false: the contract still has a full-access key, and it is the relayer's hot key.**
- Seen: `view_access_key_list` on `circles.contring.near` returns one key, `ed25519:8ikg3ZpEFprsK79HQUwWA4MBKsnWQAoCejoJDcDEyK3x`, permission `FullAccess`. The same key is the only full-access key on `contring.near`, the relayer account (`RELAYER_KEY` in `app/server/config.js`, used by the Vercel functions and by GitHub Actions in `deploy.yml` / `keeper.yml`).
- Contradicts the site: hero on `/` ("nobody can run with the money, not even us"), FAQ "Who holds the money?" ("Our team can't move it"), Help screen ("Nobody at Contri can move, freeze or take your money"), Terms ("The contract's rules for a circle can't be changed once the circle has started").
- Why it fails: whoever holds that key (the developer, anyone who compromises the Vercel env or the GitHub secrets) can deploy new code and take every pot. That is the collector the product says it removes. A judge who checks keys, and on this panel someone will, discards the core claim.
- The fix already exists: `app/scripts/deploy.js --lock` and the `[lock]` commit trigger in `.github/workflows/deploy.yml`, tested in sandbox by `the_deploy_script_creates_upgrades_and_locks_the_contract`. Run it (or move upgrade authority to a separate cold key or multisig and say so plainly), then add the "no access keys" proof and a NearBlocks keys link to the README.

### MAJOR

**M1. The offline mock can't show the product and its main action errors.** (`app/dev/mock.js`)
- Following the README literally ("Other ways in > Keep my key on this device") creates a random key, so the two mock circles belong to someone else: home says "You're not in a circle yet" and both circles open as "You're watching this circle; you're not a member." Pay, seat NFT, swap turns and your payouts are unreachable.
- `mock.js:4` says "dev/screens.js seeds the rest"; that file doesn't exist. The member view only appears if you restore the hard-coded secret (32 bytes of `0x0b`, recovery code `k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn`), which the README never mentions.
- Starting a circle in the mock: "Move $1.00 here" works, then "Create circle and pay $1.00 deposit" fails with the toast "The circle wasn't created and your money stayed in your balance." Cause: `mock.js:100` always returns a `contributed` event; `fund.js` expects `circle_created`. Screenshot: `shots-mock/c2-after-create.png`.
- Fix: seed the member key (or print the recovery code in the README), make the mock relay return the right event per message (`create` gives `circle_created` + `joined`, `join` gives `joined`, and so on), and add a mock invite link to the README.

**M2. The only end-to-end test path costs real money and two passkey devices, and there's no video.**
- "How to test" step 1 needs about $6 of USDT on BSC from an exchange or wallet, two browser profiles or phones with passkeys, and 10+ minutes. Screening agents can't do it and most judges won't. Step 2 (mock) is broken (M1). The README links no demo video; `DEMO.md` is a script, not a recording.
- Fix: put a 60-90 s video link at the top of the README; put the free paths first; fix the mock; optionally keep a funded demo circle running (or a testnet deployment) that a judge can join without money.

**M3. The relayer is an open, unmetered gas station.** (`app/server/relay.js:74-84`, `app/api/*.js`)
- `checkIntent` relays any NEP-413 `transfer` of any single token to any receiver, signed by any NEAR Intents account, as long as it has no `msg`. There is no rate limit or membership check on `/api/relay`, `/api/swap` (which spends Contri's 1Click partner key) or `/api/keeper`. The relayer holds 0.598 NEAR. Anyone can drain it, after which every member's payment fails with "Contri can't pay the network fee right now."
- Fix: relay plain transfers only to deposit addresses Contri itself issued (keep a short-lived server-side allowlist) or only for signers that are members per `get_circles_for`; add per-IP and per-account rate limits; alert on relayer balance.

**M4. One unlock lasts forever, and the master secret can be shown without the passkey.** (`app/public/js/lib/session.js`, `app/public/js/app/screens/settings.js:17-23`)
- After one passkey prompt, the PRF secret is kept (sealed with a non-extractable key, but usable by the page) until the member taps Lock. "Show my recovery code" displays that root secret with no fresh user verification, and payments are signed with derived keys without any passkey prompt. Anyone holding an unlocked phone can copy the code and empty every circle account and the private balance.
- Fix: require a fresh WebAuthn assertion (`userVerification: "required"`) to reveal the recovery code and to sign money moves (at least above a threshold); time-box the unlocked session.

**M5. Recipient default, the classic ROSCA failure, is barely addressed.**
- The deposit is one contribution (`internal_join`). A member who receives an early pot, or buys an earlier turn, can stop paying; the deposit covers one miss and later recipients get a shortfall (`finalize_payout` records it). The privacy design makes it worse: accounts are unlinkable and the "private track record" is still "planned" (`docs/PRIVACY.md` §5). The sandbox test itself shows the pattern (Chioma buys turn 1, takes the pot, then misses).
- Fix: default deposits that scale with how early the seat is (the contract already supports per-invite deposits; make the app use them), block buying an earlier turn unless the buyer's deposit covers the remaining rounds, and ship the track-record proof or say clearly that this is for people who already trust each other.

**M6. Several "How NEAR is used" features were never exercised beyond unit or sandbox tests.**
- Mainnet ran only: create, join, contribute, payout, release_deposits (all 8 txs verified). It did not run: a seat listing or sale, a random draw, a missed round settled from a deposit, a leave or cancel, or DAO backing.
- DAO backing (`integrations/trezu`) has no app UI, no e2e test (`sandbox/tests/e2e.rs` has no `back:`), and the Trezu "custom template" format isn't verifiable from the repo. The random draw is tested only with a mocked seed.
- Seats have no `nft_transfer` / `nft_transfer_call`, so they aren't transferable NFTs, and their owners are keyless implicit accounts no wallet shows. `contract_source_metadata` lists only nep297 and nep330, which is honest, but it undercuts the NFT track.
- Fix: run a seat sale and a random-order circle on mainnet and link the txs; label DAO backing "contract-ready, not yet used by a DAO".

**M7. CI holds the key that controls the money and runs unpinned remote code next to it.** (`.github/workflows/deploy.yml`)
- Any push to `main` with `[deploy]` in the message upgrades the mainnet contract using `RELAYER_KEY`. In the same job: `curl ... cargo-near/releases/latest/download/cargo-near-installer.sh | sh` (unpinned `latest`, piped to a shell) and unpinned actions (`Swatinem/rust-cache@v2`, `actions/*@v4`). A compromised installer or action can exfiltrate the key that owns every pot.
- Fix: lock the contract (B1). Until then, use a separate deployer key that never touches Vercel, pin the installer by version and checksum, and pin actions by SHA.

**M8. Sustainability is not addressed.**
- "Contri takes no fee" (FAQ) and the relayer pays all gas from 0.598 NEAR. One maintainer, support via a personal X handle (Help screen, Privacy, Terms). The keeper depends on GitHub's best-effort cron, which GitHub disables after 60 days without repo activity. The CI's own live checks already hit RPC rate limits: the `web` run for `9e895e0` failed with "RPC query failed with HTTP 429".
- Fix: state a model (a small fee on payouts, an organizer plan, or DAO/co-op sponsored relaying), move the keeper to a reliable scheduler with an RPC fallback, and give a support contact that isn't a personal DM.

### MINOR

1. **Docs contradict each other.** `docs/PRIVACY.md` Status says "First run with real money: pending", but the README shows it done. The PRIVACY table says "Your track record: Shown only to an organizer you choose", but §5 says "planned". README "No logs" vs the privacy page "Vercel may keep standard technical logs".
2. **Server-side linkability isn't disclosed.** `wallet.js discover()` sends five of a member's circle accounts in one `/api/rpc` request, so Contri's server can link a member's circles. PRIVACY.md only admits linking for private-balance moves.
3. **Reproducibility.** No `contract/Cargo.lock` and no `app/package-lock.json` (`@types/node ^22` floats). The deploy uses `cargo near build non-reproducible-wasm`, and on-chain `build_info` is null. The deployed hash does match CI's `contri.wasm` (`4sCnCi9...`), but a judge can't rebuild it deterministically.
4. **Junk file committed:** `scripts/__pycache__/abi.cpython-313.pyc`.
5. **README test section details.** Port 8787 is hard-coded; the server honours `PORT`, but the README doesn't say so. The README lists 4 sandbox tests; there are 5. Add the app test count (38).
6. **Add-money layout.** The deposit address lands below seven network cards, while "Waiting for your deposit" and the action button sit at the top, so you have to scroll back up when money arrives. Collapse the network list once one is picked and keep the action sticky.
7. **Confusing copy on the private top-up:** "If it can't go through, the money comes back to your private balance" (it is a top-up *into* the private balance).
8. **Finished circles read wrong.** Each member shows "Deposit $0.00" (`app-10-circle-0.png`). Say "Deposit returned".
9. **Test-only option in production.** "Every 10 minutes (to try it out)" is offered on the mainnet create form.
10. **Console warnings.** Every `/app` screen warns that `fonts/instrument-sans.woff` was preloaded but not used. `/favicon.ico` 404s (an SVG icon is linked, so this is cosmetic); there is no robots.txt.
11. **Mainnet evidence gaps.** The README's "deposit paid from money moved out of the private balance" and both cash-outs aren't verifiable from the linked txs (NearBlocks doesn't index intents-internal accounts). Link the 1Click/intents legs or the 1Click status pages.
12. **Missing release event.** `release_deposits` emits only NEAR Intents `mt_transfer` events, no Contri event, so Contri's own event stream doesn't show deposits coming back.
13. **Traction.** One circle and $4 on mainnet, almost certainly the builder's two phones. DEMO.md's closing line ("real circles with real people saved $X") needs real numbers by judging time.
14. **Commit history will draw questions.** A 1,391-line contract with tests was committed 13 minutes after kickoff (Nov 1 00:13), there are no commits on Nov 2-4, and 2,000-line app commits landed minutes apart on Nov 5. Allowed if built in-window, but judges checking "built during the event" may ask. A short build log in the README helps.
15. **Hand-rolled JSON parser in a money contract.** `contract/src/json.rs` exists to stay under 100 KB and is fuzzed against serde_json, but it widens the audit surface. Mention the fuzzing in the security notes.
16. **Unchecked results in a sandbox test.** Three calls in `sandbox/tests/e2e.rs` (243, 268, 283) ignore their `ExecutionFinalResult` (compiler warnings). Later assertions do cover the effects.
17. **Relayer timing and the random draw.** The relayer submits the join that fills a circle and draws its order. Block randomness is fine at these stakes, but say so.

---

## Evidence

### 1. README read (2-minute judge pass)
- Clear: what it is (first two lines), why (collector risk), live link, contract link, and a mainnet tx table above the fold. Good.
- Unclear: no video; the first test path needs money and two devices; four tracks claimed; "How NEAR is used" lists features that never ran on mainnet (M6).

### 2. Test commands

| Command | Result | README claim |
| --- | --- | --- |
| `cd contract && cargo test` | **Could not run here.** Rust 1.95.0 toolchain installed fine, but `index.crates.io` doesn't resolve in this sandbox (sandbox quirk, see `cargo-test.log`). On a normal machine it should work, with no Cargo.lock (Minor 3). | "72 contract unit tests" |
| CI evidence instead: `origin/ci-results:ci-out/test.log` at `996dc1e` | `72 passed; 0 failed`. Contract sources unchanged since `996dc1e` (`git diff --stat 996dc1e..HEAD -- contract/` is empty) | matches 72 |
| `npm install` | Fails here (npm registry blocked, sandbox quirk) | n/a |
| `npm test` (`node --test`) | **38 pass, 0 fail**, 0.5 s | no number claimed |
| `npm run check` stand-in: `tsc -p jsconfig.json` (TS 6.0.2) | Raw: `TS2688 Cannot find type definition file for 'node'` (needs `npm install`, sandbox quirk). On a copy with `@types/node` 26.6.3 and playwright 1.63.0 types added: **0 errors** | "type-checks every JS file" holds |
| Sandbox e2e (CI, `origin/sandbox-results`, commit `9e895e0`) | **5 passed, 0 failed** in 93.8 s | README lists 4 |
| GitHub Actions | All green at HEAD except `sandbox` still running; `web` failed at `9e895e0` (Firefox session check: RPC HTTP 429) | n/a |

A judge on a normal machine would get through the README's commands, but `npm install` pulls TypeScript and Playwright with no lockfile.

### 3. Offline mock (`MOCK=1 node dev/server.js`, run on PORT=8791 because 8787 was taken by an unrelated process)
- Screens reached at 390x844 with no console errors and no horizontal scroll: open, other ways in, recovery code, home (not a member), Live circles (2), circle 0 and 1 as watcher, start a circle, add money (deposit address shown), private add (address shown), private cash-out, Your key, Help, move out, circle-not-found.
- Dead end: Create (see M1). Member screens only via the undocumented restore code (`shots-mock-member/`): Pay, calendar reminders, seat NFT, swap turns and payouts all render fine.

### 4. Live site (Chromium, 390x844, Android UA)
- Pages: `/` 200 (1.4 s cold), `/how-it-works` 200, `/privacy` 200, `/terms` 200, `/#faq` (FAQ section on home), `/app` 200, `/join` 200, `/api/config` 200; `/faq` 404 (no such page; the FAQ lives on `/`). All links on `/` resolve. Strict security headers present (CSP, HSTS, COOP, CORP, nosniff, Permissions-Policy). No horizontal scroll anywhere. Dark mode fine.
- App, "Keep my key on this device": recovery code, then home, then start a circle (Judge test, $1, 2 members, 10 min), then add money, "Every round: $3.00", BSC, then "Get a deposit address": real 1Click address `0xE091...0242`, "Send 3.02 USDT", in 0.86 s. Private balance sign-in (1Click session) and private top-up address `0x4186...054c` in 1.35 s. Live circles, circle 0, private cash-out, Help (lists both pending top-ups), Your key (reveal works), move money out, reload (stays unlocked). All work.
- Passkey: with a Chromium virtual authenticator (ctap2, PRF), "Create a passkey" leads to home; Lock, then "I already have a Contri passkey", leads back to home. Works.
- Console: only font-preload warnings (Minor 10). No page errors, no failed requests. API latencies 130-935 ms.
- Screenshots: `judge/shots-live/` (site-*.png, top-*.png, app-01 ... app-18, pk-01/02, dark-explore.png).

### 5. Mainnet verification (NearBlocks API + `EXPERIMENTAL_tx_status` on fastnear RPC)

| Step | Tx | Time (UTC, Nov 5) | Result | Does what README says |
| --- | --- | --- | --- | --- |
| Deploy | `GzzRpgJ...` | 05:49:51 | Success | CreateAccount + Transfer + AddKey (FullAccess) + DeployContract + `new` on `circles.contring.near` |
| Create + $1 deposit | `BwMEkbX...` | 06:59:47 | Success, no failed receipts | `circle_created` (id 0, $1, size 2, 600 s, invite_only) + `joined` seat 0. Private-balance origin not visible from this tx |
| Join + $1 | `Emi3RfF...` | 08:08:41 | Success | `joined` seat 1, `circle_started`, `nft_mint` 0:0 and 0:1 |
| Round 1 first pay | `CANkBfZ...` | 08:09:28 | Success | `contributed` r0 by seat 2 |
| Round 1 last pay + pot | `4r349ov...` | 08:13:14 | Success | `contributed`, `mt_transfer` 2 USDT to seat 1, `paid_out` r0 shortfall 0, same tx |
| Round 2 first pay | `E38hi5Z...` | 08:13:32 | Success | `contributed` r1 |
| Round 2 last pay + pot | `Gtiv9gp...` | 08:15:05 | Success | `paid_out` r1 to seat 2, `circle_finished` |
| Deposits returned | `5kN1RW3...` | 08:15:10 | Success | two `mt_transfer` of 1 USDT, memo `contri:0:release` (no Contri event, Minor 12) |

- All 8 exist, succeeded, and match the README. All member actions are `execute_intents` relayed by `contring.near`; `release_deposits` was called by `contring.near` directly.
- Contract state now: `circle_count 1`, circle 0 `Finished`, deposits 0, `mt_balance_of(circles.contring.near) = 0` (README's "ended holding $0" holds). `nft_total_supply 2`.
- Code: on-chain `code_hash 4sCnCi9LaPbXvcjEanqJJqwE9wwudDiEKY19wkMUGmFu` equals sha256/base58 of CI's `ci-out/contri.wasm` (99,751 bytes, under 100 KB as claimed). `contract_source_metadata` links the repo; `build_info: null`. Embedded ABI present (3,493 bytes).
- **Keys: one FullAccess key on the contract, identical to the relayer's key (B1). Not locked; upgradeable.** Contract balance 1.0775 NEAR (storage 101,007 bytes); relayer 0.598 NEAR.

### 6. Are the claimed NEAR features real?

| Claim | Status |
| --- | --- |
| NEAR Intents as money layer (`Transfer` + `mt_on_transfer`, payouts via `mt_transfer`) | **Real, on mainnet** |
| NEP-413 signed intents from passkey-derived keys, relayed with `simulate_intents` | **Real, on mainnet** (`relay.js`, `keys.js`) |
| Passkeys via WebAuthn PRF, HKDF per-circle keys | **Real**: verified live with a virtual PRF authenticator; e2e in CI |
| 1Click top-ups and cash-outs | **Real**: live deposit addresses issued; quotes probed in CI |
| Confidential Intents private balance | **Real integration** (`server/confidential.js`, `/v0/auth/authenticate`, `generate-intent`, `submit-intent`; the phone checks intents before signing). One real-money run claimed; legs not linked |
| `AuthCall` intents (leave, list, unlist, cancel, claim) | Implemented; e2e in sandbox; none on mainnet |
| Fair random draw | Implemented (`draw_turns`, `random_seed_array`); unit test with mocked seed only |
| Seats as live NFTs (NEP-171/177/181 views and events, SVG from live state) | Views and events real (`nft_mint` on mainnet, `nft_token` returns a live SVG). No transfer methods; seat sale only in sandbox |
| DAO backing (Trezu/Sputnik) | Contract logic and unit tests plus a JSON template; no UI, no e2e, never used |
| NEP-245 receiver, NEP-297 events, NEP-330 metadata, embedded ABI | Real |

---

## The one change that would most raise its chance of winning

**Make "not even us" true: lock the contract (or move upgrade authority off the relayer's hot key to a cold key or multisig) and say so in the README with a link to the empty key list.** It's one commit (`[lock]`), the code is already written and tested, and it turns the project's biggest liability into its strongest proof point for Real-World Money. Second priority: a 60-90 s video at the top of the README plus a fixed mock (M1, M2), so judges who won't spend $6 can still see a circle run.
