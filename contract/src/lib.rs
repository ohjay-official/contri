//! Contri: rotating savings circles where the contract holds the pot.
//!
//! Money lives in this contract's balance on NEAR Intents (`intents.near`).
//! Members are NEAR Intents accounts, usually derived from a passkey or a
//! Tron/EVM wallet key, so they never need a NEAR account.
//!
//! Entry points from NEAR Intents (predecessor must be `intents_id`):
//! - `mt_on_transfer`: a signed `Transfer` intent (or an account's own
//!   `mt_transfer_call`) with a notification message. Used to join (deposit),
//!   contribute, buy a seat, refill a deposit and back a circle.
//! - `on_auth`: a member's signed `AuthCall` intent. Used to create a circle,
//!   list or unlist a seat, cancel an unfilled circle and claim credits.
//!
//! Messages are compact text, for example `contribute:0:1`. See `parse_transfer`
//! and `parse_auth`. Every method, its arguments and its result are listed in
//! `docs/METHODS.md`.
//!
//! NEAR locks 1 NEAR per 100 KB of contract code, so this contract stays small:
//! it reads and writes JSON itself (`json.rs`, `jstr`), keeps each circle under
//! its own storage key with plain storage calls, and creates promises with
//! `env::promise_create`. These choices change the size, not the behaviour.

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, PromiseError};

#[cfg(target_arch = "wasm32")]
mod bump;
mod json;

#[cfg(test)]
mod json_tests;
#[cfg(test)]
mod tests;

pub const MIN_MEMBERS: u32 = 2;
pub const MAX_MEMBERS: u32 = 20;
pub const MIN_PERIOD_SECS: u64 = 60;
pub const MAX_PERIOD_SECS: u64 = 60 * 60 * 24 * 31;
/// Circle names arrive encrypted by the app (see docs/PRIVACY.md), so the
/// limit is on the stored bytes, not on readable characters.
pub const MAX_NAME_LEN: usize = 256;

const NS_PER_SEC: u64 = 1_000_000_000;
const GAS_MT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
/// Gas needed to start a payout from inside another call.
const GAS_FOR_PAYOUT: Gas = Gas::from_tgas(35);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const ZERO: NearToken = NearToken::from_yoctonear(0);
/// Most backers a circle takes, which bounds the gas to return their money.
pub const MAX_BACKERS: usize = 10;
/// Default and maximum page size for list views.
const PAGE: u64 = 50;
const MAX_PAGE: u64 = 100;

#[near(serializers = [borsh])]
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

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Member {
    pub account_id: AccountId,
    /// Deposit still held for this member. Covers a missed contribution.
    pub deposit: U128,
    pub paid_this_round: bool,
    pub defaulted: bool,
    pub missed: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct PayoutRecord {
    pub round: u32,
    pub to: AccountId,
    pub amount: U128,
    /// How much less than a full pot (contribution x size) this payout was,
    /// when missed payments were more than deposits and backing could cover.
    pub shortfall: U128,
    /// Block timestamp in nanoseconds.
    pub at: u64,
}

/// Money a community (a DAO treasury, a cooperative, a church, an employer)
/// puts behind a circle. It covers missed payments that a member's deposit
/// can't, and what is left goes back to the backers when the circle ends.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Backer {
    pub account_id: AccountId,
    /// What this backer put in.
    pub amount: U128,
    /// Their share of what was left when the circle ended, not yet sent.
    pub due: U128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Circle {
    pub id: u64,
    pub name: String,
    pub organizer: AccountId,
    /// Amount each member pays per round, in the token's smallest unit.
    pub contribution: U128,
    pub size: u32,
    pub period_secs: u64,
    /// Index = seat = turn. Seat `n` receives the pot in round `n`.
    pub members: Vec<Member>,
    /// Asking price per seat, if listed for sale.
    pub listings: Vec<Option<U128>>,
    /// Ed25519 public key of the circle's invite link. When set, joining needs
    /// a signature from the invite key over the joiner's account, so only
    /// people with the link can join (see `join_message`).
    pub invite_key: Option<[u8; 32]>,
    /// Community backing not yet used to cover missed payments.
    pub backing: U128,
    pub backers: Vec<Backer>,
    pub status: CircleStatus,
    pub created_at: u64,
    pub started_at: u64,
    pub round: u32,
    pub pot: U128,
    /// A payout is in flight. No other money movement for this circle until it resolves.
    pub paying: bool,
    pub payouts: Vec<PayoutRecord>,
}

/// A member's track record across circles.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Record {
    pub completed: u32,
    pub defaults: u32,
    pub missed_payments: u32,
}

impl CircleStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            CircleStatus::Open => "Open",
            CircleStatus::Active => "Active",
            CircleStatus::Finished => "Finished",
            CircleStatus::Cancelled => "Cancelled",
        }
    }
}

impl Record {
    pub fn to_json(&self) -> String {
        format!(
            r#"{{"completed":{},"defaults":{},"missed_payments":{}}}"#,
            self.completed, self.defaults, self.missed_payments
        )
    }
}

impl Circle {
    /// JSON for views. Big numbers (amounts, nanosecond timestamps) are strings.
    pub fn to_json(&self) -> String {
        let members = join(self.members.iter().map(|m| {
            format!(
                r#"{{"account_id":"{}","deposit":"{}","paid_this_round":{},"defaulted":{},"missed":{}}}"#,
                m.account_id, m.deposit.0, m.paid_this_round, m.defaulted, m.missed
            )
        }));
        let listings = join(self.listings.iter().map(|l| opt_amount(*l)));
        let payouts = join(self.payouts.iter().map(|p| {
            format!(
                r#"{{"round":{},"to":"{}","amount":"{}","shortfall":"{}","at":"{}"}}"#,
                p.round, p.to, p.amount.0, p.shortfall.0, p.at
            )
        }));
        let backers = join(self.backers.iter().map(|b| {
            format!(
                r#"{{"account_id":"{}","amount":"{}","due":"{}"}}"#,
                b.account_id, b.amount.0, b.due.0
            )
        }));
        format!(
            r#"{{"id":{},"name":{},"organizer":"{}","contribution":"{}","size":{},"period_secs":{},"members":[{}],"listings":[{}],"invite_only":{},"backing":"{}","backers":[{}],"status":"{}","created_at":"{}","started_at":"{}","round":{},"pot":"{}","paying":{},"payouts":[{}],"round_deadline":{}}}"#,
            self.id,
            jstr(&self.name),
            self.organizer,
            self.contribution.0,
            self.size,
            self.period_secs,
            members,
            listings,
            self.invite_key.is_some(),
            self.backing.0,
            backers,
            self.status.as_str(),
            self.created_at,
            self.started_at,
            self.round,
            self.pot.0,
            self.paying,
            payouts,
            self.deadline_json()
        )
    }

    /// Deadline for the current round, in nanoseconds.
    pub fn round_deadline(&self) -> u64 {
        self.started_at + (self.round as u64 + 1) * self.period_secs * NS_PER_SEC
    }

    /// The round deadline as a JSON string, or `null` when no round is running.
    fn deadline_json(&self) -> String {
        if self.status == CircleStatus::Active {
            format!("\"{}\"", self.round_deadline())
        } else {
            "null".into()
        }
    }

    fn seat_of(&self, account_id: &AccountId) -> Option<usize> {
        self.members.iter().position(|m| &m.account_id == account_id)
    }

    fn all_paid(&self) -> bool {
        self.members.iter().all(|m| m.paid_this_round)
    }
}

/// `msg` of a member's `Transfer` intent to this contract.
#[cfg_attr(test, derive(Debug))]
pub enum TransferMsg {
    /// `join:<circle>` or `join:<circle>:<invite signature, 128 hex>`: pay the
    /// deposit and take the next free seat. In an open circle the deposit is
    /// one contribution. An invite-only circle needs the invite's signature,
    /// which also sets the deposit (see `join_message`).
    Join { circle: u64, invite_sig: Option<[u8; 64]> },
    /// `contribute:<circle>:<round>`: pay this round's contribution.
    Contribute { circle: u64, round: u32 },
    /// `buy_seat:<circle>:<seat>`: pay the asking price for a listed seat and swap it
    /// with your own later seat.
    BuySeat { circle: u64, seat: u32 },
    /// `back:<circle>`: put money behind a circle (anyone, e.g. a DAO treasury
    /// with `mt_transfer_call`). At least one contribution.
    Back { circle: u64 },
    /// `refill:<circle>`: top up your own deposit, up to one contribution.
    Refill { circle: u64 },
}

/// `msg` of a member's `AuthCall` intent to this contract.
#[cfg_attr(test, derive(Debug))]
pub enum AuthMsg {
    /// `create:<contribution>:<size>:<period_secs>:<invite key>:<name>`. The
    /// invite key is 64 hex characters, or `-` for a circle anyone can join.
    /// The name may contain `:`.
    Create {
        name: String,
        contribution: U128,
        size: u32,
        period_secs: u64,
        invite_key: Option<[u8; 32]>,
    },
    /// `list_seat:<circle>:<seat>:<price>`
    ListSeat { circle: u64, seat: u32, price: U128 },
    /// `unlist_seat:<circle>:<seat>`
    UnlistSeat { circle: u64, seat: u32 },
    /// `cancel:<circle>`
    Cancel { circle: u64 },
    /// `claim_credit`
    ClaimCredit,
}

pub fn parse_transfer(msg: &str) -> Option<TransferMsg> {
    let mut p = msg.split(':');
    let op = p.next()?;
    let circle = p.next()?.parse().ok()?;
    let m = match op {
        "join" => {
            let invite_sig = match p.next() {
                Some(s) => Some(hex(s)?),
                None => None,
            };
            TransferMsg::Join { circle, invite_sig }
        }
        "contribute" => TransferMsg::Contribute { circle, round: p.next()?.parse().ok()? },
        "buy_seat" => TransferMsg::BuySeat { circle, seat: p.next()?.parse().ok()? },
        "back" => TransferMsg::Back { circle },
        "refill" => TransferMsg::Refill { circle },
        _ => return None,
    };
    p.next().is_none().then_some(m)
}

/// `-` for none, or exactly 64 hex characters.
fn opt_key(s: &str) -> Option<Option<[u8; 32]>> {
    if s == "-" {
        Some(None)
    } else {
        hex(s).map(Some)
    }
}

/// Exactly `2 * N` hex digits.
fn hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    let b = s.as_bytes();
    if b.len() != 2 * N {
        return None;
    }
    let mut out = [0u8; N];
    for (i, pair) in b.chunks(2).enumerate() {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out[i] = (hi * 16 + lo) as u8;
    }
    Some(out)
}

/// What the invite key signs to let `account` join `circle` of this contract
/// with `deposit`. Binding the joiner's account means a signature seen on chain
/// can't be reused by anyone else. The deposit is one contribution, or less for
/// someone the organizer trusts; that decision is made privately, in the app.
pub fn join_message(contract: &AccountId, circle: u64, account: &AccountId, deposit: u128) -> String {
    format!("contri-join:{contract}:{circle}:{account}:{deposit}")
}

pub fn parse_auth(msg: &str) -> Option<AuthMsg> {
    if msg == "claim_credit" {
        return Some(AuthMsg::ClaimCredit);
    }
    let (op, rest) = msg.split_once(':')?;
    if op == "create" {
        let mut p = rest.splitn(5, ':');
        let contribution = U128(p.next()?.parse().ok()?);
        let size = p.next()?.parse().ok()?;
        let period_secs = p.next()?.parse().ok()?;
        let invite_key = opt_key(p.next()?)?;
        let name = p.next()?.to_string();
        return Some(AuthMsg::Create { name, contribution, size, period_secs, invite_key });
    }
    let mut p = rest.split(':');
    let circle = p.next()?.parse().ok()?;
    let m = match op {
        "list_seat" => AuthMsg::ListSeat {
            circle,
            seat: p.next()?.parse().ok()?,
            price: U128(p.next()?.parse().ok()?),
        },
        "unlist_seat" => AuthMsg::UnlistSeat { circle, seat: p.next()?.parse().ok()? },
        "cancel" => AuthMsg::Cancel { circle },
        _ => return None,
    };
    p.next().is_none().then_some(m)
}

#[near(contract_state, contract_metadata(standard(standard = "nep297", version = "1.0.0")))]
#[derive(PanicOnDefault)]
pub struct Contri {
    owner_id: AccountId,
    intents_id: AccountId,
    token_id: String,
    /// Circles are numbered from 0. Each one is stored under its own key (see `store`).
    next_circle_id: u64,
}

#[near]
impl Contri {
    // Every public method reads its own JSON arguments with `json.rs` (see
    // `args()`). The argument names are the ones a serde-based near-sdk
    // contract would use, so callers see no difference.

    /// Args: `{"intents_id": "intents.near", "token_id": "nep141:usdt.tether-token.near"}`
    #[init]
    pub fn new() -> Self {
        let a = args();
        Self {
            owner_id: env::predecessor_account_id(),
            intents_id: arg_account(&a, "intents_id"),
            token_id: arg_str(&a, "token_id"),
            next_circle_id: 0,
        }
    }

    // ------------------------------------------------------------------
    // Entry points from NEAR Intents
    // ------------------------------------------------------------------

    /// NEP-245 receiver. Called by NEAR Intents for a member's `Transfer` intent
    /// with a notification. Returns the amounts to refund, e.g. `["0"]`.
    /// Args: `sender_id`, `previous_owner_ids`, `token_ids`, `amounts`, `msg`.
    pub fn mt_on_transfer(&mut self) {
        let a = args();
        let amounts = arg_list(&a, "amounts")
            .iter()
            .map(|v| U128(v.as_uint().unwrap_or_else(|| bad("amounts"))))
            .collect();
        let token_ids = arg_list(&a, "token_ids")
            .iter()
            .map(|v| v.as_str().unwrap_or_else(|| bad("token_ids")).to_string())
            .collect();
        let refunds = self.internal_on_transfer(
            arg_account(&a, "sender_id"),
            token_ids,
            amounts,
            arg_str(&a, "msg"),
        );
        ret(&format!("[{}]", join(refunds.iter().map(|r| format!("\"{r}\"")))));
    }

    /// Called by NEAR Intents for a member's signed `AuthCall` intent.
    /// Args: `signer_id`, `msg`.
    pub fn on_auth(&mut self) {
        let a = args();
        self.internal_on_auth(&arg_account(&a, "signer_id"), &arg_str(&a, "msg"));
    }

    // ------------------------------------------------------------------
    // Direct calls for members with a NEAR account: the caller is the
    // member. Money still moves through NEAR Intents (join, contribute and
    // buy_seat are Transfer intents), so these cover the other actions.
    // ------------------------------------------------------------------

    /// Args: `{"name": "<encrypted name>", "contribution": "5000000", "size": 5,
    /// "period_secs": 86400, "invite_key": "<64 hex>"}`. `invite_key` is
    /// optional; without it anyone can join. Returns the new circle's id.
    pub fn create_circle(&mut self) {
        let a = args();
        let invite_key = match a.get("invite_key") {
            None => None,
            Some(v) if v.is_null() => None,
            Some(_) => Some(hex(&arg_str(&a, "invite_key")).unwrap_or_else(|| bad("invite_key"))),
        };
        let id = self
            .internal_create(
                &env::predecessor_account_id(),
                arg_str(&a, "name"),
                U128(arg_u128(&a, "contribution")),
                arg_u32(&a, "size"),
                arg_u64(&a, "period_secs"),
                invite_key,
            )
            .unwrap_or_else(|e| env::panic_str(&e));
        ret(&id.to_string());
    }

    /// Args: `{"circle_id": 0, "seat": 1, "price": "1000000"}`
    pub fn list_seat(&mut self) {
        let a = args();
        let price = Some(U128(arg_u128(&a, "price")));
        self.direct_list(&a, price);
    }

    /// Args: `{"circle_id": 0, "seat": 1}`
    pub fn unlist_seat(&mut self) {
        self.direct_list(&args(), None);
    }

    /// Args: `{"circle_id": 0}`
    pub fn cancel_circle(&mut self) {
        let circle_id = arg_u64(&args(), "circle_id");
        self.internal_cancel(&env::predecessor_account_id(), circle_id)
            .unwrap_or_else(|e| env::panic_str(&e));
    }

    /// No args. Sends the caller what they are owed after a failed transfer.
    pub fn claim_credit(&mut self) {
        self.internal_claim_credit(&env::predecessor_account_id())
            .unwrap_or_else(|e| env::panic_str(&e));
    }

    // ------------------------------------------------------------------
    // Anyone can call these. Args: `{"circle_id": 0}`
    // ------------------------------------------------------------------

    /// After the round deadline: missed contributions come out of deposits,
    /// then the pot is paid out.
    pub fn settle_round(&mut self) {
        self.internal_settle(arg_u64(&args(), "circle_id"));
    }

    /// If every member has paid but the payout did not start or failed.
    pub fn pay_out(&mut self) {
        self.internal_pay_out(arg_u64(&args(), "circle_id"));
    }

    /// After a circle finished or was cancelled: returns remaining deposits,
    /// as many as the attached gas allows. Returns how many were sent.
    pub fn release_deposits(&mut self) {
        let sent = self.internal_release(arg_u64(&args(), "circle_id"));
        ret(&sent.to_string());
    }

    // ------------------------------------------------------------------
    // Callbacks (only this contract can call them)
    // ------------------------------------------------------------------

    /// After the payout transfer. Args: `circle_id`, `round`, `amount`.
    #[private]
    pub fn on_payout(&mut self) {
        let a = args();
        self.finalize_payout(
            arg_u64(&a, "circle_id"),
            arg_u32(&a, "round"),
            U128(arg_u128(&a, "amount")),
            transfer_succeeded(),
        );
    }

    /// After any other transfer out. A failed one becomes a claimable credit.
    /// Args: `to`, `amount`.
    #[private]
    pub fn on_sent(&mut self) {
        let a = args();
        if !transfer_succeeded() {
            self.add_credit(arg_account(&a, "to"), arg_u128(&a, "amount"));
        }
    }

    // ------------------------------------------------------------------
    // Views. JSON out is written by hand (see `Circle::to_json`).
    // ------------------------------------------------------------------

    pub fn get_config(&self) {
        ret(&format!(
            r#"{{"owner_id":"{}","intents_id":"{}","token_id":{},"circle_count":{}}}"#,
            self.owner_id,
            self.intents_id,
            jstr(&self.token_id),
            self.next_circle_id
        ));
    }

    /// Args: `{"circle_id": 0}`. The circle, or `null`.
    pub fn get_circle(&self) {
        let c = load_circle(arg_u64(&args(), "circle_id"));
        ret(&c.map(|c| c.to_json()).unwrap_or_else(|| "null".into()));
    }

    /// Args: `{"circle_id": 0}`. Deadline of the running round in nanoseconds
    /// (a string), or `null` when the circle has no running round.
    pub fn get_round_deadline(&self) {
        let c = load_circle(arg_u64(&args(), "circle_id"));
        ret(&c.map(|c| c.deadline_json()).unwrap_or_else(|| "null".into()));
    }

    /// Args: `{"from_index": 0, "limit": 50}` (both optional)
    pub fn get_circles(&self) {
        let a = args();
        let (from, limit) = page(&a);
        let to = self.next_circle_id.min(from.saturating_add(limit));
        ret(&format!("[{}]", join((from..to).filter_map(load_circle).map(|c| c.to_json()))));
    }

    /// Args: `{"account_id": "..."}`. Ids of the circles this account organizes or sits in.
    pub fn get_circles_for(&self) {
        let account_id = arg_account(&args(), "account_id");
        let ids = self
            .circles()
            .filter(|c| c.organizer == account_id || c.seat_of(&account_id).is_some())
            .map(|c| c.id.to_string());
        ret(&format!("[{}]", join(ids)));
    }

    /// Args: `{"account_id": "..."}`
    pub fn get_record(&self) {
        ret(&load_record(&arg_account(&args(), "account_id")).to_json());
    }

    /// Args: `{"account_id": "..."}`. Amount owed after a failed transfer, as a string.
    pub fn get_credit(&self) {
        ret(&format!("\"{}\"", load_credit(&arg_account(&args(), "account_id"))));
    }

    // Seats as NFTs. Each seat is a token "<circle>:<seat>" owned by the member
    // sitting in it. Views follow NEP-171 (core), NEP-177 (metadata) and NEP-181
    // (enumeration). Seats change hands through the contract's own sale flow
    // (`list_seat` + `buy_seat`), which also logs NEP-171 `nft_transfer` events.

    pub fn nft_metadata(&self) {
        ret(concat!(
            r#"{"spec":"nft-1.0.0","name":"Contri Seats","symbol":"SEAT","icon":""#,
            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23173f35'/%3E%3Ccircle cx='16' cy='16' r='9' fill='none' stroke='%23f0b429' stroke-width='3' stroke-dasharray='5.07 2'/%3E%3C/svg%3E",
            r#"","base_uri":null,"reference":null,"reference_hash":null}"#
        ));
    }

    /// Args: `{"token_id": "0:1"}`. The seat token, or `null`.
    pub fn nft_token(&self) {
        let token_id = arg_str(&args(), "token_id");
        let json = parse_seat_token(&token_id)
            .and_then(|(id, seat)| {
                let c = load_circle(id).filter(|c| c.status != CircleStatus::Cancelled)?;
                let m = c.members.get(seat as usize)?;
                Some(seat_token_json(&c, seat, &m.account_id))
            })
            .unwrap_or_else(|| "null".into());
        ret(&json);
    }

    /// NEP-181. Number of seat tokens, as a string.
    pub fn nft_total_supply(&self) {
        ret(&format!("\"{}\"", self.seat_page(None, 0, 0).0));
    }

    /// NEP-181. Args: `{"from_index": "0", "limit": 50}` (both optional)
    pub fn nft_tokens(&self) {
        let (from, limit) = page(&args());
        ret(&format!("[{}]", self.seat_page(None, from, limit).1));
    }

    /// NEP-181. Args: `{"account_id": "..."}`. Number of seats held, as a string.
    pub fn nft_supply_for_owner(&self) {
        let account_id = arg_account(&args(), "account_id");
        ret(&format!("\"{}\"", self.seat_page(Some(&account_id), 0, 0).0));
    }

    /// NEP-181. Args: `{"account_id": "...", "from_index": "0", "limit": 50}`
    pub fn nft_tokens_for_owner(&self) {
        let a = args();
        let account_id = arg_account(&a, "account_id");
        let (from, limit) = page(&a);
        ret(&format!("[{}]", self.seat_page(Some(&account_id), from, limit).1));
    }
}

// ----------------------------------------------------------------------
// Internal logic
// ----------------------------------------------------------------------

impl Contri {
    /// Returns the amount to refund for each transferred token.
    pub(crate) fn internal_on_transfer(
        &mut self,
        sender_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> Vec<u128> {
        self.assert_intents();
        if token_ids.len() != 1 || amounts.len() != 1 || token_ids[0] != self.token_id {
            env::log_str("contri: unsupported token, refunding");
            return amounts.iter().map(|a| a.0).collect();
        }
        let amount = amounts[0].0;
        let result = match parse_transfer(&msg) {
            Some(m) => self.handle_transfer(&sender_id, amount, m),
            None => Err("unreadable message".to_string()),
        };
        match result {
            Ok(()) => vec![0],
            Err(e) => {
                env::log_str(&format!("contri: refunding {amount}: {e}"));
                vec![amount]
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn circle_of(&self, circle_id: u64) -> Option<Circle> {
        load_circle(circle_id)
    }

    #[cfg(test)]
    pub(crate) fn record_of(&self, account_id: &AccountId) -> Record {
        load_record(account_id)
    }

    #[cfg(test)]
    pub(crate) fn credit_of(&self, account_id: &AccountId) -> U128 {
        U128(load_credit(account_id))
    }

    /// (circle id, seat) for every seat this account holds.
    #[cfg(test)]
    pub(crate) fn seats_of(&self, account_id: &AccountId) -> Vec<(u64, u32)> {
        let mut seats = vec![];
        self.each_seat(Some(account_id), |c, seat, _| seats.push((c.id, seat)));
        seats
    }

    /// Every circle, in id order.
    fn circles(&self) -> impl Iterator<Item = Circle> {
        (0..self.next_circle_id).filter_map(load_circle)
    }

    /// Calls `f` for every seat token in circle and seat order, or only for
    /// `owner`'s seats. A cancelled circle has no seat tokens.
    fn each_seat(&self, owner: Option<&AccountId>, mut f: impl FnMut(&Circle, u32, &AccountId)) {
        for c in self.circles() {
            if c.status == CircleStatus::Cancelled {
                continue;
            }
            for (seat, m) in c.members.iter().enumerate() {
                if owner.map_or(true, |o| *o == m.account_id) {
                    f(&c, seat as u32, &m.account_id);
                }
            }
        }
    }

    /// The number of seat tokens (all, or `owner`'s), and the JSON of those
    /// from position `from`, at most `limit` of them.
    fn seat_page(&self, owner: Option<&AccountId>, from: u64, limit: u64) -> (u64, String) {
        let mut n = 0u64;
        let mut items = vec![];
        self.each_seat(owner, |c, seat, who| {
            if n >= from && n - from < limit {
                items.push(seat_token_json(c, seat, who));
            }
            n += 1;
        });
        (n, items.join(","))
    }

    /// `list_seat` / `unlist_seat` called directly by the seat's owner.
    fn direct_list(&mut self, a: &json::Json, price: Option<U128>) {
        let (circle_id, seat) = (arg_u64(a, "circle_id"), arg_u32(a, "seat"));
        self.internal_list_seat(&env::predecessor_account_id(), circle_id, seat, price)
            .unwrap_or_else(|e| env::panic_str(&e));
    }

    pub(crate) fn internal_on_auth(&mut self, signer: &AccountId, msg: &str) {
        self.assert_intents();
        let m = parse_auth(msg).unwrap_or_else(|| env::panic_str("unreadable message"));
        self.handle_auth(signer, m).unwrap_or_else(|e| env::panic_str(&e));
    }

    pub(crate) fn internal_settle(&mut self, circle_id: u64) {
        let mut c = circle_or_panic(circle_id);
        require!(c.status == CircleStatus::Active, "circle is not active");
        require!(!c.paying, "payout already in progress");
        require!(env::block_timestamp() >= c.round_deadline(), "round deadline has not passed");
        // Each missed payment comes out of the member's deposit first, then out
        // of the circle's community backing. Anything still missing makes the
        // pot short, and the payout records the shortfall.
        let contribution = c.contribution.0;
        let mut defaulted = vec![];
        let mut from_backing = 0;
        for m in c.members.iter_mut() {
            if m.paid_this_round {
                continue;
            }
            let from_deposit = m.deposit.0.min(contribution);
            let backed = c.backing.0.min(contribution - from_deposit);
            m.deposit = U128(m.deposit.0 - from_deposit);
            c.backing = U128(c.backing.0 - backed);
            from_backing += backed;
            m.paid_this_round = true;
            m.defaulted = true;
            m.missed += 1;
            c.pot = U128(c.pot.0 + from_deposit + backed);
            defaulted.push(format!("\"{}\"", m.account_id));
        }
        emit(
            "round_settled",
            format!(
                r#"{{"circle":{},"round":{},"missed":[{}],"from_backing":"{from_backing}"}}"#,
                c.id,
                c.round,
                defaulted.join(",")
            ),
        );
        self.start_payout(c);
    }

    pub(crate) fn internal_pay_out(&mut self, circle_id: u64) {
        let c = circle_or_panic(circle_id);
        require!(c.status == CircleStatus::Active, "circle is not active");
        require!(!c.paying, "payout already in progress");
        require!(c.all_paid(), "not every member has paid this round");
        self.start_payout(c);
    }

    pub(crate) fn add_credit(&mut self, to: AccountId, amount: u128) {
        save_credit(&to, load_credit(&to) + amount);
        emit("credit_added", format!(r#"{{"account":"{to}","amount":"{amount}"}}"#));
    }

    pub(crate) fn internal_release(&mut self, circle_id: u64) -> u32 {
        let mut c = circle_or_panic(circle_id);
        require!(
            c.status == CircleStatus::Finished || c.status == CircleStatus::Cancelled,
            "circle is still running"
        );
        let mut sent = 0;
        let per_send = GAS_MT_TRANSFER.as_gas() + GAS_CALLBACK.as_gas() + Gas::from_tgas(10).as_gas();
        for i in 0..c.members.len() {
            let amount = c.members[i].deposit.0;
            if amount == 0 {
                continue;
            }
            if env::prepaid_gas().saturating_sub(env::used_gas()).as_gas() < per_send {
                break;
            }
            c.members[i].deposit = U128(0);
            let to = c.members[i].account_id.clone();
            self.send(to, amount, format!("contri:{}:deposit", c.id));
            sent += 1;
        }
        for i in 0..c.backers.len() {
            let amount = c.backers[i].due.0;
            if amount == 0 {
                continue;
            }
            if env::prepaid_gas().saturating_sub(env::used_gas()).as_gas() < per_send {
                break;
            }
            c.backers[i].due = U128(0);
            let to = c.backers[i].account_id.clone();
            self.send(to, amount, format!("contri:{}:backing", c.id));
            sent += 1;
        }
        save_circle(&c);
        sent
    }

    fn assert_intents(&self) {
        require!(env::predecessor_account_id() == self.intents_id, "only NEAR Intents can call this");
    }

    pub(crate) fn handle_transfer(&mut self, sender: &AccountId, amount: u128, msg: TransferMsg) -> Result<(), String> {
        match msg {
            TransferMsg::Join { circle, invite_sig } => self.internal_join(sender, circle, amount, invite_sig),
            TransferMsg::Contribute { circle, round } => self.internal_contribute(sender, circle, round, amount),
            TransferMsg::BuySeat { circle, seat } => self.internal_buy_seat(sender, circle, seat, amount),
            TransferMsg::Back { circle } => self.internal_back(sender, circle, amount),
            TransferMsg::Refill { circle } => self.internal_refill(sender, circle, amount),
        }
    }

    pub(crate) fn handle_auth(&mut self, signer: &AccountId, msg: AuthMsg) -> Result<(), String> {
        match msg {
            AuthMsg::Create { name, contribution, size, period_secs, invite_key } => self
                .internal_create(signer, name, contribution, size, period_secs, invite_key)
                .map(|_| ()),
            AuthMsg::ListSeat { circle, seat, price } => self.internal_list_seat(signer, circle, seat, Some(price)),
            AuthMsg::UnlistSeat { circle, seat } => self.internal_list_seat(signer, circle, seat, None),
            AuthMsg::Cancel { circle } => self.internal_cancel(signer, circle),
            AuthMsg::ClaimCredit => self.internal_claim_credit(signer),
        }
    }

    pub(crate) fn internal_create(
        &mut self,
        organizer: &AccountId,
        name: String,
        contribution: U128,
        size: u32,
        period_secs: u64,
        invite_key: Option<[u8; 32]>,
    ) -> Result<u64, String> {
        let name = name.trim().to_string();
        if name.is_empty() || name.len() > MAX_NAME_LEN {
            return Err(format!("name must be 1 to {MAX_NAME_LEN} bytes"));
        }
        if contribution.0 == 0 {
            return Err("contribution must be more than zero".into());
        }
        if !(MIN_MEMBERS..=MAX_MEMBERS).contains(&size) {
            return Err(format!("a circle needs {MIN_MEMBERS} to {MAX_MEMBERS} members"));
        }
        if !(MIN_PERIOD_SECS..=MAX_PERIOD_SECS).contains(&period_secs) {
            return Err("period must be between one minute and 31 days".into());
        }
        let id = self.next_circle_id;
        self.next_circle_id += 1;
        let c = Circle {
            id,
            name,
            organizer: organizer.clone(),
            contribution,
            size,
            period_secs,
            members: vec![],
            listings: vec![None; size as usize],
            invite_key,
            backing: U128(0),
            backers: vec![],
            status: CircleStatus::Open,
            created_at: env::block_timestamp(),
            started_at: 0,
            round: 0,
            pot: U128(0),
            paying: false,
            payouts: vec![],
        };
        emit(
            "circle_created",
            format!(
                r#"{{"circle":{id},"organizer":"{organizer}","contribution":"{}","size":{size},"period_secs":{period_secs},"invite_only":{}}}"#,
                contribution.0,
                invite_key.is_some()
            ),
        );
        save_circle(&c);
        Ok(id)
    }

    fn internal_join(
        &mut self,
        who: &AccountId,
        circle_id: u64,
        amount: u128,
        invite_sig: Option<[u8; 64]>,
    ) -> Result<(), String> {
        let mut c = find_circle(circle_id)?;
        if c.status != CircleStatus::Open {
            return Err("circle is not open for joining".into());
        }
        if let Some(key) = &c.invite_key {
            // The invite sets the deposit: one contribution, or less for someone
            // the organizer trusts.
            let message = join_message(&env::current_account_id(), circle_id, who, amount);
            let valid = invite_sig.is_some_and(|sig| env::ed25519_verify(&sig, message, key));
            if !valid || amount > c.contribution.0 {
                return Err("this circle needs a valid invite for this deposit".into());
            }
        } else if amount != c.contribution.0 {
            return Err("deposit must equal one contribution".into());
        }
        if c.seat_of(who).is_some() {
            return Err("already a member".into());
        }
        if c.members.len() as u32 >= c.size {
            return Err("circle is full".into());
        }
        c.members.push(Member {
            account_id: who.clone(),
            deposit: U128(amount),
            paid_this_round: false,
            defaulted: false,
            missed: 0,
        });
        let seat = c.members.len() - 1;
        emit(
            "joined",
            format!(r#"{{"circle":{circle_id},"member":"{who}","seat":{seat},"deposit":"{amount}"}}"#),
        );
        emit_nft("nft_mint", format!(r#"{{"owner_id":"{who}","token_ids":["{circle_id}:{seat}"]}}"#));
        if c.members.len() as u32 == c.size {
            c.status = CircleStatus::Active;
            c.started_at = env::block_timestamp();
            emit(
                "circle_started",
                format!(r#"{{"circle":{circle_id},"first_deadline":"{}"}}"#, c.round_deadline()),
            );
        }
        save_circle(&c);
        Ok(())
    }

    fn internal_contribute(&mut self, who: &AccountId, circle_id: u64, round: u32, amount: u128) -> Result<(), String> {
        let mut c = find_circle(circle_id)?;
        if c.status != CircleStatus::Active {
            return Err("circle is not active".into());
        }
        if c.paying {
            return Err("payout in progress, try again shortly".into());
        }
        if round != c.round {
            return Err(format!("this circle is on round {}", c.round));
        }
        let seat = c.seat_of(who).ok_or("not a member of this circle")?;
        if c.members[seat].paid_this_round {
            return Err("already paid this round".into());
        }
        if amount != c.contribution.0 {
            return Err("amount must equal the contribution".into());
        }
        c.members[seat].paid_this_round = true;
        c.pot = U128(c.pot.0 + amount);
        emit(
            "contributed",
            format!(r#"{{"circle":{circle_id},"round":{round},"member":"{who}","amount":"{amount}"}}"#),
        );
        let gas_left = env::prepaid_gas().saturating_sub(env::used_gas());
        if c.all_paid() && gas_left.as_gas() >= GAS_FOR_PAYOUT.as_gas() {
            self.start_payout(c);
        } else {
            save_circle(&c);
        }
        Ok(())
    }

    fn internal_buy_seat(&mut self, buyer: &AccountId, circle_id: u64, seat: u32, amount: u128) -> Result<(), String> {
        let mut c = find_circle(circle_id)?;
        if c.status != CircleStatus::Active && c.status != CircleStatus::Open {
            return Err("seats can only be traded while the circle is running".into());
        }
        if c.paying {
            return Err("payout in progress, try again shortly".into());
        }
        let s = seat as usize;
        if s >= c.members.len() {
            return Err("no such seat".into());
        }
        if seat < c.round {
            return Err("that turn has already been paid".into());
        }
        let price = c.listings[s].ok_or("seat is not for sale")?;
        if amount != price.0 {
            return Err("amount must equal the asking price".into());
        }
        let buyer_seat = c.seat_of(buyer).ok_or("only members can buy a seat")?;
        if buyer_seat <= s {
            return Err("you can only buy a turn earlier than your own".into());
        }
        let seller = c.members[s].account_id.clone();
        c.members.swap(s, buyer_seat);
        c.listings[s] = None;
        c.listings[buyer_seat] = None;
        emit(
            "seat_sold",
            format!(
                r#"{{"circle":{circle_id},"seat":{seat},"buyer":"{buyer}","seller":"{seller}","price":"{}","seller_new_seat":{buyer_seat}}}"#,
                price.0
            ),
        );
        emit_nft(
            "nft_transfer",
            format!(
                r#"{{"old_owner_id":"{seller}","new_owner_id":"{buyer}","token_ids":["{circle_id}:{seat}"]}},{{"old_owner_id":"{buyer}","new_owner_id":"{seller}","token_ids":["{circle_id}:{buyer_seat}"]}}"#
            ),
        );
        save_circle(&c);
        self.send(seller, amount, format!("contri:{circle_id}:seat:{seat}"));
        Ok(())
    }

    fn internal_back(&mut self, who: &AccountId, circle_id: u64, amount: u128) -> Result<(), String> {
        let mut c = find_circle(circle_id)?;
        if c.status != CircleStatus::Open && c.status != CircleStatus::Active {
            return Err("circle has ended".into());
        }
        if amount < c.contribution.0 {
            return Err("backing must be at least one contribution".into());
        }
        match c.backers.iter().position(|b| &b.account_id == who) {
            Some(i) => c.backers[i].amount = U128(c.backers[i].amount.0 + amount),
            None if c.backers.len() < MAX_BACKERS => c.backers.push(Backer {
                account_id: who.clone(),
                amount: U128(amount),
                due: U128(0),
            }),
            None => return Err("circle already has the most backers".into()),
        }
        c.backing = U128(c.backing.0 + amount);
        emit(
            "circle_backed",
            format!(
                r#"{{"circle":{circle_id},"backer":"{who}","amount":"{amount}","backing":"{}"}}"#,
                c.backing.0
            ),
        );
        save_circle(&c);
        Ok(())
    }

    fn internal_refill(&mut self, who: &AccountId, circle_id: u64, amount: u128) -> Result<(), String> {
        let mut c = find_circle(circle_id)?;
        if c.status != CircleStatus::Open && c.status != CircleStatus::Active {
            return Err("circle has ended".into());
        }
        let seat = c.seat_of(who).ok_or("not a member of this circle")?;
        let deposit = c.members[seat].deposit.0 + amount;
        if deposit > c.contribution.0 {
            return Err("a deposit can be at most one contribution".into());
        }
        c.members[seat].deposit = U128(deposit);
        emit(
            "deposit_refilled",
            format!(r#"{{"circle":{circle_id},"member":"{who}","deposit":"{deposit}"}}"#),
        );
        save_circle(&c);
        Ok(())
    }

    pub(crate) fn internal_list_seat(
        &mut self,
        who: &AccountId,
        circle_id: u64,
        seat: u32,
        price: Option<U128>,
    ) -> Result<(), String> {
        let mut c = find_circle(circle_id)?;
        let s = seat as usize;
        let owner = c.members.get(s).ok_or("no such seat")?;
        if &owner.account_id != who {
            return Err("only the seat's owner can do this".into());
        }
        if seat < c.round {
            return Err("that turn has already been paid".into());
        }
        if c.status == CircleStatus::Finished || c.status == CircleStatus::Cancelled {
            return Err("circle has ended".into());
        }
        if price.is_some_and(|p| p.0 == 0) {
            return Err("price must be more than zero".into());
        }
        c.listings[s] = price;
        emit(
            if price.is_some() { "seat_listed" } else { "seat_unlisted" },
            format!(r#"{{"circle":{circle_id},"seat":{seat},"price":{}}}"#, opt_amount(price)),
        );
        save_circle(&c);
        Ok(())
    }

    pub(crate) fn internal_cancel(&mut self, who: &AccountId, circle_id: u64) -> Result<(), String> {
        let mut c = find_circle(circle_id)?;
        if &c.organizer != who {
            return Err("only the organizer can cancel".into());
        }
        if c.status != CircleStatus::Open {
            return Err("only a circle that has not started can be cancelled".into());
        }
        c.status = CircleStatus::Cancelled;
        close_backing(&mut c);
        emit("circle_cancelled", format!(r#"{{"circle":{circle_id}}}"#));
        if !c.members.is_empty() {
            let burns = c
                .members
                .iter()
                .enumerate()
                .map(|(seat, m)| format!(r#"{{"owner_id":"{}","token_ids":["{circle_id}:{seat}"]}}"#, m.account_id));
            emit_nft("nft_burn", join(burns));
        }
        save_circle(&c);
        Ok(())
    }

    pub(crate) fn internal_claim_credit(&mut self, who: &AccountId) -> Result<(), String> {
        let owed = load_credit(who);
        if owed == 0 {
            return Err("nothing to claim".into());
        }
        save_credit(who, 0);
        self.send(who.clone(), owed, "contri:credit".into());
        Ok(())
    }

    /// Sends `amount` of the circle token from this contract's NEAR Intents
    /// balance to `to`. If the transfer fails, the amount becomes a claimable credit.
    fn send(&self, to: AccountId, amount: u128, memo: String) {
        let callback_args = format!(r#"{{"to":"{to}","amount":"{amount}"}}"#);
        self.transfer_then(&to, amount, &memo, "on_sent", callback_args);
    }

    /// Pays the pot to this round's seat. `on_payout` then closes the round,
    /// or, if the transfer failed, keeps the pot so `pay_out` can retry.
    fn start_payout(&self, mut c: Circle) {
        let (id, round, amount) = (c.id, c.round, c.pot.0);
        let to = c.members[round as usize].account_id.clone();
        c.paying = true;
        save_circle(&c);
        let callback_args = format!(r#"{{"circle_id":{id},"round":{round},"amount":"{amount}"}}"#);
        self.transfer_then(&to, amount, &format!("contri:{id}:{round}"), "on_payout", callback_args);
    }

    /// `mt_transfer` of this contract's own NEAR Intents balance (this contract
    /// is the caller, so no signature is needed), then `callback` on this
    /// contract, which reads the transfer's result.
    fn transfer_then(&self, to: &AccountId, amount: u128, memo: &str, callback: &str, callback_args: String) {
        let transfer_args = format!(
            r#"{{"receiver_id":"{to}","token_id":{},"amount":"{amount}","memo":{}}}"#,
            jstr(&self.token_id),
            jstr(memo)
        );
        let transfer = env::promise_create(
            self.intents_id.clone(),
            "mt_transfer",
            transfer_args,
            ONE_YOCTO,
            GAS_MT_TRANSFER,
        );
        env::promise_then(transfer, env::current_account_id(), callback, callback_args, ZERO, GAS_CALLBACK);
    }

    pub(crate) fn finalize_payout(&mut self, circle_id: u64, round: u32, amount: U128, ok: bool) -> bool {
        let Some(mut c) = load_circle(circle_id) else {
            return false;
        };
        c.paying = false;
        if !ok || c.round != round {
            emit("payout_failed", format!(r#"{{"circle":{circle_id},"round":{round}}}"#));
            save_circle(&c);
            return false;
        }
        let to = c.members[round as usize].account_id.clone();
        let full = c.contribution.0.saturating_mul(c.size as u128);
        let shortfall = U128(full.saturating_sub(amount.0));
        emit(
            "paid_out",
            format!(
                r#"{{"circle":{circle_id},"round":{round},"to":"{to}","amount":"{}","shortfall":"{}"}}"#,
                amount.0, shortfall.0
            ),
        );
        c.payouts.push(PayoutRecord { round, to, amount, shortfall, at: env::block_timestamp() });
        c.pot = U128(0);
        for m in c.members.iter_mut() {
            m.paid_this_round = false;
        }
        c.listings[round as usize] = None;
        c.round += 1;
        if c.round >= c.size {
            c.status = CircleStatus::Finished;
            for m in &c.members {
                let mut r = load_record(&m.account_id);
                if m.defaulted {
                    r.defaults += 1;
                } else {
                    r.completed += 1;
                }
                r.missed_payments += m.missed;
                save_record(&m.account_id, &r);
            }
            close_backing(&mut c);
            emit("circle_finished", format!(r#"{{"circle":{circle_id}}}"#));
        }
        save_circle(&c);
        true
    }
}

/// The contract's ABI, zstd-compressed, returned the way cargo-near's embedded
/// ABI is, so NEAR tools and explorers can read the methods and their types.
/// Generated by CI from the typed interface in `contract/interface` (see
/// `contract/abi/README.md`).
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn __contract_abi() {
    env::value_return(include_bytes!("../abi/contri_abi.zst"));
}

// ----------------------------------------------------------------------
// Storage. Each circle, record and credit has its own key, so a call reads
// and writes only what it touches. Values are borsh.
//   "c" + circle id (8 bytes, little endian) -> Circle
//   "r" + account id                         -> Record
//   "k" + account id                         -> credit (u128)
// The contract struct itself is stored under "STATE" by near-sdk.
// ----------------------------------------------------------------------

fn key(prefix: u8, id: &[u8]) -> Vec<u8> {
    let mut k = Vec::with_capacity(1 + id.len());
    k.push(prefix);
    k.extend_from_slice(id);
    k
}

fn load<T: BorshDeserialize>(key: &[u8]) -> Option<T> {
    let bytes = env::storage_read(key)?;
    Some(T::try_from_slice(&bytes).unwrap_or_else(|_| env::panic_str("corrupt storage")))
}

fn store<T: BorshSerialize>(key: &[u8], value: &T) {
    env::storage_write(key, &borsh::to_vec(value).unwrap_or_else(|_| env::abort()));
}

fn load_circle(id: u64) -> Option<Circle> {
    load(&key(b'c', &id.to_le_bytes()))
}

fn save_circle(c: &Circle) {
    store(&key(b'c', &c.id.to_le_bytes()), c);
}

fn find_circle(id: u64) -> Result<Circle, String> {
    load_circle(id).ok_or_else(|| "circle not found".to_string())
}

fn circle_or_panic(id: u64) -> Circle {
    load_circle(id).unwrap_or_else(|| env::panic_str("circle not found"))
}

fn load_record(account_id: &AccountId) -> Record {
    load(&key(b'r', account_id.as_str().as_bytes())).unwrap_or_default()
}

fn save_record(account_id: &AccountId, r: &Record) {
    store(&key(b'r', account_id.as_str().as_bytes()), r);
}

fn load_credit(account_id: &AccountId) -> u128 {
    load(&key(b'k', account_id.as_str().as_bytes())).unwrap_or(0)
}

fn save_credit(account_id: &AccountId, amount: u128) {
    let k = key(b'k', account_id.as_str().as_bytes());
    if amount == 0 {
        env::storage_remove(&k);
    } else {
        store(&k, &amount);
    }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

/// Whether the `mt_transfer` this callback follows went through. Only an
/// explicit failure counts as failed, so a payout that was made is never retried.
fn transfer_succeeded() -> bool {
    !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed))
}

/// When a circle ends, splits what is left of its backing between the backers
/// in proportion to what each put in. `release_deposits` sends the shares.
fn close_backing(c: &mut Circle) {
    let left = c.backing.0;
    let total: u128 = c.backers.iter().map(|b| b.amount.0).sum();
    c.backing = U128(0);
    if left == 0 || total == 0 {
        return;
    }
    let mut given = 0;
    for b in c.backers.iter_mut() {
        let share = left * b.amount.0 / total;
        b.due = U128(share);
        given += share;
    }
    // Rounding leftovers go to the first backer, so nothing stays behind.
    c.backers[0].due = U128(c.backers[0].due.0 + left - given);
}

fn parse_seat_token(token_id: &str) -> Option<(u64, u32)> {
    let (a, b) = token_id.split_once(':')?;
    Some((a.parse().ok()?, b.parse().ok()?))
}

/// NEP-171 token with NEP-177 metadata for one seat. The circle's name is
/// private (encrypted by the app), so it never appears in token metadata.
fn seat_token_json(c: &Circle, seat: u32, owner: &AccountId) -> String {
    let turn = seat + 1;
    let title = format!("Contri seat - turn {turn} of {}", c.size);
    let description = format!("Receives the pot in round {turn} of Contri circle #{}.", c.id);
    let price = c.listings.get(seat as usize).copied().flatten();
    let extra = format!(
        r#"{{"circle":{},"seat":{seat},"payout_round":{seat},"price":{}}}"#,
        c.id,
        opt_amount(price)
    );
    format!(
        r#"{{"token_id":"{}:{seat}","owner_id":"{owner}","metadata":{{"title":{},"description":{},"extra":{}}}}}"#,
        c.id,
        jstr(&title),
        jstr(&description),
        jstr(&extra)
    )
}

/// `"123"` or `null`.
fn opt_amount(a: Option<U128>) -> String {
    match a {
        Some(a) => format!("\"{}\"", a.0),
        None => "null".into(),
    }
}

/// Returns a raw JSON value from a view or call.
fn ret(json: &str) {
    #[cfg(test)]
    tests::RETURNED.with(|r| *r.borrow_mut() = json.to_string());
    env::value_return(json.as_bytes());
}

fn join(items: impl Iterator<Item = String>) -> String {
    items.collect::<Vec<_>>().join(",")
}

/// JSON string literal with escaping.
pub(crate) fn jstr(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for ch in s.chars() {
        match ch {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// The call's JSON arguments. No arguments reads as `{}`.
fn args() -> json::Json {
    let raw = env::input().unwrap_or_default();
    if raw.is_empty() {
        return json::Json::Obj(vec![]);
    }
    json::parse(&raw).unwrap_or_else(|| env::panic_str("arguments must be valid JSON"))
}

fn bad(key: &str) -> ! {
    env::panic_str(&format!("missing or invalid argument: {key}"))
}

fn arg<'a>(a: &'a json::Json, key: &str) -> &'a json::Json {
    a.get(key).unwrap_or_else(|| bad(key))
}

fn arg_str(a: &json::Json, key: &str) -> String {
    arg(a, key).as_str().unwrap_or_else(|| bad(key)).to_string()
}

fn arg_account(a: &json::Json, key: &str) -> AccountId {
    arg_str(a, key).parse().unwrap_or_else(|_| bad(key))
}

fn arg_u32(a: &json::Json, key: &str) -> u32 {
    arg(a, key).as_uint().unwrap_or_else(|| bad(key))
}

fn arg_u64(a: &json::Json, key: &str) -> u64 {
    arg(a, key).as_uint().unwrap_or_else(|| bad(key))
}

fn arg_u128(a: &json::Json, key: &str) -> u128 {
    arg(a, key).as_uint().unwrap_or_else(|| bad(key))
}

fn arg_list<'a>(a: &'a json::Json, key: &str) -> &'a [json::Json] {
    arg(a, key).as_arr().unwrap_or_else(|| bad(key))
}

/// An optional unsigned integer argument. Absent or `null` reads as `None`.
fn opt_uint<T: core::str::FromStr>(a: &json::Json, key: &str) -> Option<T> {
    match a.get(key) {
        None => None,
        Some(v) if v.is_null() => None,
        Some(v) => Some(v.as_uint().unwrap_or_else(|| bad(key))),
    }
}

/// `from_index` (default 0) and `limit` (default 50, at most 100) of a list view.
fn page(a: &json::Json) -> (u64, u64) {
    let from = opt_uint(a, "from_index").unwrap_or(0);
    let limit = opt_uint(a, "limit").unwrap_or(PAGE).min(MAX_PAGE);
    (from, limit)
}

/// NEP-297 event log in Contri's own event standard.
fn emit(event: &str, data: String) {
    log_event("contri", event, &data);
}

/// NEP-297 event log in the NEP-171 standard, read by NFT indexers.
fn emit_nft(event: &str, data: String) {
    log_event("nep171", event, &data);
}

fn log_event(standard: &str, event: &str, data: &str) {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"{standard}","version":"1.0.0","event":"{event}","data":[{data}]}}"#
    ));
}
