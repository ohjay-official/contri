//! Tests from an attacker-view audit. Each one asserts the SAFE behaviour:
//! a passing test means the attack fails, a failing test means the bug exists.
//! Helpers mirror `tests.rs` (whose helpers are private to that module).

use super::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};
use std::panic::{catch_unwind, AssertUnwindSafe};

const INTENTS: &str = "intents.near";
const TOKEN: &str = "nep141:usdt.tether-token.near";
const C: u128 = 5_000_000;
const DAY: u64 = 86_400;
const ADA: &str = "0xa000000000000000000000000000000000000001";
const BAYO: &str = "0xb000000000000000000000000000000000000002";
const CHIOMA: &str = "0xc000000000000000000000000000000000000003";
const DAVE: &str = "0xd000000000000000000000000000000000000004";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// A 64-character implicit account, the longest an account can be.
fn implicit(i: u32) -> String {
    format!("{:064x}", 0xabcd_0000_u64 + i as u64)
}

fn ctx(predecessor: &str, secs: u64, input: &str, gas: Gas) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("contri.near"))
        .predecessor_account_id(acc(predecessor))
        .block_timestamp(secs * 1_000_000_000)
        .prepaid_gas(gas);
    let mut c = b.build();
    c.input = std::rc::Rc::from(input.as_bytes());
    testing_env!(c);
}

fn set(predecessor: &str, secs: u64) {
    ctx(predecessor, secs, "", Gas::from_tgas(300));
}

fn setup() -> Contri {
    ctx(
        "owner.near",
        0,
        &format!(r#"{{"intents_id":"{INTENTS}","token_id":"{TOKEN}"}}"#),
        Gas::from_tgas(300),
    );
    Contri::new()
}

/// NEAR Intents delivering a Transfer with a notification, with `gas` for `mt_on_transfer`.
fn transfer_gas(c: &mut Contri, from: &str, amount: u128, msg: &str, secs: u64, gas: Gas) -> u128 {
    ctx(INTENTS, secs, "", gas);
    c.internal_on_transfer(acc(from), vec![TOKEN.to_string()], vec![U128(amount)], msg.to_string())[0]
}

fn transfer(c: &mut Contri, from: &str, amount: u128, msg: &str, secs: u64) -> u128 {
    transfer_gas(c, from, amount, msg, secs, Gas::from_tgas(300))
}

fn auth(c: &mut Contri, signer: &str, msg: &str, secs: u64) {
    set(INTENTS, secs);
    c.internal_on_auth(&acc(signer), msg);
}

fn set_callback(input: &str, result: PromiseResult, secs: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("contri.near"))
        .predecessor_account_id(acc("contri.near"))
        .block_timestamp(secs * 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(30));
    let mut ctx = b.build();
    ctx.input = std::rc::Rc::from(input.as_bytes());
    testing_env!(
        ctx,
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

/// Storage bytes a call adds, measured inside one mocked receipt.
fn grown<T>(f: impl FnOnce() -> T) -> (T, u64) {
    let before = env::storage_usage();
    let out = f();
    (out, env::storage_usage().saturating_sub(before))
}

/// A transfer out that the current context created, with its callback.
struct Out {
    to: String,
    amount: u128,
    callback: String,
    args: String,
}

/// Every `mt_transfer` the current context sent to NEAR Intents.
fn sends() -> Vec<Out> {
    let r = get_created_receipts();
    let mut out = vec![];
    for (i, rec) in r.iter().enumerate() {
        let MockAction::FunctionCallWeight { method_name, args, .. } = &rec.actions[0] else {
            continue;
        };
        if rec.receiver_id != acc(INTENTS) || method_name.as_slice() != b"mt_transfer".as_slice() {
            continue;
        }
        let a: Value = serde_json::from_slice(args).unwrap();
        let MockAction::FunctionCallWeight {
            method_name: cb,
            args: cb_args,
            ..
        } = &r[i + 1].actions[0]
        else {
            panic!("a transfer without its callback")
        };
        out.push(Out {
            to: a["receiver_id"].as_str().unwrap().to_string(),
            amount: a["amount"].as_str().unwrap().parse().unwrap(),
            callback: String::from_utf8(cb.clone()).unwrap(),
            args: String::from_utf8(cb_args.clone()).unwrap(),
        });
    }
    out
}

/// Runs each transfer's callback with the given outcome. Returns what actually left the contract.
fn resolve(c: &mut Contri, pending: Vec<Out>, ok: bool, secs: u64) -> u128 {
    let mut left = 0;
    for o in pending {
        let result = if ok {
            PromiseResult::Successful(vec![])
        } else {
            PromiseResult::Failed
        };
        set_callback(&o.args, result, secs);
        match o.callback.as_str() {
            "on_payout" => c.on_payout(),
            "on_sent" => c.on_sent(),
            other => panic!("unexpected callback {other}"),
        }
        if ok {
            left += o.amount;
        }
    }
    left
}

/// A payment that must be accepted. Adds it to `inn` and returns the transfers it started.
fn pay(c: &mut Contri, inn: &mut u128, who: &str, amount: u128, msg: &str, secs: u64) -> Vec<Out> {
    assert_eq!(transfer(c, who, amount, msg, secs), 0, "{msg} by {who} was refused");
    *inn += amount;
    sends()
}

/// The current round's deadline, in whole seconds (rounded up).
fn deadline(c: &Contri, id: u64) -> u64 {
    c.circle_of(id).unwrap().round_deadline().div_ceil(1_000_000_000)
}

// ----------------------------------------------------------------------
// Findings. Expected to FAIL while the bug exists.
// ----------------------------------------------------------------------

/// M-1. Creating through NEAR Intents and leaving gets the deposit back but
/// leaves an empty Open circle in storage that only its organizer can cancel
/// before `fill_by` (14 days). Looping this fills the contract's storage room
/// for free. Safe behaviour: a circle that holds no member and no money can be
/// cleaned up by anyone right away (or is deleted on the last leave).
/// Expected: FAIL (the stranger's cancel is refused).
#[test]
fn an_emptied_open_circle_can_be_cleaned_up_at_once() {
    let mut c = setup();
    let org = implicit(1);
    let name = "x".repeat(MAX_NAME_LEN);
    let msg = format!("create:{MIN_CONTRIBUTION}:20:60:join:-:{name}");
    for i in 0..3u64 {
        assert_eq!(transfer(&mut c, &org, MIN_CONTRIBUTION, &msg, 1), 0);
        auth(&mut c, &org, &format!("leave:{i}"), 2);
    }
    for i in 0..3u64 {
        // Deleted on the last leave: safe.
        let Some(circle) = c.circle_of(i) else { continue };
        assert!(circle.members.is_empty() && circle.backers.is_empty() && circle.pot.0 == 0);
        let held = env::storage_read(&key(b'c', &i.to_le_bytes())).map_or(0, |v| v.len() + 9 + 40);
        set("keeper.near", 3);
        let cancelled = c.internal_cancel(&acc("keeper.near"), i);
        assert!(
            cancelled.is_ok(),
            "circle {i} holds {held} B of the contract's storage with no money in it, and nobody but its \
             organizer can free it for {FILL_SECS} s: {cancelled:?}"
        );
        set("keeper.near", 4);
        c.internal_close(i);
        assert!(c.circle_of(i).is_none());
    }
}

/// L-1. `internal_contribute` starts the payout when at least 50 Tgas are
/// left, but creating the transfer and its callback costs 45 Tgas of static
/// gas plus about 10 Tgas of receipt fees. In between, the last contribution
/// panics and NEAR Intents refunds it. Safe behaviour: at any gas the last
/// contribution is accepted, and either starts the payout or leaves it for
/// `pay_out`. Expected: FAIL for some value from 50 to about 55 Tgas.
#[test]
fn the_last_contribution_never_panics_near_the_payout_gas_guard() {
    let mut c = setup();
    for (i, tgas) in (46..=64u64).enumerate() {
        let id = i as u64;
        assert_eq!(
            transfer(&mut c, ADA, C, &format!("create:{C}:2:{DAY}:join:-:g{i}"), 1),
            0
        );
        assert_eq!(transfer(&mut c, BAYO, C, &format!("join:{id}"), 2), 0);
        assert_eq!(transfer(&mut c, ADA, C, &format!("contribute:{id}:0"), 3), 0);
        let last = catch_unwind(AssertUnwindSafe(|| {
            transfer_gas(&mut c, BAYO, C, &format!("contribute:{id}:0"), 4, Gas::from_tgas(tgas))
        }));
        assert!(
            last.is_ok(),
            "with {tgas} Tgas the last contribution panicked, so it is refunded and counts as missed"
        );
        assert_eq!(last.unwrap(), 0);
        assert!(c.circle_of(id).unwrap().members.iter().all(|m| m.paid_this_round));
    }
}

/// M-2 (conditional). A circle created before storage reservations existed
/// (id < "F") reserves nothing for its payout records and final track records;
/// they come out of SPARE_BYTES. Once M-1 fills the room, a large such circle's
/// callbacks need more than SPARE_BYTES, and `on_payout` fails after the pot
/// was sent: the circle stays `paying` and its deposits are frozen for good.
/// Safe behaviour: everything such a circle's callbacks write fits in SPARE_BYTES.
/// Expected: FAIL for a 20-member circle of 64-character accounts. Whether it
/// matters on mainnet depends on the stored "F" and on circles 0 and 1.
#[test]
fn a_circle_without_reservations_fits_its_callbacks_in_the_spare_bytes() {
    let mut c = setup();
    set("contri.near", 0);
    store(FIRST_RESERVED_KEY, &1u64);
    store(FIRST_SLOTTED_KEY, &1u64);
    let msg = format!("create:{C}:20:{DAY}:join:-:x");
    assert_eq!(transfer(&mut c, &implicit(0), C, &msg, 0), 0);
    for i in 1..20 {
        assert_eq!(transfer(&mut c, &implicit(i), C, "join:0", 1), 0);
    }
    assert_eq!(reserved(), 0, "circle 0 predates reservations and slots");
    let mut written = 0;
    for round in 0..20u32 {
        let at = 2 + round as u64 * DAY;
        for i in 0..20 {
            assert_eq!(
                transfer(&mut c, &implicit(i), C, &format!("contribute:0:{round}"), at),
                0
            );
        }
        set("contri.near", at + 1);
        let (ok, g) = grown(|| c.finalize_payout(0, round, U128(20 * C), true));
        assert!(ok);
        written += g;
    }
    assert!(
        written <= SPARE_BYTES,
        "an unreserved circle's callbacks wrote {written} B, more than the {SPARE_BYTES} spare bytes that are its only cover"
    );
}

// ----------------------------------------------------------------------
// Attacks the code withstood. Expected to PASS.
// ----------------------------------------------------------------------

/// Two circles sharing the contract's one NEAR Intents balance, with a failed
/// payout and its retry, a seat sale whose payment fails and is claimed, a
/// refill, backing that is used and backing that is returned, missed payments
/// and a payout in flight. Every unit that came in leaves exactly once, each
/// seat is paid once, and every storage reservation is released.
#[test]
fn every_unit_in_two_circles_comes_back_out_exactly_once() {
    let mut c = setup();
    let (mut inn, mut out) = (0u128, 0u128);
    let c2 = 2_000_000u128;

    pay(&mut c, &mut inn, ADA, C, &format!("create:{C}:3:{DAY}:join:-:zero"), 1);
    pay(&mut c, &mut inn, BAYO, C, "join:0", 10);
    pay(&mut c, &mut inn, CHIOMA, C, "join:0", 10);
    pay(
        &mut c,
        &mut inn,
        ADA,
        c2,
        &format!("create:{c2}:2:{DAY}:join:-:one"),
        20,
    );
    pay(&mut c, &mut inn, DAVE, c2, "join:1", 20);
    pay(&mut c, &mut inn, "coop.near", 6_000_000, "back:0", 21);
    pay(&mut c, &mut inn, "church.near", c2, "back:1", 21);
    pay(&mut c, &mut inn, CHIOMA, 1_000_000, "refill:0", 22);

    // Circle 0, round 0: the payout fails once and is retried.
    pay(&mut c, &mut inn, ADA, C, "contribute:0:0", 100);
    pay(&mut c, &mut inn, BAYO, C, "contribute:0:0", 100);
    let p = pay(&mut c, &mut inn, CHIOMA, C, "contribute:0:0", 100);
    assert_eq!((p.len(), p[0].amount, p[0].to.as_str()), (1, 3 * C, ADA));
    // While it is in flight, nothing else moves this circle's money.
    assert_eq!(transfer(&mut c, ADA, C, "contribute:0:1", 101), C);
    assert_eq!(transfer(&mut c, ADA, C, "contribute:0:0", 101), C);
    set("anyone.near", 101);
    assert!(catch_unwind(AssertUnwindSafe(|| c.internal_pay_out(0))).is_err());
    set("anyone.near", 101 + 3 * DAY);
    assert!(catch_unwind(AssertUnwindSafe(|| c.internal_settle(0))).is_err());
    out += resolve(&mut c, p, false, 102);
    assert_eq!(
        c.circle_of(0).unwrap().pot,
        U128(3 * C),
        "a failed payout keeps the pot"
    );
    set("anyone.near", 103);
    c.internal_pay_out(0);
    out += resolve(&mut c, sends(), true, 104);

    // Round 1: Bayo sells seat 1 to Chioma; the payment to Bayo fails and he claims it.
    auth(&mut c, BAYO, "list_seat:0:1:1000000", 110);
    let p = pay(&mut c, &mut inn, CHIOMA, 1_000_000, "buy_seat:0:1", 111);
    assert_eq!((p.len(), p[0].to.as_str()), (1, BAYO));
    out += resolve(&mut c, p, false, 112);
    assert_eq!(c.credit_of(&acc(BAYO)), U128(1_000_000));
    auth(&mut c, BAYO, "claim_credit", 113);
    out += resolve(&mut c, sends(), true, 114);
    // Ada was paid in round 0, so she can't buy a turn again.
    auth(&mut c, BAYO, "list_seat:0:2:1", 115);
    assert_eq!(transfer(&mut c, ADA, 1, "buy_seat:0:2", 116), 1);
    auth(&mut c, BAYO, "unlist_seat:0:2", 117);
    pay(&mut c, &mut inn, ADA, C, "contribute:0:1", 120);
    pay(&mut c, &mut inn, BAYO, C, "contribute:0:1", 120);
    let p = pay(&mut c, &mut inn, CHIOMA, C, "contribute:0:1", 120);
    assert_eq!(p[0].to, CHIOMA);
    out += resolve(&mut c, p, true, 121);

    // Round 2: Bayo misses; his deposit covers it and he still gets his turn.
    pay(&mut c, &mut inn, ADA, C, "contribute:0:2", 200);
    pay(&mut c, &mut inn, CHIOMA, C, "contribute:0:2", 200);
    let t = deadline(&c, 0);
    set("anyone.near", t);
    c.internal_settle(0);
    let p = sends();
    assert_eq!((p[0].to.as_str(), p[0].amount), (BAYO, 3 * C));
    out += resolve(&mut c, p, true, t + 1);
    let zero = c.circle_of(0).unwrap();
    assert_eq!(zero.status, CircleStatus::Finished);
    let paid: Vec<_> = zero.payouts.iter().map(|p| p.to.to_string()).collect();
    assert_eq!(paid, vec![ADA, CHIOMA, BAYO], "each seat paid once");
    set("anyone.near", t + 2);
    assert_eq!(
        c.internal_release(0),
        3,
        "Ada's and Chioma's deposits and the coop's backing"
    );
    out += resolve(&mut c, sends(), true, t + 3);

    // Circle 1: Dave misses both rounds; his deposit, then the backing, covers him.
    pay(&mut c, &mut inn, ADA, c2, "contribute:1:0", t + 4);
    let d = deadline(&c, 1).max(t + 5);
    set("anyone.near", d);
    c.internal_settle(1);
    out += resolve(&mut c, sends(), true, d + 1);
    let d = deadline(&c, 1);
    set("anyone.near", d);
    c.internal_settle(1);
    let p = sends();
    assert_eq!((p[0].to.as_str(), p[0].amount), (DAVE, 2 * c2));
    out += resolve(&mut c, p, true, d + 1);
    assert_eq!(c.circle_of(1).unwrap().status, CircleStatus::Finished);
    set("anyone.near", d + 2);
    assert_eq!(c.internal_release(1), 0, "nothing left in circle 1");

    set("anyone.near", d + 3);
    c.internal_close(0);
    c.internal_close(1);
    assert!(c.circle_of(0).is_none() && c.circle_of(1).is_none());
    assert_eq!(inn, out, "money in {inn} vs money out {out}");
    for who in [ADA, BAYO, CHIOMA, DAVE, "coop.near", "church.near"] {
        assert_eq!(c.credit_of(&acc(who)), U128(0));
    }
    assert_eq!(reserved(), 0, "every reservation and credit slot is released");
}

/// Every refused payment is refunded in full and leaves no trace in storage.
#[test]
fn refused_transfers_change_nothing() {
    let mut c = setup();
    assert_eq!(transfer(&mut c, ADA, C, &format!("create:{C}:3:{DAY}:join:-:x"), 1), 0);
    assert_eq!(transfer(&mut c, BAYO, C, "join:0", 2), 0);
    assert_eq!(transfer(&mut c, CHIOMA, C, "join:0", 2), 0);
    auth(&mut c, CHIOMA, "list_seat:0:2:1000000", 3);
    let snapshot = |c: &Contri| (c.circle_of(0).unwrap().to_json(), reserved(), c.next_circle_id);
    let before = snapshot(&c);
    for (who, amount, msg) in [
        (ADA, C, "contribute:0:1"),
        (ADA, C - 1, "contribute:0:0"),
        (ADA, C + 1, "contribute:0:0"),
        (DAVE, C, "contribute:0:0"),
        (DAVE, C, "join:0"),
        (ADA, C, "join:0"),
        (ADA, 1_000_000, "buy_seat:0:2"),
        (CHIOMA, 1_000_000, "buy_seat:0:1"),
        (DAVE, 1_000_000, "buy_seat:0:2"),
        (BAYO, 999_999, "buy_seat:0:2"),
        (ADA, 2 * C, "refill:0"),
        (DAVE, 1, "refill:0"),
        ("coop.near", C - 1, "back:0"),
        (ADA, C, "create:5000000:1:86400:join:-:x"),
        (ADA, C, "create:5000000:3:59:join:-:x"),
        (ADA, C, "create:5000001:3:86400:join:-:x"),
        (ADA, C, "steal:0"),
        (ADA, C, "join:0:zz"),
        (ADA, C, "contribute:9:0"),
        (ADA, C, "contribute:0:0:0"),
    ] {
        assert_eq!(
            transfer(&mut c, who, amount, msg, 30),
            amount,
            "{msg} by {who} was not refunded"
        );
    }
    ctx(INTENTS, 30, "", Gas::from_tgas(300));
    let other = c.internal_on_transfer(
        acc(ADA),
        vec!["nep141:fake.near".into()],
        vec![U128(C)],
        "contribute:0:0".into(),
    );
    assert_eq!(other, vec![C]);
    ctx(INTENTS, 30, "", Gas::from_tgas(300));
    let batch = c.internal_on_transfer(
        acc(ADA),
        vec![TOKEN.into(), TOKEN.into()],
        vec![U128(C), U128(C)],
        "contribute:0:0".into(),
    );
    assert_eq!(batch, vec![C, C]);
    assert_eq!(snapshot(&c), before);
}

/// The hand-written JSON reader refuses duplicate keys, so a notification can't
/// carry a second `sender_id` that another parser would read differently.
#[test]
#[should_panic(expected = "arguments must be valid JSON")]
fn a_second_sender_id_is_refused() {
    let mut c = setup();
    ctx(
        INTENTS,
        1,
        &format!(
            r#"{{"sender_id":"{ADA}","sender_id":"{BAYO}","previous_owner_ids":[],"token_ids":["{TOKEN}"],"amounts":["5000000"],"msg":"create:5000000:2:86400:join:-:x"}}"#
        ),
        Gas::from_tgas(300),
    );
    c.mt_on_transfer();
}

/// A circle's payout in flight never lets anyone settle, retry or trade a seat
/// in it, and a callback for a round that already closed changes nothing.
#[test]
fn a_stale_payout_callback_cannot_close_a_round_twice() {
    let mut c = setup();
    assert_eq!(transfer(&mut c, ADA, C, &format!("create:{C}:2:{DAY}:join:-:x"), 1), 0);
    assert_eq!(transfer(&mut c, BAYO, C, "join:0", 2), 0);
    assert_eq!(transfer(&mut c, ADA, C, "contribute:0:0", 3), 0);
    assert_eq!(transfer(&mut c, BAYO, C, "contribute:0:0", 3), 0);
    let first = sends();
    let args = first[0].args.clone();
    resolve(&mut c, first, true, 4);
    assert_eq!(c.circle_of(0).unwrap().round, 1);
    // The same callback again (as if replayed): round 0 is not paid twice and round 1 doesn't move.
    set_callback(&args, PromiseResult::Successful(vec![]), 5);
    c.on_payout();
    let circle = c.circle_of(0).unwrap();
    assert_eq!((circle.round, circle.payouts.len(), circle.paying), (1, 1, false));
}
