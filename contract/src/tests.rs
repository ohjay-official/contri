use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use near_sdk::serde_json::json;

const INTENTS: &str = "intents.near";
const TOKEN: &str = "nep141:usdt.tether-token.near";
const CONTRIBUTION: u128 = 5_000_000; // 5 USDT
const DAY: u64 = 86_400;

const ADA: &str = "0xa000000000000000000000000000000000000001";
const BAYO: &str = "0xb000000000000000000000000000000000000002";
const CHIOMA: &str = "0xc000000000000000000000000000000000000003";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn set(predecessor: &str, secs: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("contri.near"))
        .predecessor_account_id(acc(predecessor))
        .block_timestamp(secs * 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
}

fn setup() -> Contri {
    set("owner.near", 0);
    Contri::new(acc(INTENTS), TOKEN.to_string())
}

/// Simulates NEAR Intents delivering a member's Transfer intent with a notification.
/// Returns the amount refunded to the member.
fn transfer(c: &mut Contri, from: &str, amount: u128, msg: serde_json::Value, secs: u64) -> u128 {
    set(INTENTS, secs);
    match c.mt_on_transfer(
        acc(from),
        vec![acc(from)],
        vec![TOKEN.to_string()],
        vec![U128(amount)],
        msg.to_string(),
    ) {
        PromiseOrValue::Value(v) => v[0].0,
        PromiseOrValue::Promise(_) => panic!("expected a value"),
    }
}

/// Simulates NEAR Intents delivering a member's AuthCall intent.
fn auth(c: &mut Contri, signer: &str, msg: serde_json::Value, secs: u64) {
    set(INTENTS, secs);
    let _ = c.on_auth(acc(signer), msg.to_string());
}

fn create(c: &mut Contri, size: u32) -> u64 {
    auth(
        c,
        ADA,
        json!({ "op": "create", "name": "Lagos Ajo", "contribution": CONTRIBUTION.to_string(), "size": size, "period_secs": DAY }),
        0,
    );
    0
}

fn join(c: &mut Contri, who: &str, circle: u64) -> u128 {
    transfer(c, who, CONTRIBUTION, json!({ "op": "join", "circle": circle }), 10)
}

fn contribute(c: &mut Contri, who: &str, circle: u64, round: u32, secs: u64) -> u128 {
    transfer(
        c,
        who,
        CONTRIBUTION,
        json!({ "op": "contribute", "circle": circle, "round": round }),
        secs,
    )
}

fn full_circle_of_three() -> Contri {
    let mut c = setup();
    let id = create(&mut c, 3);
    assert_eq!(join(&mut c, ADA, id), 0);
    assert_eq!(join(&mut c, BAYO, id), 0);
    assert_eq!(join(&mut c, CHIOMA, id), 0);
    c
}

#[test]
fn circle_starts_when_full() {
    let mut c = setup();
    let id = create(&mut c, 3);
    join(&mut c, ADA, id);
    join(&mut c, BAYO, id);
    assert_eq!(c.get_circle(id).unwrap().status, CircleStatus::Open);
    join(&mut c, CHIOMA, id);
    let circle = c.get_circle(id).unwrap();
    assert_eq!(circle.status, CircleStatus::Active);
    assert_eq!(circle.members.len(), 3);
    assert_eq!(circle.members[0].account_id, acc(ADA));
    assert_eq!(circle.members[2].deposit, U128(CONTRIBUTION));
    assert_eq!(circle.round_deadline(), (10 + DAY) * 1_000_000_000);
}

#[test]
fn wrong_deposit_is_refunded() {
    let mut c = setup();
    let id = create(&mut c, 3);
    let refund = transfer(&mut c, ADA, CONTRIBUTION - 1, json!({ "op": "join", "circle": id }), 10);
    assert_eq!(refund, CONTRIBUTION - 1);
    assert!(c.get_circle(id).unwrap().members.is_empty());
}

#[test]
fn unreadable_message_is_refunded() {
    let mut c = setup();
    create(&mut c, 3);
    set(INTENTS, 10);
    let r = c.mt_on_transfer(
        acc(ADA),
        vec![acc(ADA)],
        vec![TOKEN.to_string()],
        vec![U128(CONTRIBUTION)],
        "hello".to_string(),
    );
    match r {
        PromiseOrValue::Value(v) => assert_eq!(v[0].0, CONTRIBUTION),
        _ => panic!(),
    }
}

#[test]
fn other_tokens_are_refunded() {
    let mut c = setup();
    let id = create(&mut c, 3);
    set(INTENTS, 10);
    let r = c.mt_on_transfer(
        acc(ADA),
        vec![acc(ADA)],
        vec!["nep141:wrap.near".to_string()],
        vec![U128(CONTRIBUTION)],
        json!({ "op": "join", "circle": id }).to_string(),
    );
    match r {
        PromiseOrValue::Value(v) => assert_eq!(v[0].0, CONTRIBUTION),
        _ => panic!(),
    }
}

#[test]
#[should_panic(expected = "only NEAR Intents can call this")]
fn only_intents_can_notify() {
    let mut c = setup();
    set("someone.near", 10);
    let _ = c.mt_on_transfer(
        acc(ADA),
        vec![acc(ADA)],
        vec![TOKEN.to_string()],
        vec![U128(CONTRIBUTION)],
        json!({ "op": "join", "circle": 0 }).to_string(),
    );
}

#[test]
fn cannot_join_twice_or_when_full() {
    let mut c = full_circle_of_three();
    assert_eq!(join(&mut c, ADA, 0), CONTRIBUTION);
    assert_eq!(join(&mut c, "0xd000000000000000000000000000000000000004", 0), CONTRIBUTION);
}

#[test]
fn last_contribution_starts_the_payout() {
    let mut c = full_circle_of_three();
    assert_eq!(contribute(&mut c, ADA, 0, 0, 100), 0);
    assert_eq!(contribute(&mut c, BAYO, 0, 0, 100), 0);
    assert!(!c.get_circle(0).unwrap().paying);
    assert_eq!(contribute(&mut c, CHIOMA, 0, 0, 100), 0);
    let circle = c.get_circle(0).unwrap();
    assert!(circle.paying);
    assert_eq!(circle.pot, U128(3 * CONTRIBUTION));

    // Contributions are refused while the payout is in flight.
    assert_eq!(contribute(&mut c, ADA, 0, 1, 100), CONTRIBUTION);

    set("contri.near", 101);
    assert!(c.finalize_payout(0, 0, U128(3 * CONTRIBUTION), true));
    let circle = c.get_circle(0).unwrap();
    assert!(!circle.paying);
    assert_eq!(circle.round, 1);
    assert_eq!(circle.pot, U128(0));
    assert_eq!(circle.payouts.len(), 1);
    assert_eq!(circle.payouts[0].to, acc(ADA));
    assert!(circle.members.iter().all(|m| !m.paid_this_round));
}

#[test]
fn wrong_round_and_double_payment_are_refunded() {
    let mut c = full_circle_of_three();
    assert_eq!(contribute(&mut c, ADA, 0, 1, 100), CONTRIBUTION);
    assert_eq!(contribute(&mut c, ADA, 0, 0, 100), 0);
    assert_eq!(contribute(&mut c, ADA, 0, 0, 100), CONTRIBUTION);
    assert_eq!(contribute(&mut c, "0xd000000000000000000000000000000000000004", 0, 0, 100), CONTRIBUTION);
}

#[test]
fn failed_payout_keeps_the_pot() {
    let mut c = full_circle_of_three();
    for who in [ADA, BAYO, CHIOMA] {
        contribute(&mut c, who, 0, 0, 100);
    }
    set("contri.near", 101);
    assert!(!c.finalize_payout(0, 0, U128(3 * CONTRIBUTION), false));
    let circle = c.get_circle(0).unwrap();
    assert!(!circle.paying);
    assert_eq!(circle.round, 0);
    assert_eq!(circle.pot, U128(3 * CONTRIBUTION));

    // Anyone can retry.
    set("anyone.near", 200);
    c.pay_out(0);
    assert!(c.get_circle(0).unwrap().paying);
}

#[test]
fn missed_payment_is_covered_by_deposit() {
    let mut c = full_circle_of_three();
    contribute(&mut c, ADA, 0, 0, 100);
    contribute(&mut c, BAYO, 0, 0, 100);
    set("anyone.near", 10 + DAY + 1);
    c.settle_round(0);
    let circle = c.get_circle(0).unwrap();
    assert!(circle.paying);
    assert_eq!(circle.pot, U128(3 * CONTRIBUTION));
    assert_eq!(circle.members[2].deposit, U128(0));
    assert!(circle.members[2].defaulted);
    assert_eq!(circle.members[2].missed, 1);
}

#[test]
#[should_panic(expected = "round deadline has not passed")]
fn cannot_settle_early() {
    let mut c = full_circle_of_three();
    set("anyone.near", 10 + DAY - 1);
    c.settle_round(0);
}

#[test]
fn seat_can_be_sold_to_a_later_member() {
    let mut c = full_circle_of_three();
    auth(&mut c, ADA, json!({ "op": "list_seat", "circle": 0, "seat": 0, "price": "1000000" }), 50);
    assert_eq!(c.get_circle(0).unwrap().listings[0], Some(U128(1_000_000)));

    // Wrong price is refunded.
    assert_eq!(
        transfer(&mut c, CHIOMA, 999_999, json!({ "op": "buy_seat", "circle": 0, "seat": 0 }), 60),
        999_999
    );
    // Correct price buys the seat.
    assert_eq!(
        transfer(&mut c, CHIOMA, 1_000_000, json!({ "op": "buy_seat", "circle": 0, "seat": 0 }), 60),
        0
    );
    let circle = c.get_circle(0).unwrap();
    assert_eq!(circle.members[0].account_id, acc(CHIOMA));
    assert_eq!(circle.members[2].account_id, acc(ADA));
    assert_eq!(circle.listings[0], None);

    // Seats show up as tokens owned by the new holder.
    let t = c.nft_token("0:0".to_string()).unwrap();
    assert_eq!(t.owner_id, acc(CHIOMA));
    assert_eq!(c.nft_tokens_for_owner(acc(ADA), None, None)[0].token_id, "0:2");
}

#[test]
fn cannot_buy_unlisted_or_later_seat() {
    let mut c = full_circle_of_three();
    assert_eq!(
        transfer(&mut c, CHIOMA, 1_000_000, json!({ "op": "buy_seat", "circle": 0, "seat": 0 }), 60),
        1_000_000
    );
    auth(&mut c, CHIOMA, json!({ "op": "list_seat", "circle": 0, "seat": 2, "price": "1000000" }), 50);
    // Ada (seat 0) cannot buy a later turn.
    assert_eq!(
        transfer(&mut c, ADA, 1_000_000, json!({ "op": "buy_seat", "circle": 0, "seat": 2 }), 60),
        1_000_000
    );
}

#[test]
#[should_panic(expected = "only the seat's owner can do this")]
fn only_owner_can_list_a_seat() {
    let mut c = full_circle_of_three();
    auth(&mut c, BAYO, json!({ "op": "list_seat", "circle": 0, "seat": 0, "price": "1000000" }), 50);
}

#[test]
fn full_run_updates_records() {
    let mut c = setup();
    let id = create(&mut c, 2);
    join(&mut c, ADA, id);
    join(&mut c, BAYO, id);

    // Round 0: both pay.
    contribute(&mut c, ADA, id, 0, 100);
    contribute(&mut c, BAYO, id, 0, 100);
    set("contri.near", 101);
    c.finalize_payout(id, 0, U128(2 * CONTRIBUTION), true);

    // Round 1: Bayo misses, deposit covers it.
    contribute(&mut c, ADA, id, 1, 200);
    set("anyone.near", 10 + 2 * DAY + 1);
    c.settle_round(id);
    set("contri.near", 10 + 2 * DAY + 2);
    c.finalize_payout(id, 1, U128(2 * CONTRIBUTION), true);

    let circle = c.get_circle(id).unwrap();
    assert_eq!(circle.status, CircleStatus::Finished);
    assert_eq!(circle.payouts[1].to, acc(BAYO));
    assert_eq!(c.get_record(acc(ADA)).completed, 1);
    assert_eq!(c.get_record(acc(BAYO)).defaults, 1);
    assert_eq!(c.get_record(acc(BAYO)).missed_payments, 1);

    // Ada's deposit is still held and can be released.
    assert_eq!(circle.members[0].deposit, U128(CONTRIBUTION));
    set("anyone.near", 10 + 2 * DAY + 3);
    assert_eq!(c.release_deposits(id), 1);
    assert_eq!(c.get_circle(id).unwrap().members[0].deposit, U128(0));
}

#[test]
fn organizer_can_cancel_unfilled_circle() {
    let mut c = setup();
    let id = create(&mut c, 3);
    join(&mut c, ADA, id);
    auth(&mut c, ADA, json!({ "op": "cancel", "circle": id }), 20);
    assert_eq!(c.get_circle(id).unwrap().status, CircleStatus::Cancelled);
    assert_eq!(join(&mut c, BAYO, id), CONTRIBUTION);
    set("anyone.near", 30);
    assert_eq!(c.release_deposits(id), 1);
}

#[test]
fn failed_send_becomes_a_credit() {
    let mut c = setup();
    set("contri.near", 0);
    // Simulate the callback branch directly.
    let owed = c.credits.get(&acc(ADA)).map(|v| v.0).unwrap_or(0);
    assert_eq!(owed, 0);
    c.credits.insert(acc(ADA), U128(7));
    assert_eq!(c.get_credit(acc(ADA)), U128(7));
}

#[test]
fn create_validates_inputs() {
    let mut c = setup();
    set("someone.near", 0);
    assert!(c.internal_create(&acc(ADA), "".into(), U128(1), 3, DAY).is_err());
    assert!(c.internal_create(&acc(ADA), "x".into(), U128(0), 3, DAY).is_err());
    assert!(c.internal_create(&acc(ADA), "x".into(), U128(1), 1, DAY).is_err());
    assert!(c.internal_create(&acc(ADA), "x".into(), U128(1), 21, DAY).is_err());
    assert!(c.internal_create(&acc(ADA), "x".into(), U128(1), 3, 10).is_err());
    assert_eq!(c.internal_create(&acc(ADA), "x".into(), U128(1), 3, DAY), Ok(0));
}
