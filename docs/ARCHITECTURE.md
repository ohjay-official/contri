# Contri architecture

The pot never sits with a person or a server. It sits in the Contri contract's balance on NEAR Intents (`intents.near`), and the contract's code only moves it by a circle's rules. Until the contract is locked, the key it was deployed with (also the relayer's key) can upgrade that code; locking deletes every key on the account. See [SECURITY.md](SECURITY.md).

## Actors

| Actor | What it is | What it can do |
| --- | --- | --- |
| Member | A person with a passkey, or a NEAR account | Sign intents: join, contribute, list or buy a seat, leave, cash out |
| Contri contract | A NEAR smart contract. Its account holds one key, the deploy key, until it is locked; then none | Record contributions, enforce the turn order, pay out, swap seats |
| Relayer (`app/server/relay.js`) | A Vercel function that submits already-signed intents to `intents.near` and pays the NEAR gas | It can't forge a member's signature or move a member's funds. It relays only Contri's token: transfers to Contri with a message the contract reads, and auth calls, after checking them against `get_circle` as the contract would; and transfers to a 1Click deposit account Contri's server opened in the last 30 minutes, with a ticket bound to that account, the payer and the exact amount, usable once. Until the lock, its key is also the contract account's key |
| Keeper (`app/server/keeper.js`) | The same code on a 10-minute GitHub Actions schedule, a daily Vercel cron, and on demand from the app | Call `settle_round`, `pay_out`, `release_deposits`, `cancel_circle` (past `fill_by`) and `close_circle` when a circle needs them. Anyone could; the contract decides what happens |
| 1Click | NEAR Intents' cross-chain service | Turns a deposit on another chain into USDT in a member's Intents account, and back out |

## Member identity: no NEAR account needed

NEAR Intents treats an ed25519 public key's implicit account (the key in hex, 64 characters) as an account that key controls, with no registration. Contri gives every member one such account per circle:

1. The member's passkey gives the app a 32-byte secret through the WebAuthn PRF extension (`app/public/js/lib/passkey.js`). Only that passkey, on Contri's site, can produce it.
2. The app derives the n-th circle key as `HKDF-SHA256(secret, "contri/circle/<contract>/<n>")` and imports it as an Ed25519 WebCrypto key (`app/public/js/lib/keys.js`). Its implicit account is the member's account in that circle.
3. On a new phone the same synced passkey gives the same secret; the app checks accounts n = 0, 1, 2... on chain until three in a row are unused (`app/public/js/app/wallet.js`).

So members never create a NEAR account, hold NEAR for gas, or see a seed phrase, and no key on chain links one member's circles (amounts, timing and private-balance moves still can; see [PRIVACY.md](PRIVACY.md)). Where a passkey can't give a PRF secret, a random key kept in the browser, unencrypted like a hot wallet, with a written-down recovery code takes its place.

Members who do have a NEAR account can use it too: it signs intents with its own key, and it can also call `create_circle`, `list_seat`, `unlist_seat`, `cancel_circle` and `claim_credit` directly (see [METHODS.md](METHODS.md#called-directly-by-a-near-account)).

## Money path

### 1. Top up (any chain, any wallet, any exchange)
The app asks the 1Click API for a quote:
- `originAsset`: what the member holds (for example USDT on Tron)
- `destinationAsset`: the circle's asset inside Intents (USDT)
- `recipientType: INTENTS`, `recipient`: the member's circle account; refunds go to the same account (`refundType: INTENTS`), so no other address is asked for
- `depositType: ORIGIN_CHAIN`, `swapType: FLEX_INPUT`, so a slightly different amount from an exchange withdrawal still goes through

The member sends to the quote's deposit address from any wallet or exchange. The funds land in their circle account's Intents balance. The API key stays on the server (`app/server/oneclick.js`).

### 2. Contribute (trustless attribution)
The member's app signs a `Transfer` intent with the circle key:
- `receiver_id`: the Contri contract
- `tokens`: `{ <circle asset>: <contribution> }`
- `msg` (notification): `contribute:<circle>:<round>`

The relayer submits it with `execute_intents`. `intents.near` moves the balance and calls `contri.mt_on_transfer(sender_id, ..., msg)`. The contract checks that `sender_id` is a member of that circle, that the amount is right, and records the payment. No server is trusted to say who paid. (Transfer notification: `contracts/defuse/core/src/intents/tokens.rs`, `NotifyOnTransfer`.)

Joining works the same way: the deposit is a `Transfer` with `msg` `join:<circle>`.

### 3. Authenticated actions
Listing a seat for sale is an `AuthCall` intent: `intents.near` calls `contri.on_auth(signer_id, msg)`. The contract only accepts `on_auth` and `mt_on_transfer` when the predecessor is `intents.near`, so `signer_id` is the verified member. (`crates/near/auth-call/src/lib.rs`.)

### 4. Payout
After a round is complete, the contract moves the pot to the round's member by calling `intents.near` directly as the predecessor (an `mt_transfer` of its own balance to the member's Intents account). Accounts can act on their own Intents balance this way unless they turned it off (`ensure_auth_predecessor_id` in `contracts/defuse/src/contract/accounts/mod.rs`).


### 5. Cash out
The member cashes out from a circle account to any chain with a 1Click quote (`depositType: INTENTS`, `recipientType: DESTINATION_CHAIN`). The quote's deposit address is an account inside NEAR Intents; the app signs a plain `transfer` to it, the relayer submits it, and the app tells 1Click the transaction hash (`/v0/deposit/submit`).

The same legs also run through Confidential Intents for the private balance (`CONFIDENTIAL_INTENTS` deposit and recipient types), and direct top-ups and cash-outs ask for the confidential route too, so their deposit addresses can't be looked up on 1Click. See [PRIVACY.md](PRIVACY.md).

## Signing an intent

A member's app signs NEP-413 payloads with the circle key (`app/public/js/lib/intents.js`):

```json
{
  "standard": "nep413",
  "payload": {
    "message": "{\"signer_id\":\"<circle account>\",\"deadline\":\"<now + 10 min>\",\"intents\":[{\"intent\":\"transfer\",\"receiver_id\":\"<contri>\",\"tokens\":{\"nep141:usdt.tether-token.near\":\"5000000\"},\"msg\":\"contribute:0:0\",\"min_gas\":\"100000000000000\"}]}",
    "nonce": "<base64, 32 bytes>",
    "recipient": "intents.near"
  },
  "public_key": "ed25519:<base58>",
  "signature": "ed25519:<base58>"
}
```

- The signature covers `sha256(u32 2^31+413 || borsh(message) || nonce || borsh(recipient) || None)`.
- The nonce is a versioned V1 nonce: magic `5628f6c6`, version 0, `intents.near`'s `current_salt`, the deadline in nanoseconds, then the signing time and 7 random bytes, laid out as the NEAR Intents SDK does. 1Click accepts the same signature to sign a member in (checked on mainnet by `scripts/probe-confidential.mjs`).
- The relayer re-checks the signature and allows only Contri's token: transfers to Contri with a message the contract reads (checked against `get_circle` first, so a payment the contract would refund costs no gas), plain transfers to a 1Click deposit account Contri's server opened in the last 30 minutes (cash-outs, proven by an HMAC ticket), and `auth_call`s to Contri. It counts requests per caller and per signer, shared by every server instance through Redis, with a cap of 60 relays a minute in all. Then it asks NEAR Intents to `simulate_intents`, and only then submits `execute_intents` with 300 Tgas.

## Message formats

Messages are short text, not JSON. Storage on NEAR costs 1 NEAR per 100 KB of contract code, and parsing text by hand keeps the contract much smaller than a JSON library would.

| Sent as | Message | Meaning |
| --- | --- | --- |
| `Transfer` notification | `create:<contribution>:<size>:<period_secs>:<order>:<invite key>:<name>` | Create a circle and take its first seat, sent with the organizer's deposit (one contribution), so creating costs real money. Order: `join` or `random` (drawn when the circle fills). Invite key: 64 hex (ed25519 public key) or `-` for an open circle. The name is encrypted by the app |
| `Transfer` notification | `join:<circle>` or `join:<circle>:<invite signature>` | Pay the deposit and take the next seat. An invite-only circle needs the invite key's signature (128 hex) over `contri-join:<contract>:<circle>:<joiner>:<deposit>`; the deposit must be exactly one contribution |
| `Transfer` notification or `mt_transfer_call` | `back:<circle>` | Back a circle with at least one contribution (for example from a DAO treasury) |
| `Transfer` notification | `refill:<circle>` | Top up your own deposit, to at most every round but your own |
| `Transfer` notification | `contribute:<circle>:<round>` | Pay this round |
| `Transfer` notification | `ahead:<circle>:<rounds>` | Pay `rounds` contributions at once: this round's if unpaid, then later rounds, which each new round takes one of as it starts |
| `Transfer` notification | `buy_seat:<circle>:<seat>` | Buy a listed, earlier seat |
| `AuthCall` | `leave:<circle>` | Leave a circle that has not started; the deposit comes back |
| `AuthCall` | `list_seat:<circle>:<seat>:<price>` | List your seat for sale |
| `AuthCall` | `unlist_seat:<circle>:<seat>` | Take it off sale |
| `AuthCall` | `cancel:<circle>` | Cancel a circle that has not started: the organizer, or anyone after `fill_by` |
| `AuthCall` | `claim_credit` | Claim money from a transfer that failed |

## Missed payments
Every member's deposit is exactly one contribution, in open and invite-only circles alike: the invite key travels in the link, so a deposit set by the invite would be set by whoever holds the link. After a round deadline, anyone can call `settle_round`. For each member who has not paid, the contract takes the missing amount from their deposit, then from the circle's community backing, marks them as having defaulted, and pays out. If both run out, the pot is short and the payout records the shortfall. What a member's own deposit didn't cover, they owe (`owed`, and `backed` for the part backing paid). When their own turn comes, that much is held back from their pot: first back into the backing, the rest kept (`recovered`) and shared, when the circle finishes, between the members whose pots were short, in proportion to how short, through `release_deposits`. The round's own recipient skipping their share owes nobody, since it would only have come back to them: their deposit isn't touched and it isn't counted as a shortfall. So never paying doesn't pay off later in the circle; a member who takes an early pot and then stops paying is still covered for one missed round by their deposit, then by backing, and after that the later seats take the shortfall. A member can refill their deposit with `refill:<circle>`, up to every round but their own (in the contract; not in the app yet). A round always gets a full period after the one before it closes, so a round settled late doesn't leave the next one already overdue. A defaulting member loses their completed-circle record.

## Community-backed circles
Any account can put money behind a circle with `back:<circle>`: a cooperative's DAO treasury, a church, an employer. A Trezu or Sputnik DAO does it with one proposal that calls `mt_transfer_call` on `intents.near` (template in [integrations/trezu](../integrations/trezu)). The backing covers missed payments after deposits. When the circle ends or is cancelled, what is left is split back between the backers in proportion to what each put in, and `release_deposits` sends it.

## Fair turns, and circles that never fill
Who goes first is a classic ajo argument. An organizer can choose `random`, and when the circle fills the contract draws the turn order from NEAR's per-block random seed (`env::random_seed_array`), so no member, the organizer included, picks it. It is best effort: block producers could bias the seed. Members who want a different turn can then trade seats.

Before a circle starts, a member can leave and get their deposit back. If a circle hasn't filled 14 days after it was created (`fill_by`), anyone can cancel it, and the keeper does, so deposits never get stuck behind an organizer who disappeared. Once a finished or cancelled circle has paid everything back, anyone can call `close_circle` to delete it and free its storage; the keeper does this for cancelled circles.

## Seats as NFTs
Each turn is a seat token `<circle>:<turn>`, owned by the member's Intents account. Seats become tokens when the circle fills and the turn order is final. The contract has the NEP-171 core views, NEP-177 metadata and NEP-181 enumeration (`nft_token`, `nft_tokens`, `nft_tokens_for_owner`, `nft_total_supply`, `nft_supply_for_owner`, `nft_metadata`), and logs NEP-171 `nft_mint` and `nft_transfer` events so NFT indexers can follow the seats. Each token's picture (`media`) is drawn by the contract from live state, so it changes as the circle runs: a ring that fills round by round and a line saying whether the seat pays this round, has been paid, is for sale, or which round it pays in. Seats change hands only through the contract: the seller lists with an `AuthCall`, the buyer pays the price with a `Transfer` (`buy_seat:<circle>:<seat>`), and the contract swaps the two turns and forwards the price to the seller. See [METHODS.md](METHODS.md#seats-as-nfts).

## Verified against source vs still to test

| Claim | Status |
| --- | --- |
| An ed25519 key's implicit account is an Intents account with no registration | Verified in `near/intents` source |
| `Transfer` can notify the receiver via `mt_on_transfer` | Tested end to end against NEAR Intents built from source (`contract/sandbox`) |
| `AuthCall` passes a verified `signer_id` to `on_auth` | Tested end to end |
| A contract can move its own Intents balance as predecessor | Tested end to end: payouts, seat sales, refunds of deposits |
| An ed25519 key's implicit account signs NEP-413 intents, no NEAR account | Tested end to end |
| A whole circle (create, joins, seat sale, payouts, missed payment, release, close) leaves no money behind | Tested end to end |
| The app's own code (derived keys, invite signatures, encrypted names, versioned nonces, relayer, read proxy, keeper) runs a whole circle | Tested end to end (`the_app_runs_a_circle_through_its_relayer`) |
| The relayer refuses intents it shouldn't pay for, and NEAR Intents' simulation catches overspending before gas is spent | Tested end to end |
| The app's NEP-413 signing and versioned nonce are accepted by 1Click on mainnet | Tested (`scripts/probe-confidential.mjs`: sign-in returns a session, confidential balances readable) |
| 1Click routes from BNB Chain, Solana and Tron into an Intents account, fees and minimums | Measured with dry quotes (`scripts/probe-1click.mjs`) |
| Top-up, contribution and cash-out with real money on mainnet | Done on 5 November 2026 (transactions in the README) |
| Confidential top-up, contribution and cash-out | Done on 5 November 2026 with real money: private top-up, private balance to a circle, circle to private balance, cash-out to BNB Smart Chain |
| The deploy script's lock deletes every key and leaves none on NEAR Intents | Tested end to end (`the_deploy_script_creates_upgrades_and_locks_the_contract`) |
| The payout callback has gas to spare in the biggest circle | Measured end to end: 5.5 Tgas of a 30 Tgas floor (`the_payout_callback_fits_its_gas_floor_in_the_biggest_circle`) |
