# Fees and minimums (measured)

Dry-run quotes from the 1Click API on Oct 31, 2026 (unauthenticated), from `scripts/probe-1click.mjs`. No money moved. Re-run the probe before quoting these numbers anywhere public.

The circle asset is USDT on NEAR inside NEAR Intents: `nep141:usdt.tether-token.near` (6 decimals).

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
- Members cash out once, when they want, and the app recommends BNB Chain or Solana.
- Tron works for top-ups of about 2.56 USDT or more, but the app warns that cashing out to Tron costs about 1.56 USDT.

## Bridge limits for Tron (PoA bridge `supported_tokens`)

| Asset | Min deposit | Min withdrawal | Withdrawal fee |
| --- | --- | --- | --- |
| USDT (TRC-20) | 1 USDT | 1 USDT | 1 USDT |
| TRX | 4 TRX | 0.000001 TRX | 0.29 TRX |

## Deploying the contract

Storage on NEAR is staked, not spent: an account locks 1 NEAR per 100 KB it stores, and gets it back when the storage is freed.

| Version | Contract size | Storage locked |
| --- | --- | --- |
| First build | 271 KB | 2.71 NEAR |
| Text messages, lookup map, no embedded ABI | 193 KB | 1.93 NEAR |
| Own JSON reader and writer, no serde_json | 110 KB | 1.10 NEAR |
| Plain storage and promise calls instead of the SDK's collections and promise builder | 83 KB | 0.83 NEAR |
| Direct calls for NEAR accounts and the embedded ABI added back | **88 KB** | **0.88 NEAR** |

The 193 KB step removed two things: direct calls for members with a NEAR account, and the embedded ABI. Both are back in the last row (the ABI is generated from typed declarations in `contract/interface`, see `contract/abi/README.md`). Nothing else was removed, and the later steps added NFT enumeration views, NEP-171 events and a round-deadline view. CI measures the size on every push (`ci-results` branch, `size.json`).

Expected total to launch: 0.88 NEAR for the code, up to 0.03 NEAR per circle for its data (a 20-member circle with its full payout history is about 3 KB; a 5-member one under 1 KB), and gas for the relayer. Storage is locked, not spent: it comes back when the data or the contract is deleted.
