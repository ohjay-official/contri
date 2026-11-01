# Contract methods

Every method takes JSON arguments and returns JSON, like any near-sdk contract. The contract reads and writes that JSON itself instead of using serde (see `contract/src/json.rs`), which keeps the code under 100 KB.

The same reference in machine-readable form is the contract's ABI: [`contract/abi/contri_abi.json`](../contract/abi/contri_abi.json), also returned on chain by the `__contract_abi` view (zstd-compressed, as cargo-near embeds it). It is generated from typed declarations of these methods in `contract/interface`, and tests check that every value the contract returns matches those types.

Conventions:

- Amounts are strings in the token's smallest unit (USDT has 6 decimals, so `"5000000"` is 5 USDT).
- Timestamps are strings in nanoseconds.
- Circle ids, seats and rounds are numbers starting at 0. Seat `n` is paid in round `n`.
- Integer arguments can be sent as a JSON number or a string (`0` or `"0"`).
- Bad arguments fail with `missing or invalid argument: <name>`. Malformed JSON fails with `arguments must be valid JSON`.

## Setup

| Method | Arguments | Notes |
| --- | --- | --- |
| `new` | `intents_id`, `token_id` | Init. `{"intents_id":"intents.near","token_id":"nep141:usdt.tether-token.near"}`. The caller becomes `owner_id`. |

## Called by NEAR Intents

Only `intents_id` can call these. Members never call them directly: they sign an intent and NEAR Intents calls the contract with the verified signer. Messages are listed in [ARCHITECTURE.md](ARCHITECTURE.md#message-formats).

| Method | Arguments | Returns |
| --- | --- | --- |
| `mt_on_transfer` | `sender_id`, `previous_owner_ids`, `token_ids`, `amounts`, `msg` | Amounts to refund, for example `["0"]`. NEP-245 receiver for a `Transfer` intent with a notification. A wrong token, amount or message is refunded in full, with the reason in the log. |
| `on_auth` | `signer_id`, `msg` | Nothing. Runs an `AuthCall` intent. Fails with the reason if the action is not allowed. |

## Called directly by a NEAR account

For members who have a NEAR account and want to call the contract from their wallet or the CLI. The caller is the member. Money still moves through NEAR Intents: joining, contributing and buying a seat are `Transfer` intents, which a NEAR account can sign with its own key.

| Method | Arguments | Returns |
| --- | --- | --- |
| `create_circle` | `name`, `contribution`, `size`, `period_secs` | The new circle's id |
| `list_seat` | `circle_id`, `seat`, `price` | Nothing |
| `unlist_seat` | `circle_id`, `seat` | Nothing |
| `cancel_circle` | `circle_id` | Nothing. Organizer only, before the circle starts. |
| `claim_credit` | none | Nothing. Sends what the caller is owed after a failed transfer. |

Example with near-cli (replace `contri.testnet` with the contract id in the README, and `alice.testnet` with your account):

```
near contract call-function as-transaction contri.testnet create_circle json-args '{"name":"Lagos Ajo","contribution":"5000000","size":5,"period_secs":86400}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as alice.testnet network-config testnet sign-with-keychain send
```

## Anyone can call

| Method | Arguments | Returns |
| --- | --- | --- |
| `settle_round` | `circle_id` | Nothing. After the round deadline, takes missed contributions from deposits and pays the pot. |
| `pay_out` | `circle_id` | Nothing. Pays the pot when every member has paid, for example after a failed payout. |
| `release_deposits` | `circle_id` | Number of deposits sent. After a circle finishes or is cancelled. Sends as many as the attached gas allows; call again for the rest. |

## Callbacks

Private: only the contract itself can call them.

| Method | Arguments | What it does |
| --- | --- | --- |
| `on_payout` | `circle_id`, `round`, `amount` | Closes the round if the payout transfer succeeded. If it failed, the pot stays and `pay_out` can retry. |
| `on_sent` | `to`, `amount` | If a transfer out failed, the amount becomes a credit the member can claim. |

## Views

| Method | Arguments | Returns |
| --- | --- | --- |
| `get_config` | none | `{"owner_id","intents_id","token_id","circle_count"}` |
| `get_circle` | `circle_id` | A circle (below) or `null` |
| `get_circles` | `from_index`, `limit` (optional, default 0 and 50, max 100) | Array of circles |
| `get_circles_for` | `account_id` | Ids of circles the account organizes or sits in, for example `[0, 2]` |
| `get_round_deadline` | `circle_id` | Deadline of the running round, or `null` |
| `get_record` | `account_id` | `{"completed","defaults","missed_payments"}` |
| `get_credit` | `account_id` | Amount the account can claim, for example `"0"` |
| `contract_source_metadata` | none | NEP-330 source metadata: version, repository link, standards |
| `__contract_abi` | none | The ABI, zstd-compressed JSON |

A circle:

```json
{
  "id": 0,
  "name": "Lagos Ajo",
  "organizer": "0xa0…01",
  "contribution": "5000000",
  "size": 3,
  "period_secs": 86400,
  "members": [
    {"account_id": "0xa0…01", "deposit": "5000000", "paid_this_round": true, "defaulted": false, "missed": 0}
  ],
  "listings": [null, "1000000", null],
  "status": "Active",
  "created_at": "0",
  "started_at": "10000000000",
  "round": 1,
  "pot": "5000000",
  "paying": false,
  "payouts": [{"round": 0, "to": "0xa0…01", "amount": "15000000", "at": "86400500000000"}],
  "round_deadline": "172810000000000"
}
```

`status` is `Open`, `Active`, `Finished` or `Cancelled`. `listings[n]` is the asking price for seat `n`, or `null`. `paying` is true while a payout transfer is in flight.

## Seats as NFTs

Each seat is a token `<circle>:<seat>`, owned by the member sitting in it. The views follow NEP-171 (core views), NEP-177 (metadata) and NEP-181 (enumeration). Seats change hands only through the contract's sale flow (`list_seat`, then `buy_seat`), which swaps the two turns and logs NEP-171 `nft_transfer` events. A cancelled circle's seats are burned.

| Method | Arguments | Returns |
| --- | --- | --- |
| `nft_metadata` | none | `{"spec":"nft-1.0.0","name":"Contri Seats","symbol":"SEAT","icon":…}` |
| `nft_token` | `token_id` | A token or `null` |
| `nft_total_supply` | none | Number of seats, for example `"12"` |
| `nft_tokens` | `from_index`, `limit` (optional) | Array of tokens |
| `nft_supply_for_owner` | `account_id` | Number of seats the account holds |
| `nft_tokens_for_owner` | `account_id`, `from_index`, `limit` | Array of tokens |

A token:

```json
{
  "token_id": "0:1",
  "owner_id": "0xb0…02",
  "metadata": {
    "title": "Lagos Ajo - turn 2",
    "description": "Turn 2 of 3 in Contri circle #0. Receives the pot in round 2.",
    "extra": "{\"circle\":0,\"seat\":1,\"payout_round\":1,\"price\":\"1000000\"}"
  }
}
```

## Events

Logged as NEP-297 `EVENT_JSON`.

| Standard | Event | Data |
| --- | --- | --- |
| `contri` | `circle_created` | `circle`, `organizer`, `contribution`, `size`, `period_secs` |
| `contri` | `joined` | `circle`, `member`, `seat` |
| `contri` | `circle_started` | `circle`, `first_deadline` |
| `contri` | `contributed` | `circle`, `round`, `member`, `amount` |
| `contri` | `round_settled` | `circle`, `round`, `covered_from_deposit` (accounts) |
| `contri` | `paid_out` | `circle`, `round`, `to`, `amount` |
| `contri` | `payout_failed` | `circle`, `round` |
| `contri` | `circle_finished` | `circle` |
| `contri` | `circle_cancelled` | `circle` |
| `contri` | `seat_listed`, `seat_unlisted` | `circle`, `seat`, `price` |
| `contri` | `seat_sold` | `circle`, `seat`, `buyer`, `seller`, `price`, `seller_new_seat` |
| `contri` | `credit_added` | `account`, `amount` |
| `nep171` | `nft_mint` | `owner_id`, `token_ids` |
| `nep171` | `nft_transfer` | `old_owner_id`, `new_owner_id`, `token_ids` |
| `nep171` | `nft_burn` | `owner_id`, `token_ids` |

## Storage layout

Each item has its own key, so a call reads and writes only what it touches. Values are borsh.

| Key | Value |
| --- | --- |
| `STATE` | `owner_id`, `intents_id`, `token_id`, `next_circle_id` |
| `c` + circle id (8 bytes, little endian) | Circle |
| `r` + account id | Record |
| `k` + account id | Credit (u128). Removed when claimed. |
