//! Contri: rotating savings circles where the contract holds the pot.
//!
//! Money lives in this contract's balance on NEAR Intents (`intents.near`).
//! Members are NEAR Intents accounts, usually derived from a passkey or a
//! Tron/EVM wallet key, so they never need a NEAR account.
//!
//! Entry points from NEAR Intents (predecessor must be `intents_id`):
//! - `mt_on_transfer`: a member's signed `Transfer` intent with a notification
//!   message. Used to join (deposit), contribute and buy a seat.
//! - `on_auth`: a member's signed `AuthCall` intent. Used to create a circle,
//!   list or unlist a seat, cancel an unfilled circle and claim credits.
//!
//! Messages are compact text, for example `contribute:0:1`. See `parse_transfer`
//! and `parse_auth`. Plain text keeps the contract small, and storage on NEAR
//! costs 1 NEAR per 100 KB of code.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue, PromiseResult,
};

#[cfg(test)]
mod tests;

pub const MIN_MEMBERS: u32 = 2;
pub const MAX_MEMBERS: u32 = 20;
pub const MIN_PERIOD_SECS: u64 = 60;
pub const MAX_PERIOD_SECS: u64 = 60 * 60 * 24 * 31;
pub const MAX_NAME_LEN: usize = 64;

const NS_PER_SEC: u64 = 1_000_000_000;
const GAS_MT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
/// Gas needed to start a payout from inside another call.
const GAS_FOR_PAYOUT: Gas = Gas::from_tgas(35);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Circles,
    Records,
    Credits,
}

#[near(serializers = [borsh, json])]
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

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Member {
    pub account_id: AccountId,
    /// Deposit still held for this member. Covers a missed contribution.
    pub deposit: U128,
    pub paid_this_round: bool,
    pub defaulted: bool,
    pub missed: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PayoutRecord {
    pub round: u32,
    pub to: AccountId,
    pub amount: U128,
    /// Block timestamp in nanoseconds.
    pub at: u64,
}

#[near(serializers = [borsh, json])]
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
    pub status: CircleStatus,
    pub created_at: u64,
    pub started_at: u64,
    pub round: u32,
    pub pot: U128,
    /// A payout is in flight. No other money movement for this circle until it resolves.
    pub paying: bool,
    pub payouts: Vec<PayoutRecord>,
}

impl Circle {
    /// Deadline for the current round, in nanoseconds.
    pub fn round_deadline(&self) -> u64 {
        self.started_at + (self.round as u64 + 1) * self.period_secs * NS_PER_SEC
    }

    fn seat_of(&self, account_id: &AccountId) -> Option<usize> {
        self.members.iter().position(|m| &m.account_id == account_id)
    }

    fn all_paid(&self) -> bool {
        self.members.iter().all(|m| m.paid_this_round)
    }
}

/// A member's track record across circles.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Record {
    pub completed: u32,
    pub defaults: u32,
    pub missed_payments: u32,
}

/// `msg` of a member's `Transfer` intent to this contract.
#[cfg_attr(test, derive(Debug))]
pub enum TransferMsg {
    /// `join:<circle>`: pay the deposit (one contribution) and take the next free seat.
    Join { circle: u64 },
    /// `contribute:<circle>:<round>`: pay this round's contribution.
    Contribute { circle: u64, round: u32 },
    /// `buy_seat:<circle>:<seat>`: pay the asking price for a listed seat and swap it
    /// with your own later seat.
    BuySeat { circle: u64, seat: u32 },
}

/// `msg` of a member's `AuthCall` intent to this contract.
#[cfg_attr(test, derive(Debug))]
pub enum AuthMsg {
    /// `create:<contribution>:<size>:<period_secs>:<name>` (the name may contain `:`).
    Create {
        name: String,
        contribution: U128,
        size: u32,
        period_secs: u64,
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
        "join" => TransferMsg::Join { circle },
        "contribute" => TransferMsg::Contribute { circle, round: p.next()?.parse().ok()? },
        "buy_seat" => TransferMsg::BuySeat { circle, seat: p.next()?.parse().ok()? },
        _ => return None,
    };
    p.next().is_none().then_some(m)
}

pub fn parse_auth(msg: &str) -> Option<AuthMsg> {
    if msg == "claim_credit" {
        return Some(AuthMsg::ClaimCredit);
    }
    let (op, rest) = msg.split_once(':')?;
    if op == "create" {
        let mut p = rest.splitn(4, ':');
        let contribution = U128(p.next()?.parse().ok()?);
        let size = p.next()?.parse().ok()?;
        let period_secs = p.next()?.parse().ok()?;
        let name = p.next()?.to_string();
        return Some(AuthMsg::Create { name, contribution, size, period_secs });
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

#[near(serializers = [json])]
pub struct Config {
    pub owner_id: AccountId,
    pub intents_id: AccountId,
    pub token_id: String,
}

#[near(serializers = [json])]
pub struct SeatToken {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: SeatMetadata,
}

#[near(serializers = [json])]
pub struct SeatMetadata {
    pub title: String,
    pub description: String,
}

#[near(serializers = [json])]
pub struct NftContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
}

#[ext_contract(ext_intents)]
pub trait IntentsMultiToken {
    fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    );
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contri {
    owner_id: AccountId,
    intents_id: AccountId,
    token_id: String,
    circles: LookupMap<u64, Circle>,
    next_circle_id: u64,
    records: LookupMap<AccountId, Record>,
    /// Money owed to an account after an outgoing transfer failed. Claimable.
    credits: LookupMap<AccountId, U128>,
}

#[near]
impl Contri {
    #[init]
    pub fn new(intents_id: AccountId, token_id: String) -> Self {
        Self {
            owner_id: env::predecessor_account_id(),
            intents_id,
            token_id,
            circles: LookupMap::new(StorageKey::Circles),
            next_circle_id: 0,
            records: LookupMap::new(StorageKey::Records),
            credits: LookupMap::new(StorageKey::Credits),
        }
    }

    // ------------------------------------------------------------------
    // Entry points from NEAR Intents
    // ------------------------------------------------------------------

    /// Called by NEAR Intents when a member transfers tokens to this contract
    /// with a notification. Returns the amount to refund to the sender.
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        self.assert_intents();
        let _ = previous_owner_ids;
        if token_ids.len() != 1 || amounts.len() != 1 || token_ids[0] != self.token_id {
            env::log_str("contri: unsupported token, refunding");
            return PromiseOrValue::Value(amounts);
        }
        let amount = amounts[0].0;
        let result = match parse_transfer(&msg) {
            Some(m) => self.handle_transfer(&sender_id, amount, m),
            None => Err("unreadable message".to_string()),
        };
        match result {
            Ok(()) => PromiseOrValue::Value(vec![U128(0)]),
            Err(e) => {
                env::log_str(&format!("contri: refunding {amount}: {e}"));
                PromiseOrValue::Value(vec![U128(amount)])
            }
        }
    }

    /// Called by NEAR Intents for a member's signed `AuthCall` intent.
    pub fn on_auth(&mut self, signer_id: AccountId, msg: String) -> PromiseOrValue<()> {
        self.assert_intents();
        let m = parse_auth(&msg).unwrap_or_else(|| env::panic_str("unreadable message"));
        self.handle_auth(&signer_id, m)
            .unwrap_or_else(|e| env::panic_str(&e));
        PromiseOrValue::Value(())
    }

    // ------------------------------------------------------------------
    // Anyone can call these
    // ------------------------------------------------------------------

    /// Anyone can call this after the round deadline. Missed contributions are
    /// taken from the missing members' deposits, then the pot is paid out.
    pub fn settle_round(&mut self, circle_id: u64) {
        let mut c = self.get_circle_or_panic(circle_id);
        require!(c.status == CircleStatus::Active, "circle is not active");
        require!(!c.paying, "payout already in progress");
        require!(
            env::block_timestamp() >= c.round_deadline(),
            "round deadline has not passed"
        );
        let contribution = c.contribution.0;
        let mut defaulted = vec![];
        for m in c.members.iter_mut() {
            if m.paid_this_round {
                continue;
            }
            let covered = m.deposit.0.min(contribution);
            m.deposit = U128(m.deposit.0 - covered);
            m.paid_this_round = true;
            m.defaulted = true;
            m.missed += 1;
            c.pot = U128(c.pot.0 + covered);
            defaulted.push(m.account_id.clone());
        }
        emit(
            "round_settled",
            format!(r#"{{"circle":{},"round":{},"covered_from_deposit":[{}]}}"#, c.id, c.round, defaulted.iter().map(|a| format!("\"{a}\"")).collect::<Vec<_>>().join(",")),
        );
        self.start_payout(c).detach();
    }

    /// Anyone can call this if every member has paid but the payout did not start
    /// (for example, not enough gas in the last contribution) or a payout failed.
    pub fn pay_out(&mut self, circle_id: u64) {
        let c = self.get_circle_or_panic(circle_id);
        require!(c.status == CircleStatus::Active, "circle is not active");
        require!(!c.paying, "payout already in progress");
        require!(c.all_paid(), "not every member has paid this round");
        self.start_payout(c).detach();
    }

    /// Anyone can call this once a circle has finished or was cancelled.
    /// Returns remaining deposits to members, as many as the attached gas allows.
    pub fn release_deposits(&mut self, circle_id: u64) -> u32 {
        let mut c = self.get_circle_or_panic(circle_id);
        require!(
            c.status == CircleStatus::Finished || c.status == CircleStatus::Cancelled,
            "circle is still running"
        );
        let mut sent = 0;
        for i in 0..c.members.len() {
            let amount = c.members[i].deposit.0;
            if amount == 0 {
                continue;
            }
            let remaining = env::prepaid_gas().saturating_sub(env::used_gas());
            if remaining.as_gas() < GAS_MT_TRANSFER.as_gas() + GAS_CALLBACK.as_gas() + Gas::from_tgas(10).as_gas() {
                break;
            }
            c.members[i].deposit = U128(0);
            let to = c.members[i].account_id.clone();
            self.send(to, amount, format!("contri:{}:deposit", c.id));
            sent += 1;
        }
        self.circles.insert(circle_id, c);
        sent
    }

    // ------------------------------------------------------------------
    // Callbacks
    // ------------------------------------------------------------------

    #[private]
    #[allow(deprecated)]
    pub fn on_payout(&mut self, circle_id: u64, round: u32, amount: U128) -> bool {
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        self.finalize_payout(circle_id, round, amount, ok)
    }

    #[private]
    #[allow(deprecated)]
    pub fn on_sent(&mut self, to: AccountId, amount: U128) -> bool {
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        if !ok {
            let owed = self.credits.get(&to).map(|c| c.0).unwrap_or(0);
            self.credits.insert(to.clone(), U128(owed + amount.0));
            emit("credit_added", format!(r#"{{"account":"{}","amount":"{}"}}"#, to, amount.0));
        }
        ok
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    pub fn get_config(&self) -> Config {
        Config {
            owner_id: self.owner_id.clone(),
            intents_id: self.intents_id.clone(),
            token_id: self.token_id.clone(),
        }
    }

    pub fn get_circle(&self, circle_id: u64) -> Option<Circle> {
        self.circles.get(&circle_id).cloned()
    }

    pub fn get_circles(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Circle> {
        let from = from_index.unwrap_or(0);
        let to = self.next_circle_id.min(from + limit.unwrap_or(50).min(100));
        (from..to).filter_map(|id| self.circles.get(&id).cloned()).collect()
    }

    pub fn get_circles_for(&self, account_id: AccountId) -> Vec<u64> {
        (0..self.next_circle_id)
            .filter(|id| {
                self.circles.get(id).is_some_and(|c| {
                    c.organizer == account_id || c.seat_of(&account_id).is_some()
                })
            })
            .collect()
    }

    pub fn get_record(&self, account_id: AccountId) -> Record {
        self.records.get(&account_id).cloned().unwrap_or_default()
    }

    pub fn get_credit(&self, account_id: AccountId) -> U128 {
        self.credits.get(&account_id).cloned().unwrap_or(U128(0))
    }

    // NEP-171 style views: each seat is a token "<circle>:<seat>".

    pub fn nft_metadata(&self) -> NftContractMetadata {
        NftContractMetadata {
            spec: "nft-1.0.0".into(),
            name: "Contri Seats".into(),
            symbol: "SEAT".into(),
        }
    }

    pub fn nft_token(&self, token_id: String) -> Option<SeatToken> {
        let (circle_id, seat) = parse_seat_token(&token_id)?;
        let c = self.circles.get(&circle_id)?;
        let m = c.members.get(seat as usize)?;
        Some(seat_token(c, seat, &m.account_id))
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u32>,
    ) -> Vec<SeatToken> {
        let mut out = vec![];
        for id in 0..self.next_circle_id {
            if let Some(c) = self.circles.get(&id) {
                if let Some(seat) = c.seat_of(&account_id) {
                    out.push(seat_token(c, seat as u32, &account_id));
                }
            }
        }
        out.into_iter()
            .skip(from_index.map(|i| i.0 as usize).unwrap_or(0))
            .take(limit.unwrap_or(50) as usize)
            .collect()
    }
}

// ----------------------------------------------------------------------
// Internal logic
// ----------------------------------------------------------------------

impl Contri {
    fn assert_intents(&self) {
        require!(
            env::predecessor_account_id() == self.intents_id,
            "only NEAR Intents can call this"
        );
    }

    fn get_circle_or_panic(&self, circle_id: u64) -> Circle {
        self.circles
            .get(&circle_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("circle not found"))
    }

    fn circle(&self, circle_id: u64) -> Result<Circle, String> {
        self.circles
            .get(&circle_id)
            .cloned()
            .ok_or_else(|| "circle not found".to_string())
    }

    pub(crate) fn handle_transfer(
        &mut self,
        sender: &AccountId,
        amount: u128,
        msg: TransferMsg,
    ) -> Result<(), String> {
        match msg {
            TransferMsg::Join { circle } => self.internal_join(sender, circle, amount),
            TransferMsg::Contribute { circle, round } => {
                self.internal_contribute(sender, circle, round, amount)
            }
            TransferMsg::BuySeat { circle, seat } => {
                self.internal_buy_seat(sender, circle, seat, amount)
            }
        }
    }

    pub(crate) fn handle_auth(&mut self, signer: &AccountId, msg: AuthMsg) -> Result<(), String> {
        match msg {
            AuthMsg::Create {
                name,
                contribution,
                size,
                period_secs,
            } => self
                .internal_create(signer, name, contribution, size, period_secs)
                .map(|_| ()),
            AuthMsg::ListSeat {
                circle,
                seat,
                price,
            } => self.internal_list_seat(signer, circle, seat, Some(price)),
            AuthMsg::UnlistSeat { circle, seat } => {
                self.internal_list_seat(signer, circle, seat, None)
            }
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
    ) -> Result<u64, String> {
        let name = name.trim().to_string();
        if name.is_empty() || name.len() > MAX_NAME_LEN {
            return Err(format!("name must be 1 to {MAX_NAME_LEN} characters"));
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
            format!(r#"{{"circle":{},"organizer":"{}","contribution":"{}","size":{},"period_secs":{}}}"#, id, organizer, contribution.0, size, period_secs),
        );
        self.circles.insert(id, c);
        Ok(id)
    }

    fn internal_join(&mut self, who: &AccountId, circle_id: u64, amount: u128) -> Result<(), String> {
        let mut c = self.circle(circle_id)?;
        if c.status != CircleStatus::Open {
            return Err("circle is not open for joining".into());
        }
        if c.seat_of(who).is_some() {
            return Err("already a member".into());
        }
        if c.members.len() as u32 >= c.size {
            return Err("circle is full".into());
        }
        if amount != c.contribution.0 {
            return Err("deposit must equal one contribution".into());
        }
        c.members.push(Member {
            account_id: who.clone(),
            deposit: U128(amount),
            paid_this_round: false,
            defaulted: false,
            missed: 0,
        });
        let seat = c.members.len() - 1;
        emit("joined", format!(r#"{{"circle":{},"member":"{}","seat":{}}}"#, circle_id, who, seat));
        if c.members.len() as u32 == c.size {
            c.status = CircleStatus::Active;
            c.started_at = env::block_timestamp();
            emit(
                "circle_started",
                format!(r#"{{"circle":{},"first_deadline":"{}"}}"#, circle_id, c.round_deadline()),
            );
        }
        self.circles.insert(circle_id, c);
        Ok(())
    }

    fn internal_contribute(
        &mut self,
        who: &AccountId,
        circle_id: u64,
        round: u32,
        amount: u128,
    ) -> Result<(), String> {
        let mut c = self.circle(circle_id)?;
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
            format!(r#"{{"circle":{},"round":{},"member":"{}","amount":"{}"}}"#, circle_id, round, who, amount),
        );
        let ready = c.all_paid();
        let gas_left = env::prepaid_gas().saturating_sub(env::used_gas());
        if ready && gas_left.as_gas() >= GAS_FOR_PAYOUT.as_gas() {
            self.start_payout(c).detach();
        } else {
            self.circles.insert(circle_id, c);
        }
        Ok(())
    }

    fn internal_buy_seat(
        &mut self,
        buyer: &AccountId,
        circle_id: u64,
        seat: u32,
        amount: u128,
    ) -> Result<(), String> {
        let mut c = self.circle(circle_id)?;
        if c.status != CircleStatus::Active && c.status != CircleStatus::Open {
            return Err("seats can only be traded while the circle is running".into());
        }
        if c.paying {
            return Err("payout in progress, try again shortly".into());
        }
        let seat = seat as usize;
        if seat >= c.members.len() {
            return Err("no such seat".into());
        }
        if (seat as u32) < c.round {
            return Err("that turn has already been paid".into());
        }
        let price = c.listings[seat].ok_or("seat is not for sale")?;
        if amount != price.0 {
            return Err("amount must equal the asking price".into());
        }
        let buyer_seat = c.seat_of(buyer).ok_or("only members can buy a seat")?;
        if buyer_seat <= seat {
            return Err("you can only buy a turn earlier than your own".into());
        }
        let seller = c.members[seat].account_id.clone();
        c.members.swap(seat, buyer_seat);
        c.listings[seat] = None;
        c.listings[buyer_seat] = None;
        emit(
            "seat_sold",
            format!(r#"{{"circle":{},"seat":{},"buyer":"{}","seller":"{}","price":"{}","seller_new_seat":{}}}"#, circle_id, seat, buyer, seller, price.0, buyer_seat),
        );
        self.circles.insert(circle_id, c);
        self.send(seller, amount, format!("contri:{circle_id}:seat:{seat}"));
        Ok(())
    }

    pub(crate) fn internal_list_seat(
        &mut self,
        who: &AccountId,
        circle_id: u64,
        seat: u32,
        price: Option<U128>,
    ) -> Result<(), String> {
        let mut c = self.circle(circle_id)?;
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
        if let Some(p) = price {
            if p.0 == 0 {
                return Err("price must be more than zero".into());
            }
        }
        c.listings[s] = price;
        emit(
            if price.is_some() { "seat_listed" } else { "seat_unlisted" },
            format!(r#"{{"circle":{},"seat":{},"price":"{}"}}"#, circle_id, seat, price.map(|p| p.0).unwrap_or(0)),
        );
        self.circles.insert(circle_id, c);
        Ok(())
    }

    pub(crate) fn internal_cancel(&mut self, who: &AccountId, circle_id: u64) -> Result<(), String> {
        let mut c = self.circle(circle_id)?;
        if &c.organizer != who {
            return Err("only the organizer can cancel".into());
        }
        if c.status != CircleStatus::Open {
            return Err("only a circle that has not started can be cancelled".into());
        }
        c.status = CircleStatus::Cancelled;
        emit("circle_cancelled", format!(r#"{{"circle":{}}}"#, circle_id));
        self.circles.insert(circle_id, c);
        Ok(())
    }

    pub(crate) fn internal_claim_credit(&mut self, who: &AccountId) -> Result<(), String> {
        let owed = self.credits.get(who).map(|c| c.0).unwrap_or(0);
        if owed == 0 {
            return Err("nothing to claim".into());
        }
        self.credits.remove(who);
        self.send(who.clone(), owed, "contri:credit".into());
        Ok(())
    }

    /// Sends `amount` of the circle token from this contract's NEAR Intents
    /// balance to `to`. If the transfer fails, the amount becomes a claimable credit.
    fn send(&self, to: AccountId, amount: u128, memo: String) {
        ext_intents::ext(self.intents_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_MT_TRANSFER)
            .mt_transfer(to.clone(), self.token_id.clone(), U128(amount), None, Some(memo))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_sent(to, U128(amount)),
            )
            .detach();
    }

    fn start_payout(&mut self, mut c: Circle) -> Promise {
        let round = c.round;
        let to = c.members[round as usize].account_id.clone();
        let amount = c.pot;
        c.paying = true;
        let id = c.id;
        self.circles.insert(id, c);
        ext_intents::ext(self.intents_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_MT_TRANSFER)
            .mt_transfer(to, self.token_id.clone(), amount, None, Some(format!("contri:{id}:{round}")))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_payout(id, round, amount),
            )
    }

    pub(crate) fn finalize_payout(
        &mut self,
        circle_id: u64,
        round: u32,
        amount: U128,
        ok: bool,
    ) -> bool {
        let Some(mut c) = self.circles.get(&circle_id).cloned() else {
            return false;
        };
        c.paying = false;
        if !ok || c.round != round {
            emit("payout_failed", format!(r#"{{"circle":{},"round":{}}}"#, circle_id, round));
            self.circles.insert(circle_id, c);
            return false;
        }
        let to = c.members[round as usize].account_id.clone();
        c.payouts.push(PayoutRecord {
            round,
            to: to.clone(),
            amount,
            at: env::block_timestamp(),
        });
        emit(
            "paid_out",
            format!(r#"{{"circle":{},"round":{},"to":"{}","amount":"{}"}}"#, circle_id, round, to, amount.0),
        );
        c.pot = U128(0);
        for m in c.members.iter_mut() {
            m.paid_this_round = false;
        }
        c.listings[round as usize] = None;
        c.round += 1;
        if c.round >= c.size {
            c.status = CircleStatus::Finished;
            for m in &c.members {
                let mut r = self.records.get(&m.account_id).cloned().unwrap_or_default();
                if m.defaulted {
                    r.defaults += 1;
                } else {
                    r.completed += 1;
                }
                r.missed_payments += m.missed;
                self.records.insert(m.account_id.clone(), r);
            }
            emit("circle_finished", format!(r#"{{"circle":{}}}"#, circle_id));
        }
        self.circles.insert(circle_id, c);
        true
    }
}

fn parse_seat_token(token_id: &str) -> Option<(u64, u32)> {
    let (a, b) = token_id.split_once(':')?;
    Some((a.parse().ok()?, b.parse().ok()?))
}

fn seat_token(c: &Circle, seat: u32, owner: &AccountId) -> SeatToken {
    SeatToken {
        token_id: format!("{}:{}", c.id, seat),
        owner_id: owner.clone(),
        metadata: SeatMetadata {
            title: format!("{} - turn {}", c.name, seat + 1),
            description: format!(
                "Turn {} of {} in Contri circle #{}. Receives the pot in round {}.",
                seat + 1,
                c.size,
                c.id,
                seat + 1
            ),
        },
    }
}

/// NEP-297 event log.
fn emit(event: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        format!(r#"{{"standard":"contri","version":"1.0.0","event":"{event}","data":[{data}]}}"#)
    ));
}
