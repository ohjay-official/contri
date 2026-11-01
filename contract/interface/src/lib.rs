//! Typed interface of the Contri contract.
//!
//! This crate is never deployed. The real contract (`contract/src/lib.rs`)
//! reads and writes its JSON by hand to stay under 100 KB, so near-sdk cannot
//! see its argument and result types. This crate declares the same methods
//! with typed signatures, and CI runs `cargo near abi` on it. The real
//! contract embeds that ABI and returns it from `__contract_abi`, exactly as a
//! contract built with cargo-near would.
//!
//! Two checks keep the two in step:
//! - the contract's unit tests parse every view's output into the types below,
//!   which reject unknown or missing fields;
//! - CI compares the method names in the ABI with the functions the built
//!   contract exports.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId, PanicOnDefault};

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub enum CircleStatus {
    /// Waiting for members to join and pay their deposit.
    Open,
    /// Full. Rounds are running.
    Active,
    /// Every member has had their turn.
    Finished,
    /// Cancelled by the organizer before it filled. Deposits are returned.
    Cancelled,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug)]
pub struct Member {
    pub account_id: AccountId,
    /// Deposit still held for this member. Covers a missed contribution.
    pub deposit: U128,
    pub paid_this_round: bool,
    /// Missed at least one payment in this circle.
    pub defaulted: bool,
    /// Payments missed in this circle.
    pub missed: u32,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug)]
pub struct Payout {
    pub round: u32,
    pub to: AccountId,
    pub amount: U128,
    /// How much less than a full pot (contribution x size) was paid.
    pub shortfall: U128,
    /// Block timestamp in nanoseconds.
    pub at: U64,
}

/// Money a community put behind a circle. It covers missed payments a deposit
/// can't; what is left is split back in proportion when the circle ends.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug)]
pub struct Backer {
    pub account_id: AccountId,
    pub amount: U128,
    /// Share of the leftover backing not yet sent back.
    pub due: U128,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug)]
pub struct Circle {
    pub id: u64,
    /// Encrypted by the app with a key from the invite link. The contract stores it as given.
    pub name: String,
    pub organizer: AccountId,
    /// Amount each member pays per round, in the token's smallest unit.
    pub contribution: U128,
    pub size: u32,
    pub period_secs: u64,
    /// Index = seat = turn. Seat `n` receives the pot in round `n`.
    pub members: Vec<Member>,
    /// Asking price per seat, or `null` when the seat is not for sale.
    pub listings: Vec<Option<U128>>,
    /// Joining needs a signed invite from the circle's invite link.
    pub invite_only: bool,
    /// Turns are drawn at random when the circle fills.
    pub random_order: bool,
    /// Nanoseconds. After this, anyone can cancel the circle if it is still open.
    pub fill_by: U64,
    /// Community backing not yet used.
    pub backing: U128,
    pub backers: Vec<Backer>,
    pub status: CircleStatus,
    /// Nanoseconds.
    pub created_at: U64,
    /// Nanoseconds. `"0"` until the circle fills.
    pub started_at: U64,
    /// The round being paid now, from 0.
    pub round: u32,
    pub pot: U128,
    /// A payout transfer is in flight.
    pub paying: bool,
    pub payouts: Vec<Payout>,
    /// Deadline of the running round in nanoseconds, or `null`.
    pub round_deadline: Option<U64>,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug)]
pub struct Config {
    pub owner_id: AccountId,
    pub intents_id: AccountId,
    /// The circle asset on NEAR Intents, e.g. `nep141:usdt.tether-token.near`.
    pub token_id: String,
    pub circle_count: u64,
}

/// A member's track record across finished circles.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug)]
pub struct Record {
    pub completed: u32,
    pub defaults: u32,
    pub missed_payments: u32,
}

/// NEP-177 contract metadata.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug)]
pub struct NftContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

/// NEP-177 token metadata. `extra` is JSON text:
/// `{"circle":0,"seat":1,"payout_round":1,"price":"1000000"|null}`.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug)]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    /// SVG data URL drawn by the contract from the circle's live state.
    pub media: Option<String>,
    pub extra: Option<String>,
}

/// A seat as a NEP-171 token. `token_id` is `<circle>:<seat>`.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug)]
pub struct Token {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contri {}

#[near]
#[allow(unused_variables)]
impl Contri {
    /// Sets the NEAR Intents contract and the circle asset. The caller becomes the owner.
    #[init]
    pub fn new(intents_id: AccountId, token_id: String) -> Self {
        unimplemented!()
    }

    /// NEP-245 receiver, called by NEAR Intents (a signed `Transfer` or an
    /// account's `mt_transfer_call`). `msg`: `create:...` (with the organizer's
    /// deposit), `join:<c>[:<invite sig>]`, `contribute:<c>:<round>`,
    /// `buy_seat:<c>:<seat>`, `refill:<c>`, `back:<c>`. Returns refunds; bad
    /// input is refunded in full.
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> Vec<U128> {
        unimplemented!()
    }

    /// Called by NEAR Intents for a signed `AuthCall`. `msg`: `leave:<c>`,
    /// `list_seat:<c>:<seat>:<price>`, `unlist_seat:<c>:<seat>`, `cancel:<c>`,
    /// `claim_credit`.
    pub fn on_auth(&mut self, signer_id: AccountId, msg: String) {
        unimplemented!()
    }

    /// Direct call: creates a circle organized by the caller, who doesn't take
    /// a seat. Attach 0.01 NEAR for the circle's storage. Returns its id.
    /// `order` is `join` (default) or `random`. `invite_key` (64 hex
    /// characters, ed25519) makes the circle invite-only.
    #[payable]
    pub fn create_circle(
        &mut self,
        name: String,
        contribution: U128,
        size: u32,
        period_secs: u64,
        order: Option<String>,
        invite_key: Option<String>,
    ) -> u64 {
        unimplemented!()
    }

    /// Direct call: leave a circle that has not started; the deposit comes back.
    pub fn leave_circle(&mut self, circle_id: u64) {
        unimplemented!()
    }

    /// Direct call: lists the caller's seat for sale at `price`.
    pub fn list_seat(&mut self, circle_id: u64, seat: u32, price: U128) {
        unimplemented!()
    }

    /// Direct call: takes the caller's seat off sale.
    pub fn unlist_seat(&mut self, circle_id: u64, seat: u32) {
        unimplemented!()
    }

    /// Cancels a circle that has not started: the organizer at any time, or
    /// anyone once the circle has stayed unfilled past its `fill_by`.
    pub fn cancel_circle(&mut self, circle_id: u64) {
        unimplemented!()
    }

    /// Direct call: sends the caller money owed after a failed transfer.
    pub fn claim_credit(&mut self) {
        unimplemented!()
    }

    /// Anyone, after the round deadline: missed contributions come out of
    /// deposits, then the pot is paid out.
    pub fn settle_round(&mut self, circle_id: u64) {
        unimplemented!()
    }

    /// Anyone: deletes a finished or cancelled circle once all its money has
    /// gone back, freeing its storage. Members' records stay.
    pub fn close_circle(&mut self, circle_id: u64) {
        unimplemented!()
    }

    /// Anyone: pays the pot when every member has paid, for example after a failed payout.
    pub fn pay_out(&mut self, circle_id: u64) {
        unimplemented!()
    }

    /// Anyone, after a circle finished or was cancelled: returns remaining
    /// deposits, as many as the attached gas allows. Returns how many were sent.
    pub fn release_deposits(&mut self, circle_id: u64) -> u32 {
        unimplemented!()
    }

    /// Callback after a payout transfer. Closes the round if it succeeded.
    #[private]
    pub fn on_payout(&mut self, circle_id: u64, round: u32, amount: U128) {
        unimplemented!()
    }

    /// Callback after any other transfer out. A failed one becomes a claimable credit.
    #[private]
    pub fn on_sent(&mut self, to: AccountId, amount: U128) {
        unimplemented!()
    }

    pub fn get_config(&self) -> Config {
        unimplemented!()
    }

    pub fn get_circle(&self, circle_id: u64) -> Option<Circle> {
        unimplemented!()
    }

    /// Deadline of the running round in nanoseconds, or `null`.
    pub fn get_round_deadline(&self, circle_id: u64) -> Option<U64> {
        unimplemented!()
    }

    /// Circles in id order. `from_index` defaults to 0, `limit` to 50 (at most 100).
    pub fn get_circles(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Circle> {
        unimplemented!()
    }

    /// Ids of the circles this account organizes or sits in.
    pub fn get_circles_for(&self, account_id: AccountId) -> Vec<u64> {
        unimplemented!()
    }

    pub fn get_record(&self, account_id: AccountId) -> Record {
        unimplemented!()
    }

    /// Amount owed to this account after a failed transfer.
    pub fn get_credit(&self, account_id: AccountId) -> U128 {
        unimplemented!()
    }

    pub fn nft_metadata() -> NftContractMetadata {
        unimplemented!()
    }

    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        unimplemented!()
    }

    pub fn nft_total_supply(&self) -> U128 {
        unimplemented!()
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        unimplemented!()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        unimplemented!()
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        unimplemented!()
    }
}
