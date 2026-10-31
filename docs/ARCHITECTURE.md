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
- `msg` (notification): `{"op":"contribute","circle":<id>,"round":<n>}`

The relayer submits it with `execute_intents`. `intents.near` moves the balance and calls `contri.mt_on_transfer(sender_id, ..., msg)`. The contract checks that `sender_id` is a member of that circle, that the amount is right, and records the payment. No server is trusted to say who paid. (Transfer notification: `contracts/defuse/core/src/intents/tokens.rs`, `NotifyOnTransfer`.)

Joining works the same way: the deposit is a `Transfer` with `{"op":"join",...}`.

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
  "payload": "{\"signer_id\":\"0x…\",\"verifying_contract\":\"intents.near\",\"deadline\":\"<ISO time>\",\"nonce\":\"<base64 32 bytes>\",\"intents\":[{\"intent\":\"transfer\",\"receiver_id\":\"contri.<owner>.near\",\"tokens\":{\"nep141:usdt.tether-token.near\":\"5000000\"},\"msg\":\"{\\\"op\\\":\\\"contribute\\\",\\\"circle\\\":0,\\\"round\\\":0}\",\"min_gas\":\"100000000000000\"}]}",
  "public_key": "p256:<base58>",
  "signature": "p256:<base58 r||s>",
  "client_data_json": "…",
  "authenticator_data": "<base64url>"
}
```

- The WebAuthn challenge is `base64url(sha256(payload))`.
- `signer_id` is the passkey's implicit account (`0x` + keccak256("p256" || pubkey) last 20 bytes).
- Nonces: legacy random 32-byte nonces are still accepted; the newer versioned nonce (magic prefix `5628f6c6` + salted, expirable nonce) uses `intents.near`'s current salt. Contri will use versioned nonces.

## Missed payments
Each member's deposit equals one contribution. After a round deadline, anyone can call `settle_round`. If a member has not paid, the contract takes the missing amount from their deposit, marks them as having defaulted, and pays out. A defaulting member loses their completed-circle record.

## Seats as NFTs (NEP-171 views)
Each turn is a seat token `<circle>:<turn>`. The contract exposes NEP-171 view methods (`nft_token`, `nft_tokens_for_owner`) with the member's Intents account as owner. Seats change hands only through the contract: the seller lists with an `AuthCall`, the buyer pays the price with a `Transfer` (`{"op":"buy_seat",...}`), and the contract swaps the turn order and forwards the price to the seller.

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
