# Contri architecture

The pot never sits with a person or a server. It sits in the Contri contract's balance on NEAR Intents (`intents.near`), and only the contract can move it.

## Actors

| Actor | What it is | What it can do |
| --- | --- | --- |
| Member | A person with a passkey (or a Tron/EVM wallet) | Sign intents: top up, contribute, join, list or buy a seat, cash out |
| Contri contract | A NEAR smart contract (`contri.<owner>.near`) | Record contributions, enforce the turn order, pay out, swap seats |
| Relayer | A small server that submits already-signed intents to `intents.near` and pays NEAR gas | Nothing on its own. It cannot forge a member signature or move funds |
| Settler | Anyone. In practice a cron job | Call `settle_round` after a deadline. The contract decides what happens |

## Member identity: no NEAR account needed

NEAR Intents derives an account id from the signer's public key (`contracts/defuse/core/src/public_key.rs`, `to_implicit_account_id`):

- secp256k1 keys (Tron and EVM wallets): `0x` + hex(keccak256(pubkey)[12..32]). For a Tron wallet this is the same 20 bytes as the Tron address.
- P-256 keys (passkeys): `0x` + hex(keccak256("p256" || pubkey)[12..32]).

So a member who signs in with a phone passkey already has an Intents account. They never create a NEAR account or hold NEAR for gas.

Members who do have a NEAR account can use it too: it signs intents with its own key, and it can also call `create_circle`, `list_seat`, `unlist_seat`, `cancel_circle` and `claim_credit` directly (see [METHODS.md](METHODS.md#called-directly-by-a-near-account)).

## Money path

### 1. Top up (any chain, any wallet, any exchange)
The app asks the 1Click API for a quote:
- `originAsset`: what the member holds (for example USDT on Tron)
- `destinationAsset`: the circle's asset inside Intents (USDT)
- `recipientType: INTENTS`, `recipient`: the member's own Intents account
- `depositType: ORIGIN_CHAIN`

The member sends to the quote's deposit address from any wallet or exchange. The funds land in their own Intents balance.

### 2. Contribute (trustless attribution)
The member signs a `Transfer` intent with their passkey:
- `receiver_id`: the Contri contract
- `tokens`: `{ <circle asset>: <contribution> }`
- `msg` (notification): `contribute:<circle>:<round>`

The relayer submits it with `execute_intents`. `intents.near` moves the balance and calls `contri.mt_on_transfer(sender_id, ..., msg)`. The contract checks that `sender_id` is a member of that circle, that the amount is right, and records the payment. No server is trusted to say who paid. (Transfer notification: `contracts/defuse/core/src/intents/tokens.rs`, `NotifyOnTransfer`.)

Joining works the same way: the deposit is a `Transfer` with `msg` `join:<circle>`.

### 3. Authenticated actions
Listing a seat for sale is an `AuthCall` intent: `intents.near` calls `contri.on_auth(signer_id, msg)`. The contract only accepts `on_auth` and `mt_on_transfer` when the predecessor is `intents.near`, so `signer_id` is the verified member. (`crates/near/auth-call/src/lib.rs`.)

### 4. Payout
After a round is complete, the contract moves the pot to the round's member by calling `intents.near` directly as the predecessor (an `mt_transfer` of its own balance to the member's Intents account). Accounts can act on their own Intents balance this way unless they turned it off (`ensure_auth_predecessor_id` in `contracts/defuse/src/contract/accounts/mod.rs`).

Stretch: pay straight to a Tron address with `ft_withdraw` to the PoA token and the memo `WITHDRAW_TO:<address>` (`contracts/poa/token/src/lib.rs`).

### 5. Cash out
The member cashes out from their Intents balance to any chain with a 1Click quote (`depositType: INTENTS`, `recipientType: DESTINATION_CHAIN`), signed with their passkey through `/v0/generate-intent` and `/v0/submit-intent` (`standard: webauthn`).

## Signing with a passkey

A passkey-signed intent is a `webauthn` payload (`contracts/defuse/core/src/payload/webauthn.rs`, test vector included there):

```json
{
  "standard": "webauthn",
  "payload": "{\"signer_id\":\"0x…\",\"verifying_contract\":\"intents.near\",\"deadline\":\"<ISO time>\",\"nonce\":\"<base64 32 bytes>\",\"intents\":[{\"intent\":\"transfer\",\"receiver_id\":\"contri.<owner>.near\",\"tokens\":{\"nep141:usdt.tether-token.near\":\"5000000\"},\"msg\":\"contribute:0:0\",\"min_gas\":\"100000000000000\"}]}",
  "public_key": "p256:<base58>",
  "signature": "p256:<base58 r||s>",
  "client_data_json": "…",
  "authenticator_data": "<base64url>"
}
```

- The WebAuthn challenge is `base64url(sha256(payload))`.
- `signer_id` is the passkey's implicit account (`0x` + keccak256("p256" || pubkey) last 20 bytes).
- Nonces: legacy random 32-byte nonces are still accepted; the newer versioned nonce (magic prefix `5628f6c6` + salted, expirable nonce) uses `intents.near`'s current salt. Contri will use versioned nonces.

## Message formats

Messages are short text, not JSON. Storage on NEAR costs 1 NEAR per 100 KB of contract code, and parsing text by hand keeps the contract much smaller than a JSON library would.

| Sent as | Message | Meaning |
| --- | --- | --- |
| `Transfer` notification | `join:<circle>` or `join:<circle>:<invite signature>` | Pay the deposit and take the next seat. An invite-only circle needs the invite key's signature (128 hex) over `contri-join:<contract>:<circle>:<joiner>:<deposit>`; the deposit is the transferred amount, at most one contribution |
| `Transfer` notification or `mt_transfer_call` | `back:<circle>` | Back a circle with at least one contribution (for example from a DAO treasury) |
| `Transfer` notification | `refill:<circle>` | Top up your own deposit, to at most one contribution |
| `Transfer` notification | `contribute:<circle>:<round>` | Pay this round |
| `Transfer` notification | `buy_seat:<circle>:<seat>` | Buy a listed, earlier seat |
| `AuthCall` | `create:<contribution>:<size>:<period_secs>:<order>:<invite key>:<name>` | Create a circle. Order: `join` or `random` (drawn when the circle fills). Invite key: 64 hex (ed25519 public key) or `-` for an open circle. The name is encrypted by the app |
| `AuthCall` | `leave:<circle>` | Leave a circle that has not started; the deposit comes back |
| `AuthCall` | `list_seat:<circle>:<seat>:<price>` | List your seat for sale |
| `AuthCall` | `unlist_seat:<circle>:<seat>` | Take it off sale |
| `AuthCall` | `cancel:<circle>` | Cancel a circle that has not started: the organizer, or anyone after `fill_by` |
| `AuthCall` | `claim_credit` | Claim money from a transfer that failed |

## Missed payments
A member's deposit is one contribution, or less if their invite says so. After a round deadline, anyone can call `settle_round`. For each member who has not paid, the contract takes the missing amount from their deposit, then from the circle's community backing, marks them as having defaulted, and pays out. If both run out, the pot is short and the payout records the shortfall. A member can refill their deposit with `refill:<circle>`. A defaulting member loses their completed-circle record.

## Community-backed circles
Any account can put money behind a circle with `back:<circle>`: a cooperative's DAO treasury, a church, an employer. A Trezu or Sputnik DAO does it with one proposal that calls `mt_transfer_call` on `intents.near` (template in [integrations/trezu](../integrations/trezu)). The backing covers missed payments after deposits. When the circle ends or is cancelled, what is left is split back between the backers in proportion to what each put in, and `release_deposits` sends it.

## Fair turns, and circles that never fill
Who goes first is a classic ajo argument. An organizer can choose `random`, and when the circle fills the contract draws the turn order from NEAR's per-block random seed (`env::random_seed`), so nobody, the organizer included, picks it. Members who want a different turn can then trade seats.

Before a circle starts, a member can leave and get their deposit back. If a circle hasn't filled 14 days after it was created (`fill_by`), anyone can cancel it, so deposits never get stuck behind an organizer who disappeared. Once a finished or cancelled circle has paid everything back, anyone can call `close_circle` to delete it and free its storage.

## Seats as NFTs
Each turn is a seat token `<circle>:<turn>`, owned by the member's Intents account. Seats become tokens when the circle fills and the turn order is final. The contract has the NEP-171 core views, NEP-177 metadata and NEP-181 enumeration (`nft_token`, `nft_tokens`, `nft_tokens_for_owner`, `nft_total_supply`, `nft_supply_for_owner`, `nft_metadata`), and logs NEP-171 `nft_mint` and `nft_transfer` events so NFT indexers can follow the seats. Each token's picture (`media`) is drawn by the contract from live state, so it changes as the circle runs: a ring that fills round by round and a line saying whether the seat pays this round, has been paid, is for sale, or which round it pays in. Seats change hands only through the contract: the seller lists with an `AuthCall`, the buyer pays the price with a `Transfer` (`buy_seat:<circle>:<seat>`), and the contract swaps the two turns and forwards the price to the seller. See [METHODS.md](METHODS.md#seats-as-nfts).

## Verified against source vs still to test

| Claim | Status |
| --- | --- |
| Wallet and passkey keys map to Intents accounts | Verified in `near/intents` source |
| `Transfer` can notify the receiver via `mt_on_transfer` | Verified in source |
| `AuthCall` passes a verified `signer_id` to `on_auth` | Verified in source |
| A contract can move its own Intents balance as predecessor | Verified in source |
| 1Click route Tron USDT to an Intents account, fees and minimums | To test (`scripts/probe-1click.mjs`) |
| Passkey (`webauthn`) signed `Transfer` accepted end to end | To test with a $1 run |
| Cash-out quote from Intents balance with a passkey signature | To test with a $1 run |
