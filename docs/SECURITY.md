# Security

Who can do what with members' money, what the contract guarantees, what three rounds of AI-assisted security review found, and what changed because of them.

## Who holds what

| Party | Can | Can't |
| --- | --- | --- |
| **The contract** (`circles.contring.near`) | Hold each circle's pot, deposits and backing on NEAR Intents, and pay them out by the rules in its code | Pay anyone outside those rules. The code has no owner or admin method: `owner_id` is stored and shown by `get_config`, and nothing reads it |
| **The contract's deploy key** | Until the lock: upgrade the contract's code, or call NEAR Intents as the contract and move every pot directly. It is the same key as the relayer's, held by Vercel and GitHub Actions | Anything, after the lock. `deploy.js --lock` refuses unless the deployed code is exactly CI's build, swaps every key on the account for a one-time key in one transaction (so the deploy key can't act during the lock), checks NEAR Intents holds no key for the account, still lets it pay out and hasn't locked it, then deletes the one-time key and checks nothing is left |
| **A member's phone** | Sign intents for that member's circle accounts and private account, with keys derived from the passkey | Sign for anyone else |
| **Contri's relayer** (`contring.near`) | Submit members' signed intents and pay the gas; call the anyone-can-call methods (`settle_round`, `pay_out`, `release_deposits`, `cancel_circle` after `fill_by`, `close_circle`) as the keeper | Move a member's money: it only submits what the member signed. If it stops, members' money stays where it is, and anyone with NEAR can settle and release |
| **Contri's server** | Refuse service; serve the app's code; hand the phone a wrong 1Click deposit address for a top-up or cash-out (see L-2) | Sign anything for a member, or change the contract |
| **NEAR Intents** (`intents.near`) | Hold members' and the contract's USDT balances. Its governance, locked contract or not: the DAO (`intents.sputnik-dao.near`) and role holders can pause it (`PauseManager`), upgrade it (`Upgrader`: `ctl-intents.near`), lock accounts or turn off their predecessor auth (`UnrestrictedAccountLocker`), and force-transfer or force-withdraw balances (`DAO`, `UnrestrictedWithdrawer`, which had no holders on 6 November 2026). Tether can freeze USDT | |
| **1Click** | Hold money in flight during a top-up or cash-out, and refund it if the swap fails | Touch money already in a circle |

## What the contract guarantees

- **Every unit is accounted for.** Per circle, the money held equals the pot, plus deposits, plus unused backing, plus what is owed to backers. Every path keeps that balance: join, pay, settle, back, refill, payout, release, leave, cancel. A payout is never sent twice, and a failed one keeps the pot for a retry.
- **Only NEAR Intents can credit a payment,** only in Contri's token, and a message the contract can't use is refunded in full before anything is stored.
- **A circle can always finish.** A round whose deadline passed can be settled by anyone; deposits, then backing, cover missed payments; an empty pot closes the round without a transfer; when the circle ends, anyone can send the deposits back.
- **Storage and gas can't strand a payout.** Everyone who can be sent money holds a reserved storage slot for a credit, and transfers and their callbacks get gas floors plus a share of what is left (measured below).

What it does not guarantee:

- **A full pot after someone stops paying.** Every deposit is exactly one contribution, so it covers one missed round. A member who takes an early pot and then stops paying is covered by their deposit for the first missed round, then by any backing; after that, later pots are short and the shortfall is recorded. Per-person deposits can't be enforced, because everyone in a circle shares one invite key. Backers and refills (`refill:<circle>`, in the contract) are the extra protection.
- **A perfectly fair draw.** Random turn order uses NEAR's per-block random seed. No member or organizer can choose it, but block producers could bias it. It is best effort.

## Reviews and fixes

### 5 November 2026: claims check and security review

| | Finding | Status |
| --- | --- | --- |
| C-1 | **Storage could run out under a running circle.** The contract paid for all storage with no reserve. Spam circles, or one large circle, could leave too little room for the payout callback, which then failed after the pot was sent and froze the circle | **Fixed.** Members reserve the bytes their payout and track records will need when they join. Anything that adds storage is refused, and its money sent back, unless the contract's NEAR covers what is stored, what is reserved, the addition and 2,000 spare bytes. Contributions start at 1 USDT. Tests: `nothing_grows_storage_the_contract_cannot_pay_for`, `payout_callbacks_only_use_storage_that_was_reserved` |
| H-1 | **An empty pot never paid out.** NEAR Intents refuses a transfer of 0, so the round stalled and the keeper retried forever | **Fixed.** A round with nothing in the pot closes without a transfer, its whole pot recorded as a shortfall (`an_empty_pot_closes_the_round_without_a_transfer`) |
| H-2 | **The relayer could be used for free.** It paid gas for any Contri auth call and for transfers of any token to anyone | **Fixed.** It relays only Contri's token: transfers to Contri with a message the contract reads, auth calls from a member or organizer of that circle (or someone with a credit), and transfers to a 1Click deposit account Contri's server opened in the last 30 minutes, proven by an HMAC ticket |
| H-3 | **The contract's upgrade key is the relayer's hot key,** held by the server and CI | **Open until the lock** (also C1 below). The Vercel token reaches only the CI steps that talk to Vercel, and the Vercel CLI is pinned |
| M-1 | **An invitee could choose their own deposit,** because the invite key travels in the link | **Fixed.** Every join deposits exactly one contribution; the invite only proves the member has the link (`an_invite_cannot_change_the_deposit`) |
| M-2 | **A late backer paid for earlier losses,** since leftover backing is shared by amount put in | **Fixed.** New backing is refused once backing has covered a missed payment (`backing_is_refused_once_some_has_covered_a_missed_payment`) |
| M-3 | **A round closed late left the next one already overdue,** so anyone could settle it before members could pay | **Fixed.** A round always gets a full period after the one before it closes (`a_round_closed_late_still_gets_a_full_period`) |
| M-4 | **`/api/swap` was an open proxy** for Contri's 1Click key | **Fixed.** Per-caller limits (at most 12 new deposit accounts a minute), and a $10,000 cap per move |
| B-1 | **A failed transfer out wrote a credit with no room reserved for it** | **Fixed.** Everyone who can be sent money holds a 121-byte credit slot: members until their deposit is sent, backers until their share is sent, listed seats until the seller is paid or the listing ends, and claims in flight. `on_sent` frees it. Tests: `failed_transfers_out_only_write_credits_into_reserved_slots` (all 20 transfers of a 20-member circle fail and every credit fits) and five others. Circles 1 to 3 have since been closed, and circle 0, the last one from before slots existed, is closed before the upgrade that adds held-back arrears |
| B-2 | **Transfers had fixed gas** that NEAR Intents could outgrow | **Fixed.** `mt_transfer` and its callback each get a floor (15 Tgas; 30 for `on_payout`, 10 for `on_sent`) plus an equal share of the gas left |
| L-1 | Views scan every circle | Open. Fine at hundreds of circles; a per-account index is the fix past that |
| L-2 | The phone checks a private move's signer, token and amount, but takes the destination from Contri's server | Open. Contri's server also serves the app's code, so this adds no new trust; verifying 1Click's quote signature is the fix |
| L-3 | A member who buys an earlier turn and then stops paying leaves the rest short | Open, by design: the same early-exit risk as above |
| L-4 | A circle's name could add lines to a calendar file | **Fixed.** Line breaks and backslashes are escaped |
| L-5 | Public `GET /api/keeper` | **Fixed** with H-1 and H-2: limited per caller, and no endless retries |
| L-6 | A retried send can submit a transaction twice | **Fixed.** A transaction the node stopped waiting for is followed by its hash, not sent again |
| S-1 | The relayer paid gas for payments the contract would refund | **Fixed.** It runs the contract's own checks (amount, round, seat, listing price) against `get_circle` before paying gas |

### 6 November 2026: second review, by a different model, of commit `17a4a31`

| | Finding | Status |
| --- | --- | --- |
| C1 | **Any full-access key on the contract account can drain every pot** | **Open until the lock.** The lock deletes every key and checks NEAR Intents holds none; the sandbox test `the_deploy_script_creates_upgrades_and_locks_the_contract` runs it |
| H1 | **A payout callback that ran out of gas would leave a circle stuck** | **Fixed.** `on_payout` gets a 30 Tgas floor plus its share of leftover gas. The sandbox measures it in the worst case, a 20-member circle's last round writing every record: **5.4 Tgas**. The test `the_payout_callback_fits_its_gas_floor_in_the_biggest_circle` fails if it passes 15 |
| H2 | **Fixed one-contribution deposits don't protect late seats** from an early receiver who stops paying | **Accepted and documented.** Letting the invite set a bigger deposit would bring back M-1, since everyone shares the invite key. The risk is stated in the app's FAQ, How it works, the Terms and above |
| M1 | **Random turn order can be biased** by block producers | **Accepted and labelled best effort** everywhere it is described |
| M2 | **The relayer's NEAR could be drained** across server instances | **Fixed.** Limits are shared by every instance through Upstash Redis, with one cap of 60 relays a minute for the whole relayer. If Redis is down, each instance still limits on its own. Check: `https://contri.ng/api/config?check=limits` |
| M3 | **Cheap cancelled circles could fill the contract's storage** | **Fixed.** The keeper cancels circles past `fill_by`, releases deposits, and closes cancelled circles once everyone is paid back |
| M4 | **Contri's server sees a private balance and a circle account together** on private moves | **Documented** in [PRIVACY.md](PRIVACY.md): 1Click and Contri's server can link a member's circle accounts through private moves |
| L1 | **Unlinkability claims were stronger than the code** | **Fixed in the docs and site:** circle accounts aren't linked by keys on chain; amounts, timing, 1Click and Contri's server can still link activity |
| L2 | Seat sales and leaving pay out before the transfer confirms | Covered by B-1: a failed transfer becomes a credit in a reserved slot, claimable with `claim_credit` |
| L3 | **The device-key fallback is weaker than a passkey** | **Documented and warned in the app:** a key kept in the browser is unencrypted, like a hot wallet |

### 6 November 2026 (evening): eight independent auditors on commit `0009377`

A cold hackathon judge, a contract attacker, an economics auditor, a server and infrastructure auditor, an on-chain verifier, a privacy and claims auditor, a front-end and accessibility auditor, and a NEAR Intents and 1Click integration auditor, each working alone from the repository, the live site and mainnet. The contract attacker found no way to steal pooled money through the contract's own logic.

| Finding | Status | Proof |
| --- | --- | --- |
| **A member who never paid still collected their full turn** (economics, Critical) | **Fixed.** What a member's own deposit didn't cover, they owe; it is held back from their own turn, repays backing first, and the rest goes to the members whose pots were short when the circle finishes. The recipient skipping their own share owes nobody | `a_member_who_never_pays_has_what_they_owe_held_back_from_their_own_turn`, `backing_that_covered_a_member_is_repaid_from_their_turn_first`, `the_member_whose_turn_it_is_owes_nobody_for_skipping_it`, and the sandbox's 20-member run |
| **Anyone could lock members out of paying** by filling the relayer's per-minute cap with requests that fail simulation (judge, server) | **Fixed.** The cap counts only what passed simulation | `requests NEAR Intents would reject don't use up the relayer's cap for everyone` |
| **Cash-out tickets could be reused** by anyone, for any amount (server) | **Fixed.** Bound to the deposit account, the payer and the exact amount, and usable once (Redis, failing closed) | `money leaves only for a deposit account Contri opened in the last half hour` |
| **The relayer paid gas for calls the contract would refuse** (auth calls on the wrong circle state, joins without an invite, late backing) (server, economics) | **Fixed.** The relayer runs the contract's own checks first | `the relayer refuses auth calls the contract would refuse, before paying gas`, `the relayer refuses payments the contract would refund, before paying gas` |
| **An emptied open circle held storage for 14 days** (contract) | **Fixed.** An organizer leaving their own circle empty cancels it, so it can be closed at once | `an_organizer_who_leaves_their_empty_circle_cancels_it`, `an_emptied_open_circle_can_be_cleaned_up_at_once` |
| **The payout gas guard was below the payout's real cost** (contract) | **Fixed.** 80 Tgas | `the_last_contribution_never_panics_near_the_payout_gas_guard` |
| **The keeper and Live circles stopped reading after a gap** left by a closed circle (economics) | **Fixed.** They read up to the circle count | `the keeper reads every circle, even past a gap left by a closed one` |
| **The lock could be raced, or lock in code CI didn't build** (contract, on-chain) | **Fixed.** Code-hash pin, a key swap before any check, predecessor-auth and account-lock checks | `the_deploy_script_creates_upgrades_and_locks_the_contract` |
| **CI: credentials left in every job, an unpinned `cargo-near` installer** (server) | **Fixed.** `persist-credentials: false` everywhere, `cargo-near` pinned to v0.23.0. The deploy key stops mattering for the pots at the lock | workflows |
| **A passkey re-prompt was missing on joining and buying a turn** (privacy) | **Fixed.** Asked for unless the passkey was used in the last two minutes | `confirmRecentPasskey` in `wallet.js` |
| **The rate-limit IP hash could be reversed by Upstash**, which held its salt (privacy) | **Fixed.** Salted with a secret derived from the relayer's key | `limit.js` |
| **Credits from failed transfers couldn't be claimed in the app; a new phone stopped looking after 3 empty accounts** (integration) | **Fixed.** A Claim row on the home screen; discovery counts credits and looks past 10 empty accounts | `wallet.js`, `home.js` |
| **Leave and Cancel acted on one tap; TON cash-outs to exchanges; a failed cash-out said the money came back; a refunded payment showed as paid** (front end, integration, privacy) | **Fixed.** A confirm step; a TON warning; separate FAILED text; the pay screen checks the `contributed` event | screens |
| **The landing page looked blank in screenshots; unreadable CTA text; an unnamed menu button; the hero animation held up taps on phones** (judge, front end) | **Fixed** | `live-browser.mjs` now fails if sections stay hidden |
| **Claims stronger than the code** (logs, linkability, the deploy key's powers, domain changes, gas for self-hosting, NEAR Intents' governance) (privacy, on-chain) | **Fixed** in the site, app, README and docs | this page, PRIVACY.md |
| A member who takes an early pot and stops paying | **Accepted**, by design: deposits are one contribution because everyone shares the invite key. Backing, refills and held-back arrears limit it | FAQ, How it works, Terms |
| A 1Click refund comes back as the coin sent, which the app can't show yet (integration) | **Accepted for now.** The app tells members to add exchange fees on top, and Help explains how to get it back | screens |
| The relayer's NEAR can be spent by real, valid actions at up to 60 a minute; Redis is on a free plan | **Accepted.** Keep the relayer funded; a per-payment fee is the fix at scale | |
| Storage can be filled by many 1-USDT circles; track records stay stored | **Accepted.** Anyone can send the contract NEAR; running circles are never affected | |
| The phone can't check where a 1Click deposit address sends money (integration) | **Accepted.** Contri's server also serves the app's code, so this adds no new trust | |
| The contract build isn't reproducible by outsiders without CI's paths | **Accepted.** CI's build and the deployed code hash match, and both are published | `audit-run` evidence |
| Seats can't be transferred outside the sale flow; views scan every circle; no pause control for animations; heavy videos; address checksums | **Accepted** for the hackathon build | |

We disagreed with one suggestion: a function to recover a stuck payout. The contract can't tell whether a stuck transfer left, so recovering could pay a pot twice out of other circles' money. Measured gas headroom (5.4 of 30 Tgas) is the defence instead.

## Limits

- **The relayer pays gas.** If its NEAR runs out, members can't pay through the app until it's topped up. Their money is safe in the meantime, and anyone with NEAR can settle rounds and send deposits back. Its balance is published after every deploy (`deploy-results/accounts.json`).
- **The contract's storage is paid in NEAR it holds.** When it's full, new circles and members are refused (with the money sent back) until someone sends it NEAR. Running circles are never affected.
- **The site and the app are served by Contri.** A changed app could sign something else; the open-source code and the recovery code are the way around a server that goes bad or away.

## Reporting

Open an issue at https://github.com/ohjay-official/contri, or for anything sensitive, a private security advisory on the same repository.
