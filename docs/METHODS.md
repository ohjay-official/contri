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

Only `intents_id` can call these. Members never call them directly: they sign an intent and NEAR Intents calls the contract with the verified signer. A DAO treasury or any NEAR account can also call `mt_transfer_call` on `intents.near` from its own balance, which reaches `mt_on_transfer` the same way. Messages are listed in [ARCHITECTURE.md](ARCHITECTURE.md#message-formats).

| Method | Arguments | Returns |
| --- | --- | --- |
| `mt_on_transfer` | `sender_id`, `previous_owner_ids`, `token_ids`, `amounts`, `msg` | Amounts to refund, for example `["0"]`. NEP-245 receiver. `msg` joins, contributes, buys a seat, refills a deposit or backs a circle. A wrong token, amount, message or invite is refunded in full, with the reason in the log. |
| `on_auth` | `signer_id`, `msg` | Nothing. Runs an `AuthCall` intent. Fails with the reason if the action is not allowed. |

## Called directly by a NEAR account

For members who have a NEAR account and want to call the contract from their wallet or the CLI. The caller is the member. Money still moves through NEAR Intents: joining, contributing and buying a seat are `Transfer` intents, which a NEAR account can sign with its own key.

| Method | Arguments | Returns |
| --- | --- | --- |
| `create_circle` | `name`, `contribution`, `size`, `period_secs`, `order` (optional: `join` or `random`), `invite_key` (optional, 64 hex). Attach 0.01 NEAR for the circle's storage | The new circle's id. The caller organizes without taking a seat (a DAO organizing for its members, say) |
| `leave_circle` | `circle_id` | Nothing. Leaves a circle that has not started; the deposit comes back. |
| `list_seat` | `circle_id`, `seat`, `price` | Nothing |
| `unlist_seat` | `circle_id`, `seat` | Nothing |
| `cancel_circle` | `circle_id` | Nothing. Cancels a circle that has not started: the organizer at any time, anyone once it has stayed unfilled past `fill_by` (14 days). |
| `claim_credit` | none | Nothing. Sends what the caller is owed after a failed transfer. |

Example with near-cli (replace `contri.testnet` with the contract id in the README, and `alice.testnet` with your account):

```
near contract call-function as-transaction contri.testnet create_circle json-args '{"name":"Lagos Ajo","contribution":"5000000","size":5,"period_secs":86400}' prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as alice.testnet network-config testnet sign-with-keychain send
```

## Anyone can call

| Method | Arguments | Returns |
| --- | --- | --- |
| `settle_round` | `circle_id` | Nothing. After the round deadline, takes each missed contribution from the member's deposit, then from the circle's backing, and pays the pot. |
| `pay_out` | `circle_id` | Nothing. Pays the pot when every member has paid, for example after a failed payout. |
| `release_deposits` | `circle_id` | Number of transfers sent. After a circle finishes or is cancelled, sends members' remaining deposits and backers' shares of the leftover backing, as many as the attached gas allows; call again for the rest. |
| `close_circle` | `circle_id` | Nothing. Deletes a finished or cancelled circle once all its money has gone back, freeing its storage. Members' records stay. |

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
  "name": "c2VhbGVkOmdhOuWm3k1Lq0…",
  "organizer": "0xa0…01",
  "contribution": "5000000",
  "size": 3,
  "period_secs": 86400,
  "members": [
    {"account_id": "0xa0…01", "deposit": "5000000", "paid_this_round": true, "defaulted": false, "missed": 0}
  ],
  "listings": [null, "1000000", null],
  "invite_only": true,
  "random_order": true,
  "fill_by": "1209600000000000",
  "backing": "6000000",
  "backers": [{"account_id": "lagos-coop.sputnik-dao.near", "amount": "6000000", "due": "0"}],
  "status": "Active",
  "created_at": "0",
  "started_at": "10000000000",
  "round": 1,
  "pot": "5000000",
  "paying": false,
  "payouts": [{"round": 0, "to": "0xa0…01", "amount": "15000000", "shortfall": "0", "at": "86400500000000"}],
  "round_deadline": "172810000000000"
}
```

`name` is ciphertext: the app encrypts it with a key from the invite link (see [PRIVACY.md](PRIVACY.md)). `invite_only` means joining needs a signed invite. With `random_order`, the contract draws the turn order from NEAR's per-block random seed when the circle fills. After `fill_by`, anyone can cancel the circle if it is still open. `status` is `Open`, `Active`, `Finished` or `Cancelled`. `listings[n]` is the asking price for seat `n`, or `null`. `paying` is true while a payout transfer is in flight. `backing` is community money not yet used to cover missed payments; each backer's `due` is their share of what was left when the circle ended, not yet sent. A payout's `shortfall` is how much less than a full pot it was.

A member's `deposit` is one contribution in an open circle. In an invite-only circle the invite sets it, up to every round but the member's own: less for someone the organizer trusts, more for a stranger. Members creating a circle through NEAR Intents send `create:...` with their deposit and take the first seat.

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
    "title": "Contri seat - turn 2 of 3",
    "description": "Receives the pot in round 2 of Contri circle #0.",
    "media": "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' …",
    "extra": "{\"circle\":0,\"seat\":1,\"payout_round\":1,\"price\":\"1000000\"}"
  }
}
```

`media` is a picture the contract draws from the circle's live state: a ring that fills round by round, the turn (`2/3`), and where the seat stands (`Pays this round`, `Paid out`, `For sale`, `Pays in round 3`). Seats become tokens when the circle fills and the turn order is final.

## Events

Logged as NEP-297 `EVENT_JSON`.

| Standard | Event | Data |
| --- | --- | --- |
| `contri` | `circle_created` | `circle`, `organizer`, `contribution`, `size`, `period_secs`, `invite_only`, `random_order` |
| `contri` | `joined` | `circle`, `member`, `seat`, `deposit` |
| `contri` | `circle_started` | `circle`, `first_deadline` |
| `contri` | `contributed` | `circle`, `round`, `member`, `amount` |
| `contri` | `round_settled` | `circle`, `round`, `missed` (accounts), `from_backing` |
| `contri` | `paid_out` | `circle`, `round`, `to`, `amount`, `shortfall` |
| `contri` | `circle_backed` | `circle`, `backer`, `amount`, `backing` |
| `contri` | `deposit_refilled` | `circle`, `member`, `deposit` |
| `contri` | `payout_failed` | `circle`, `round` |
| `contri` | `circle_finished` | `circle` |
| `contri` | `circle_cancelled` | `circle`, `by` |
| `contri` | `left` | `circle`, `member` |
| `contri` | `circle_closed` | `circle` |
| `contri` | `seat_listed`, `seat_unlisted` | `circle`, `seat`, `price` |
| `contri` | `seat_sold` | `circle`, `seat`, `buyer`, `seller`, `price`, `seller_new_seat` |
| `contri` | `credit_added` | `account`, `amount` |
| `nep171` | `nft_mint` | One entry per seat, in turn order, when the circle starts: `owner_id`, `token_ids` |
| `nep171` | `nft_transfer` | `old_owner_id`, `new_owner_id`, `token_ids` |

## Storage layout

Each item has its own key, so a call reads and writes only what it touches. Values are borsh.

| Key | Value |
| --- | --- |
| `STATE` | `owner_id`, `intents_id`, `token_id`, `next_circle_id` |
| `c` + circle id (8 bytes, little endian) | Circle |
| `r` + account id | Record |
| `k` + account id | Credit (u128). Removed when claimed. |
