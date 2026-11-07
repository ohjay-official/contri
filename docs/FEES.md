# Fees and minimums (measured)

Dry-run quotes from the 1Click API on 1 November 2026, Lagos time (unauthenticated), from `scripts/probe-1click.mjs`. No money moved. Re-run the probe before quoting these numbers anywhere public.

The circle asset is USDT on NEAR inside NEAR Intents: `nep141:usdt.tether-token.near` (6 decimals).

## Contri's fee

Contri adds a 0.25% fee to top-ups from another chain and cash-outs to one, and to nothing else: contributions, payouts, deposits, turn trades and moves between a member's private balance and their circle accounts carry no Contri fee. The fee is a 1Click `appFees` entry the server adds to those quotes (`CONTRI_FEE_BPS`, default 25, paid to `CONTRI_FEE_ACCOUNT`, default the relayer). 1Click takes it from the amount sent, before the swap; with Contri's 1Click key, 1Click keeps half. The app shows it before every top-up and cash-out, and the amounts the app asks members to send include it. The fee is not in the contract, so it can change after the lock; the measurements below were taken before it existed.

## Top up (member wallet or exchange -> member's Intents balance)

| From | Amount in | Lands in Intents | Time | Notes |
| --- | --- | --- | --- | --- |
| USDT on BNB Chain | 2.00 | 1.9996 | ~35 s | Cheapest route. Most Nigerian exchanges withdraw USDT on BNB Chain cheaply. |
| USDT on Tron | 10.00 | 9.998 | ~80 s | Minimum about 2.56 USDT. The sender also pays Tron network fees. |

## Cash out (member's Intents balance -> member's wallet)

| To | Amount | Received | Time | Notes |
| --- | --- | --- | --- | --- |
| USDT on BNB Chain | 10.00 | 9.989 | ~13 s | About 0.1% |
| USDT on Solana | 10.00 | 9.989 | ~7 s | About 0.1% |
| USDT on Tron | 10.00 | 8.437 | ~65 s | About 1.56 USDT flat (1 USDT bridge fee plus gas). Minimum about 2.59 USDT. |

## What this means for Contri

- Money stays inside NEAR Intents for the whole circle. Contributions and payouts between members and the Contri contract are internal transfers, so they cost only NEAR gas, which the relayer pays.
- Members cash out once, when they want, and the app lists BNB Chain and Solana first when you top up.
- Tron works for top-ups of about 2.56 USDT or more. Cashing out to Tron costs more than other networks (0.87 USDT in a dry quote on 5 November 2026); the cash-out screen shows the fee when you tap See what arrives.

## Bridge limits for Tron (PoA bridge `supported_tokens`)

| Asset | Min deposit | Min withdrawal | Withdrawal fee |
| --- | --- | --- | --- |
| USDT (TRC-20) | 1 USDT | 1 USDT | 1 USDT |
| TRX | 4 TRX | 0.000001 TRX | 0.29 TRX |

## Deploying the contract

Storage on NEAR is staked, not spent: an account locks 1 NEAR per 100 KB it stores, and the NEAR is free again when the storage is freed.

| Version | Contract size | Storage locked |
| --- | --- | --- |
| First build | 271 KB | 2.71 NEAR |
| Text messages, lookup map, no embedded ABI | 193 KB | 1.93 NEAR |
| Own JSON reader and writer, no serde_json | 110 KB | 1.10 NEAR |
| Plain storage and promise calls instead of the SDK's collections and promise builder | 83 KB | 0.83 NEAR |
| Direct calls for NEAR accounts and the embedded ABI added back | 88 KB | 0.88 NEAR |
| Invite-only circles (ed25519 invites) for privacy | 90 KB | 0.90 NEAR |
| Community backing, trust deposits, refills; a bump allocator instead of wee_alloc | 95 KB | 0.95 NEAR |
| Fair random draws, leaving before the start, fill deadlines, cleanup, live seat images | 99.4 KB | 0.99 NEAR |
| Creating costs a deposit (no free spam) | 99.8 KB | 1.00 NEAR (99,751 bytes deployed) |
| Security fixes: storage reservations and credit slots, a $1 minimum, empty pots, one-contribution invites, fair backing, relative deadlines, gas floors with a share of leftover gas | 102.2 KB | 1.02 NEAR (102,245 bytes) |
| Third audit round: arrears held back from a defaulter's own turn, emptied circles cancel, an 80 Tgas payout guard | 105.1 KB | 1.05 NEAR (105,123 bytes) |
| Paying ahead | **107.4 KB** | **1.07 NEAR** (107,428 bytes, CI build) |

The 193 KB step removed two things: direct calls for members with a NEAR account, and the embedded ABI. Both came back in the 88 KB row (the ABI is generated from typed declarations in `contract/interface`, see `contract/abi/README.md`). Nothing else was removed, and the later steps added NFT enumeration views, NEP-171 events and a round-deadline view. CI measures the size on every push (`ci-results` branch, `size.json`).

Expected total to launch: about 1 NEAR for the code, up to 0.03 NEAR per circle for its data (a 20-member circle with its full payout history is about 3 KB; a 5-member one under 1 KB), and gas for the relayer. Storage is locked, not spent. Freed storage goes back to the contract account's balance, where it pays for later circles; once the account is locked, nobody can withdraw it. Each member reserves the bytes their payout record, track record and a possible credit will need (about 440 bytes, 0.0044 NEAR) when they join, and the contract refuses (and refunds) anything that would add storage its NEAR doesn't cover, counting those reservations and 2,000 spare bytes. Running circles never run out of room; when the contract is full, new circles wait until someone sends it NEAR. Circles created through NEAR Intents cost the organizer a deposit of at least 1 USDT, circles created by a NEAR account bring 0.01 NEAR for their own storage, and the keeper closes cancelled circles to free their storage.

## Gas (measured)

Gas burnt per action in the end-to-end tests against NEAR Intents (`contract/sandbox`, results on the `sandbox-results` branch). At NEAR's current gas price, 10 Tgas costs about 0.001 NEAR.

| Action | Gas burnt |
| --- | --- |
| Create a circle with the organizer's deposit | 9 Tgas |
| Join (signed intent or `mt_transfer_call`) | 9–11 Tgas |
| Contribute | 9 Tgas |
| Last contribution, which also pays the pot out | 15–17 Tgas |
| Settle a round after a missed payment (and pay out) | 8 Tgas |
| The payout callback in a 20-member circle's last round, the worst case | 5.5 Tgas, against a 30 Tgas floor |
| Buy a seat (and pay the seller) | 15 Tgas |
| Leave before the start (and get the deposit back) | 12 Tgas |
| Release deposits (2 transfers) | 13–14 Tgas |
| List a seat, close a circle | 1 Tgas |

A 5-member circle over 5 rounds is about 35 transactions, roughly 0.04 NEAR of relayer gas.
