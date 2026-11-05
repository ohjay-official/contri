# Security

Who can do what with members' money, what the contract guarantees, and what an independent review found and what changed because of it.

## Who holds what

| Party | Can | Can't |
| --- | --- | --- |
| **The contract** (`circles.contring.near`) | Hold each circle's pot, deposits and backing on NEAR Intents, and pay them out by the rules in its code | Be changed. The account has no access keys (locked on 5 November 2026), and NEAR Intents holds no keys for it (`public_keys_of` is empty), so nobody, including Contri, can upgrade it or move its money outside its rules |
| **A member's phone** | Sign intents for that member's circle accounts and private account, with keys derived from the passkey | Sign for anyone else |
| **Contri's relayer** (`contring.near`) | Submit members' signed intents and pay the gas; call the anyone-can-call methods (`settle_round`, `pay_out`, `release_deposits`) as the keeper | Move a member's money: it only submits what the member signed. If it stops, members' money stays where it is, and anyone with NEAR can settle and release |
| **Contri's server** | Refuse service; hand the phone a wrong 1Click deposit address for a top-up or cash-out (see L-2) | Sign anything for a member, or change the contract |
| **NEAR Intents** (`intents.near`) | Hold members' and the contract's USDT balances | |
| **1Click** | Hold money in flight during a top-up or cash-out, and refund it if the swap fails | Touch money already in a circle |

## What the contract guarantees

- **Every unit is accounted for.** Per circle, the money held equals the pot, plus deposits, plus unused backing, plus what is owed to backers. Every path keeps that balance: join, pay, settle, back, refill, payout, release, leave, cancel. A payout is never sent twice, and a failed one keeps the pot for a retry.
- **Only NEAR Intents can credit a payment,** only in Contri's token, and a message the contract can't use is refunded in full before anything is stored.
- **A circle can always finish.** A round whose deadline passed can be settled by anyone; deposits, then backing, cover missed payments; an empty pot closes the round without a transfer; when the circle ends, anyone can send the deposits back.
- **Storage can't run out under a running circle** (see C-1 below).

## Security review, 5 November 2026

An independent review of the contract, server and app (written for a hackathon judge, with proofs of concept as unit tests, JavaScript tests, and a real NEAR runtime sandbox). Every finding, and what changed:

| | Finding | Status |
| --- | --- | --- |
| C-1 | **Storage could run out under a running circle.** The contract paid for all storage with no reserve. Spam circles (or one large circle) could leave too little room for the payout callback, which then failed after the pot was sent and froze the circle | **Fixed.** Each member reserves the bytes payout callbacks write (a payout record each round, and track records at the end) when they join; callbacks release them as they write. Anything that adds storage is refused, and its money sent back, unless the contract's NEAR covers what is stored, what is reserved, the addition and 2,000 spare bytes. Contributions start at 1 USDT. Test: `payout_callbacks_only_use_storage_that_was_reserved` runs a 20-member circle with the longest account names and checks every callback stays within what was reserved |
| H-1 | **An empty pot never paid out.** NEAR Intents refuses a transfer of 0, so the round stalled and the keeper retried forever | **Fixed.** A round with nothing in the pot closes without a transfer, its whole pot recorded as a shortfall. The keeper also retries at most two payouts a run, after settling and releasing |
| H-2 | **The relayer could be used for free.** It paid gas for any Contri auth call and for transfers of any token to anyone | **Fixed.** It relays only Contri's token: transfers to Contri with a message the contract reads, auth calls from a member or organizer of that circle (or someone with a credit), and transfers to a 1Click deposit account Contri's server opened in the last 30 minutes, proven by an HMAC ticket. Requests are limited per caller and per signer |
| H-3 | **The contract's upgrade key was the relayer's hot key,** held by the server and CI | **Fixed by the lock:** the contract account has no keys left. The relayer key can now only spend the relayer's own NEAR. The Vercel token reaches only the CI steps that talk to Vercel, and the Vercel CLI is pinned |
| M-1 | **An invitee could choose their own deposit,** because the invite key travels in the link | **Fixed.** Every join deposits exactly one contribution; the invite only proves the member has the link |
| M-2 | **A late backer paid for earlier losses,** since leftover backing is shared by amount put in | **Fixed.** New backing is refused once backing has covered a missed payment |
| M-3 | **A round closed late left the next one already overdue,** so anyone could settle it before members could pay | **Fixed.** A round always gets a full period after the one before it closes |
| M-4 | **`/api/swap` was an open proxy** for Contri's 1Click key | **Fixed.** Per-caller limits (at most 12 new deposit accounts a minute), and a $10,000 cap per move |
| L-1 | Views scan every circle | Open. Fine at hundreds of circles; a per-account index is the fix past that |
| L-2 | The phone checks a private move's signer, token and amount, but takes the destination from Contri's server | Open. Contri's server also serves the app's code, so this adds no new trust; verifying 1Click's quote signature is the fix |
| L-3 | A member who buys an earlier turn and then stops paying leaves the rest short | Open, by design: the same risk as the member who holds the first turn in any ajo. Deposits and backing cover it as for any missed payment |
| L-4 | A circle's name could add lines to a calendar file | **Fixed.** Line breaks and backslashes are escaped |
| L-5 | Public `GET /api/keeper` | **Fixed** with H-1 and H-2: limited per caller, and no endless retries |
| L-6 | A retried send can submit a transaction twice | Open. The second one fails on NEAR Intents' nonce or the contract's checks, so it costs only gas |

Informational notes from the review: track records can be farmed with throwaway circles, so they aren't reputation; the turn draw uses NEAR's block randomness, which only block producers could bias; a passkey made on another domain gives different keys, so the app is served from `contri.ng` only.

## Limits

- **Request limits are per server instance.** Vercel runs several instances that don't share memory, so the limits cap each one. They make abuse slow and visible, not impossible; the relayer's balance is checked after every deploy.
- **The relayer pays gas.** If its NEAR runs out, members can't pay through the app until it's topped up. Their money is safe in the meantime, and anyone with NEAR can settle rounds and send deposits back.
- **The contract's storage is paid in NEAR it holds.** When it's full, new circles and members are refused (with the money sent back) until someone sends it NEAR. Running circles are never affected.

## Reporting

Open an issue at https://github.com/ohjay-official/contri, or for anything sensitive, a private security advisory on the same repository.
