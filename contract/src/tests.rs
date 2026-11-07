use super::*;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

thread_local! {
    /// The last JSON value a method returned (`ret` writes it here in tests).
    pub(crate) static RETURNED: std::cell::RefCell<String> = Default::default();
}

fn returned() -> Value {
    RETURNED.with(|r| serde_json::from_str(&r.borrow()).expect("returned value is valid JSON"))
}

/// Calls a view with JSON arguments and returns its result.
fn view(c: &Contri, input: &str, method: fn(&Contri)) -> Value {
    set_with_input("viewer.near", 1_000, input);
    method(c);
    returned()
}

/// NEP-297 events logged in the current context.
fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str(j).expect("event is valid JSON"))
        .collect()
}

fn event<'a>(all: &'a [Value], standard: &str, name: &str) -> &'a Value {
    all.iter()
        .find(|e| e["standard"] == standard && e["event"] == name)
        .unwrap_or_else(|| panic!("no {standard} {name} event in {all:?}"))
}

/// Context for a callback: this contract calls itself, and the call it
/// followed returned `result`.
fn set_callback(input: &str, result: PromiseResult) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("contri.near"))
        .predecessor_account_id(acc("contri.near"))
        .block_timestamp(500 * 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(15));
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

fn set_with_input(predecessor: &str, secs: u64, input: &str) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("contri.near"))
        .predecessor_account_id(acc(predecessor))
        .block_timestamp(secs * 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    let mut ctx = b.build();
    ctx.input = std::rc::Rc::from(input.as_bytes());
    testing_env!(ctx);
}

fn set(predecessor: &str, secs: u64) {
    set_with_input(predecessor, secs, "");
}

fn setup() -> Contri {
    set_with_input(
        "owner.near",
        0,
        &format!(r#"{{"intents_id":"{INTENTS}","token_id":"{TOKEN}"}}"#),
    );
    Contri::new()
}

/// Simulates NEAR Intents delivering a member's Transfer intent with a notification.
/// Returns the amount refunded to the member.
fn transfer(c: &mut Contri, from: &str, amount: u128, msg: &str, secs: u64) -> u128 {
    set(INTENTS, secs);
    c.internal_on_transfer(
        acc(from),
        vec![TOKEN.to_string()],
        vec![U128(amount)],
        msg.to_string(),
    )[0]
}

/// Simulates NEAR Intents delivering a member's AuthCall intent.
fn auth(c: &mut Contri, signer: &str, msg: &str, secs: u64) {
    set(INTENTS, secs);
    c.internal_on_auth(&acc(signer), msg);
}

/// Creates a circle organized by `who` without taking a seat, as a NEAR account
/// does with `create_circle`. `msg` uses the `create:` message format.
fn organize(c: &mut Contri, who: &str, msg: &str, secs: u64) {
    set(who, secs);
    let Some(TransferMsg::Create { name, contribution, size, period_secs, random_order, invite_key }) =
        parse_transfer(msg)
    else {
        panic!("not a create message: {msg}")
    };
    c.internal_create(&acc(who), name, contribution, size, period_secs, random_order, invite_key)
        .unwrap_or_else(|e| env::panic_str(&e));
}

/// A NEAR account's direct call with JSON arguments and attached NEAR.
fn set_with_deposit(predecessor: &str, secs: u64, input: &str, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("contri.near"))
        .predecessor_account_id(acc(predecessor))
        .block_timestamp(secs * 1_000_000_000)
        .attached_deposit(deposit)
        .prepaid_gas(Gas::from_tgas(300));
    let mut ctx = b.build();
    ctx.input = std::rc::Rc::from(input.as_bytes());
    testing_env!(ctx);
}

fn create(c: &mut Contri, size: u32) -> u64 {
    organize(
        c,
        ADA,
        &format!("create:{CONTRIBUTION}:{size}:{DAY}:join:-:Lagos Ajo"),
        0,
    );
    0
}

fn join(c: &mut Contri, who: &str, circle: u64) -> u128 {
    transfer(c, who, CONTRIBUTION, &format!("join:{circle}"), 10)
}

fn contribute(c: &mut Contri, who: &str, circle: u64, round: u32, secs: u64) -> u128 {
    transfer(
        c,
        who,
        CONTRIBUTION,
        &format!("contribute:{circle}:{round}"),
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
    assert_eq!(c.circle_of(id).unwrap().status, CircleStatus::Open);
    join(&mut c, CHIOMA, id);
    let circle = c.circle_of(id).unwrap();
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
    let refund = transfer(&mut c, ADA, CONTRIBUTION - 1, &format!("join:{id}"), 10);
    assert_eq!(refund, CONTRIBUTION - 1);
    assert!(c.circle_of(id).unwrap().members.is_empty());
}

#[test]
fn unreadable_message_is_refunded() {
    let mut c = setup();
    create(&mut c, 3);
    set(INTENTS, 10);
    let r = c.internal_on_transfer(
        acc(ADA),
        vec![TOKEN.to_string()],
        vec![U128(CONTRIBUTION)],
        "hello".to_string(),
    );
    assert_eq!(r[0], CONTRIBUTION);
}

#[test]
fn other_tokens_are_refunded() {
    let mut c = setup();
    let id = create(&mut c, 3);
    set(INTENTS, 10);
    let r = c.internal_on_transfer(
        acc(ADA),
        vec!["nep141:wrap.near".to_string()],
        vec![U128(CONTRIBUTION)],
        format!("join:{id}"),
    );
    assert_eq!(r[0], CONTRIBUTION);
}

#[test]
#[should_panic(expected = "only NEAR Intents can call this")]
fn only_intents_can_notify() {
    let mut c = setup();
    set("someone.near", 10);
    let _ = c.internal_on_transfer(
        acc(ADA),
        vec![TOKEN.to_string()],
        vec![U128(CONTRIBUTION)],
        "join:0".to_string(),
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
    assert!(!c.circle_of(0).unwrap().paying);
    assert_eq!(contribute(&mut c, CHIOMA, 0, 0, 100), 0);
    let circle = c.circle_of(0).unwrap();
    assert!(circle.paying);
    assert_eq!(circle.pot, U128(3 * CONTRIBUTION));

    // Contributions are refused while the payout is in flight.
    assert_eq!(contribute(&mut c, ADA, 0, 1, 100), CONTRIBUTION);

    set("contri.near", 101);
    assert!(c.finalize_payout(0, 0, U128(3 * CONTRIBUTION), true));
    let circle = c.circle_of(0).unwrap();
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
    let circle = c.circle_of(0).unwrap();
    assert!(!circle.paying);
    assert_eq!(circle.round, 0);
    assert_eq!(circle.pot, U128(3 * CONTRIBUTION));

    // Anyone can retry.
    set("anyone.near", 200);
    c.internal_pay_out(0);
    assert!(c.circle_of(0).unwrap().paying);
}

#[test]
fn missed_payment_is_covered_by_deposit() {
    let mut c = full_circle_of_three();
    contribute(&mut c, ADA, 0, 0, 100);
    contribute(&mut c, BAYO, 0, 0, 100);
    set("anyone.near", 10 + DAY + 1);
    c.internal_settle(0);
    let circle = c.circle_of(0).unwrap();
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
    c.internal_settle(0);
}

#[test]
fn seat_can_be_sold_to_a_later_member() {
    let mut c = full_circle_of_three();
    auth(&mut c, ADA, "list_seat:0:0:1000000", 50);
    assert_eq!(c.circle_of(0).unwrap().listings[0], Some(U128(1_000_000)));

    // Wrong price is refunded.
    assert_eq!(
        transfer(&mut c, CHIOMA, 999_999, "buy_seat:0:0", 60),
        999_999
    );
    // Correct price buys the seat.
    assert_eq!(
        transfer(&mut c, CHIOMA, 1_000_000, "buy_seat:0:0", 60),
        0
    );
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.members[0].account_id, acc(CHIOMA));
    assert_eq!(circle.members[2].account_id, acc(ADA));
    assert_eq!(circle.listings[0], None);

    // Seats show up as tokens owned by the new holder.
    assert_eq!(c.seats_of(&acc(CHIOMA)), vec![(0, 0)]);
    assert_eq!(c.seats_of(&acc(ADA)), vec![(0, 2)]);
}

#[test]
fn cannot_buy_unlisted_or_later_seat() {
    let mut c = full_circle_of_three();
    assert_eq!(
        transfer(&mut c, CHIOMA, 1_000_000, "buy_seat:0:0", 60),
        1_000_000
    );
    auth(&mut c, CHIOMA, "list_seat:0:2:1000000", 50);
    // Ada (seat 0) cannot buy a later turn.
    assert_eq!(
        transfer(&mut c, ADA, 1_000_000, "buy_seat:0:2", 60),
        1_000_000
    );
}

#[test]
#[should_panic(expected = "only the seat's owner can do this")]
fn only_owner_can_list_a_seat() {
    let mut c = full_circle_of_three();
    auth(&mut c, BAYO, "list_seat:0:0:1000000", 50);
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

    // Round 1 is Bayo's turn and he doesn't pay it: his share would only have
    // come back to him, so nobody is owed it and his deposit stays.
    contribute(&mut c, ADA, id, 1, 200);
    set("anyone.near", 10 + 2 * DAY + 1);
    c.internal_settle(id);
    assert_eq!(c.circle_of(id).unwrap().pot, U128(CONTRIBUTION));
    set("contri.near", 10 + 2 * DAY + 2);
    c.finalize_payout(id, 1, U128(CONTRIBUTION), true);

    let circle = c.circle_of(id).unwrap();
    assert_eq!(circle.status, CircleStatus::Finished);
    assert_eq!(circle.payouts[1].to, acc(BAYO));
    assert_eq!(circle.payouts[1].shortfall, U128(0));
    assert_eq!(c.record_of(&acc(ADA)).completed, 1);
    assert_eq!(c.record_of(&acc(BAYO)).completed, 1);
    assert_eq!(c.record_of(&acc(BAYO)).missed_payments, 1);

    // Both deposits are still held and can be released.
    assert_eq!(circle.members[0].deposit, U128(CONTRIBUTION));
    assert_eq!(circle.members[1].deposit, U128(CONTRIBUTION));
    set("anyone.near", 10 + 2 * DAY + 3);
    assert_eq!(c.internal_release(id), 2);
    assert_eq!(c.circle_of(id).unwrap().members[0].deposit, U128(0));
}

#[test]
fn organizer_can_cancel_unfilled_circle() {
    let mut c = setup();
    let id = create(&mut c, 3);
    join(&mut c, ADA, id);
    auth(&mut c, ADA, &format!("cancel:{id}"), 20);
    assert_eq!(c.circle_of(id).unwrap().status, CircleStatus::Cancelled);
    assert_eq!(join(&mut c, BAYO, id), CONTRIBUTION);
    set("anyone.near", 30);
    assert_eq!(c.internal_release(id), 1);
}

#[test]
fn failed_send_becomes_a_credit() {
    let mut c = setup();
    set("contri.near", 0);
    assert_eq!(c.credit_of(&acc(ADA)), U128(0));
    c.add_credit(acc(ADA), 7);
    c.add_credit(acc(ADA), 3);
    assert_eq!(c.credit_of(&acc(ADA)), U128(10));
}

#[test]
fn create_validates_inputs() {
    let mut c = setup();
    set("someone.near", 0);
    assert!(c.internal_create(&acc(ADA), "".into(), U128(MIN_CONTRIBUTION), 3, DAY, false, None).is_err());
    assert!(c.internal_create(&acc(ADA), "x".into(), U128(0), 3, DAY, false, None).is_err());
    assert!(c.internal_create(&acc(ADA), "x".into(), U128(MIN_CONTRIBUTION - 1), 3, DAY, false, None).is_err());
    assert!(c.internal_create(&acc(ADA), "x".into(), U128(MIN_CONTRIBUTION), 1, DAY, false, None).is_err());
    assert!(c.internal_create(&acc(ADA), "x".into(), U128(MIN_CONTRIBUTION), 21, DAY, false, None).is_err());
    assert!(c.internal_create(&acc(ADA), "x".into(), U128(MIN_CONTRIBUTION), 3, 10, false, None).is_err());
    assert_eq!(c.internal_create(&acc(ADA), "x".into(), U128(MIN_CONTRIBUTION), 3, DAY, false, None), Ok(0));
}

#[test]
fn messages_parse_strictly() {
    assert!(matches!(parse_transfer("join:3"), Some(TransferMsg::Join { circle: 3, invite_sig: None })));
    assert!(matches!(
        parse_transfer("contribute:3:2"),
        Some(TransferMsg::Contribute { circle: 3, round: 2 })
    ));
    assert!(matches!(parse_transfer("buy_seat:1:0"), Some(TransferMsg::BuySeat { circle: 1, seat: 0 })));
    assert!(matches!(parse_transfer("ahead:1:4"), Some(TransferMsg::Ahead { circle: 1, rounds: 4 })));
    assert!(parse_transfer("ahead:1").is_none());
    assert!(parse_transfer("ahead:1:x").is_none());
    assert!(parse_transfer("ahead:1:2:3").is_none());
    assert!(parse_transfer("join:3:9").is_none());
    assert!(parse_transfer("contribute:3").is_none());
    assert!(parse_transfer("join:x").is_none());
    assert!(parse_transfer("steal:1").is_none());
    assert!(parse_transfer("").is_none());

    match parse_transfer("create:5000000:5:86400:join:-:Ada's: Lagos circle") {
        Some(TransferMsg::Create { name, contribution, size, period_secs, random_order, invite_key }) => {
            assert!(!random_order);
            assert_eq!(invite_key, None);
            assert_eq!(name, "Ada's: Lagos circle");
            assert_eq!(contribution, U128(5_000_000));
            assert_eq!(size, 5);
            assert_eq!(period_secs, 86_400);
        }
        _ => panic!("create did not parse"),
    }
    assert!(matches!(
        parse_auth("list_seat:0:1:700000"),
        Some(AuthMsg::ListSeat { circle: 0, seat: 1, price: U128(700_000) })
    ));
    assert!(matches!(parse_auth("unlist_seat:0:1"), Some(AuthMsg::UnlistSeat { circle: 0, seat: 1 })));
    assert!(matches!(parse_auth("cancel:4"), Some(AuthMsg::Cancel { circle: 4 })));
    assert!(matches!(parse_auth("claim_credit"), Some(AuthMsg::ClaimCredit)));
    assert!(parse_auth("cancel:4:extra").is_none());
    assert!(parse_transfer("create:5:5:86400").is_none());
    // Creating is a Transfer (with the organizer's deposit), not an AuthCall.
    assert!(parse_auth("create:5000000:5:86400:join:-:x").is_none());
}

#[test]
#[should_panic(expected = "unreadable message")]
fn unreadable_auth_message_panics() {
    let mut c = setup();
    auth(&mut c, ADA, "make_me_rich", 1);
}

#[test]
fn views_return_valid_json() {
    let mut c = full_circle_of_three();
    organize(&mut c, ADA, "create:1000000:2:3600:join:-:Mama \"Tolu\" \\ circle", 1);
    let circle: Value = serde_json::from_str(&c.circle_of(0).unwrap().to_json()).unwrap();
    assert_eq!(circle["status"], "Active");
    assert_eq!(circle["contribution"], "5000000");
    assert_eq!(circle["members"][1]["account_id"], BAYO);
    assert_eq!(circle["members"].as_array().unwrap().len(), 3);
    assert!(circle["round_deadline"].is_string());
    assert_eq!(circle["listings"][0], Value::Null);

    let quoted: Value = serde_json::from_str(&c.circle_of(1).unwrap().to_json()).unwrap();
    assert_eq!(quoted["name"], "Mama \"Tolu\" \\ circle");
    assert_eq!(quoted["round_deadline"], Value::Null);

    let record: Value = serde_json::from_str(&c.record_of(&acc(ADA)).to_json()).unwrap();
    assert_eq!(record["completed"], 0);

    let seat: Value = serde_json::from_str(&seat_token_json(&c.circle_of(0).unwrap(), 2, &acc(CHIOMA))).unwrap();
    assert_eq!(seat["token_id"], "0:2");
    assert_eq!(seat["owner_id"], CHIOMA);
    assert!(seat["metadata"]["title"].as_str().unwrap().contains("turn 3"));
}

#[test]
fn jstr_escapes_control_characters() {
    let raw = "line\nbreak\ttab\u{1}end";
    let v: Value = serde_json::from_str(&jstr(raw)).unwrap();
    assert_eq!(v, raw);
}

#[test]
fn public_methods_read_json_arguments() {
    let mut c = setup();
    for (who, msg) in [(ADA, "create:5000000:2:86400:join:-:Test"), (BAYO, "join:0")] {
        set_with_input(
            INTENTS,
            2,
            &format!(
                r#"{{"sender_id":"{who}","previous_owner_ids":["{who}"],"token_ids":["{TOKEN}"],"amounts":["5000000"],"msg":"{msg}"}}"#
            ),
        );
        c.mt_on_transfer();
    }
    assert_eq!(c.circle_of(0).unwrap().name, "Test");
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.status, CircleStatus::Active);
    assert_eq!(circle.members[1].account_id, acc(BAYO));

    // Views read their arguments too and must not panic.
    set_with_input("viewer.near", 3, r#"{"circle_id":0}"#);
    c.get_circle();
    set_with_input("viewer.near", 3, r#"{"from_index":0,"limit":10}"#);
    c.get_circles();
    set_with_input("viewer.near", 3, "");
    c.get_circles();
    set_with_input("viewer.near", 3, &format!(r#"{{"account_id":"{ADA}"}}"#));
    c.get_circles_for();
    c.get_record();
    c.get_credit();
    set_with_input("viewer.near", 3, r#"{"token_id":"0:1"}"#);
    c.nft_token();
    set_with_input("viewer.near", 3, &format!(r#"{{"account_id":"{BAYO}","from_index":"0","limit":5}}"#));
    c.nft_tokens_for_owner();
}

#[test]
#[should_panic(expected = "missing or invalid argument: circle_id")]
fn missing_argument_panics_clearly() {
    let mut c = setup();
    set_with_input("anyone.near", 1, r#"{"circle":0}"#);
    c.settle_round();
}

#[test]
#[should_panic(expected = "arguments must be valid JSON")]
fn invalid_json_panics_clearly() {
    let mut c = setup();
    set_with_input("anyone.near", 1, r#"{"circle_id":0"#);
    c.settle_round();
}

#[test]
fn json_reader() {
    use crate::json::{parse, Json};
    let v = parse(br#" { "a" : "x\"y\\z\n", "n": 42, "big": "340282366920938463463374607431768211455",
        "list": ["p", "q"], "nested": {"t": true, "f": false, "z": null}, "e": [] } "#)
    .unwrap();
    assert_eq!(v.get("a").unwrap().as_str(), Some("x\"y\\z\n"));
    assert_eq!(v.get("n").unwrap().as_uint::<u64>(), Some(42));
    assert_eq!(v.get("big").unwrap().as_uint::<u128>(), Some(u128::MAX));
    assert_eq!(v.get("list").unwrap().as_arr().unwrap().len(), 2);
    assert!(v.get("nested").unwrap().get("z").unwrap().is_null());
    assert!(matches!(v.get("nested").unwrap().get("t"), Some(Json::Bool(true))));
    assert!(v.get("missing").is_none());

    // Unicode escapes, including a surrogate pair.
    let u = parse(br#""\u00e9\ud83d\ude00""#).unwrap();
    assert_eq!(u.as_str(), Some("\u{e9}\u{1f600}"));

    // Strictness.
    assert!(parse(br#"{"a":1} x"#).is_none());
    assert!(parse(br#"{"a":1,}"#).is_none());
    assert!(parse(br#"{"a" 1}"#).is_none());
    assert!(parse(b"\"raw\ncontrol\"").is_none());
    assert!(parse(br#""\ud83d""#).is_none());
    assert!(parse(br#"[[[[[[[[[[1]]]]]]]]]]"#).is_none());
    assert!(parse(b"").is_none());
    assert_eq!(parse(br#"-1"#).unwrap().as_uint::<u64>(), None);
    assert_eq!(parse(br#"1.5"#).unwrap().as_uint::<u64>(), None);
}

#[test]
fn transfer_notification_returns_refunds() {
    let mut c = setup();
    create(&mut c, 2);
    let call = |c: &mut Contri, amount: u128| {
        set_with_input(
            INTENTS,
            5,
            &format!(
                r#"{{"sender_id":"{ADA}","previous_owner_ids":["{ADA}"],"token_ids":["{TOKEN}"],"amounts":["{amount}"],"msg":"join:0"}}"#
            ),
        );
        c.mt_on_transfer();
        returned()
    };
    assert_eq!(call(&mut c, 1), json!(["1"]));
    assert_eq!(call(&mut c, CONTRIBUTION), json!(["0"]));
}

#[test]
fn payout_is_an_intents_transfer_then_a_callback() {
    use near_sdk::mock::MockAction;
    let mut c = full_circle_of_three();
    for who in [ADA, BAYO, CHIOMA] {
        contribute(&mut c, who, 0, 0, 100);
    }
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);

    // 1. intents.near moves the pot out of this contract's own balance.
    assert_eq!(receipts[0].receiver_id, acc(INTENTS));
    match &receipts[0].actions[..] {
        [MockAction::FunctionCallWeight { method_name, args, attached_deposit, prepaid_gas, gas_weight, .. }] => {
            assert_eq!(method_name, b"mt_transfer");
            let args: Value = serde_json::from_slice(args).unwrap();
            assert_eq!(
                args,
                json!({
                    "receiver_id": ADA,
                    "token_id": TOKEN,
                    "amount": (3 * CONTRIBUTION).to_string(),
                    "memo": "contri:0:0",
                })
            );
            assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
            assert_eq!(*prepaid_gas, Gas::from_tgas(15));
            assert_eq!(gas_weight.0, 1, "the transfer also gets a share of the gas left over");
        }
        other => panic!("unexpected actions {other:?}"),
    }

    // 2. Then a callback on this contract, which waits for the transfer.
    assert_eq!(receipts[1].receiver_id, acc("contri.near"));
    assert_eq!(receipts[1].receipt_indices, vec![0]);
    match &receipts[1].actions[..] {
        [MockAction::FunctionCallWeight { method_name, prepaid_gas, gas_weight, .. }] => {
            assert_eq!(method_name, b"on_payout");
            assert_eq!(*prepaid_gas, Gas::from_tgas(30));
            assert_eq!(gas_weight.0, 1);
        }
        other => panic!("unexpected actions {other:?}"),
    }
}

#[test]
fn payout_callback_reads_the_transfer_result() {
    let pot = 3 * CONTRIBUTION;
    let args = format!(r#"{{"circle_id":0,"round":0,"amount":"{pot}"}}"#);
    let mut c = full_circle_of_three();
    for who in [ADA, BAYO, CHIOMA] {
        contribute(&mut c, who, 0, 0, 100);
    }

    // The transfer failed: the pot stays and the round does not move.
    set_callback(&args, PromiseResult::Failed);
    c.on_payout();
    let circle = c.circle_of(0).unwrap();
    assert_eq!((circle.round, circle.pot, circle.paying), (0, U128(pot), false));
    event(&events(), "contri", "payout_failed");

    // Anyone retries, and this time it goes through.
    set("anyone.near", 200);
    c.internal_pay_out(0);
    set_callback(&args, PromiseResult::Successful(vec![]));
    c.on_payout();
    let circle = c.circle_of(0).unwrap();
    assert_eq!((circle.round, circle.pot, circle.paying), (1, U128(0), false));
    assert_eq!(event(&events(), "contri", "paid_out")["data"][0]["to"], ADA);
}

#[test]
fn only_an_explicit_failure_leaves_the_round_open() {
    // A transfer that went through must never be paid again, whatever it returned.
    let mut c = full_circle_of_three();
    for who in [ADA, BAYO, CHIOMA] {
        contribute(&mut c, who, 0, 0, 100);
    }
    set_callback(
        &format!(r#"{{"circle_id":0,"round":0,"amount":"{}"}}"#, 3 * CONTRIBUTION),
        PromiseResult::Successful(br#"["15000000"]"#.to_vec()),
    );
    c.on_payout();
    assert_eq!(c.circle_of(0).unwrap().round, 1);
}

#[test]
fn failed_transfer_out_becomes_a_claimable_credit() {
    let mut c = setup();
    let args = format!(r#"{{"to":"{ADA}","amount":"700"}}"#);
    set_callback(&args, PromiseResult::Successful(vec![]));
    c.on_sent();
    assert_eq!(c.credit_of(&acc(ADA)), U128(0));

    set_callback(&args, PromiseResult::Failed);
    c.on_sent();
    assert_eq!(c.credit_of(&acc(ADA)), U128(700));
    assert_eq!(view(&c, &format!(r#"{{"account_id":"{ADA}"}}"#), Contri::get_credit), "700");

    // Claiming sends it again and clears the credit.
    auth(&mut c, ADA, "claim_credit", 600);
    assert_eq!(get_created_receipts()[0].receiver_id, acc(INTENTS));
    assert_eq!(c.credit_of(&acc(ADA)), U128(0));
}

#[test]
fn storage_has_one_key_per_circle_record_and_credit() {
    let mut c = full_circle_of_three();
    let circle_key = |id: u64| [b"c".as_slice(), &id.to_le_bytes()].concat();
    assert!(env::storage_has_key(&circle_key(0)));
    assert!(!env::storage_has_key(&circle_key(1)));

    set("contri.near", 1);
    c.add_credit(acc(BAYO), 5);
    let credit_key = [b"k".as_slice(), BAYO.as_bytes()].concat();
    assert!(env::storage_has_key(&credit_key));
    auth(&mut c, BAYO, "claim_credit", 2);
    assert!(!env::storage_has_key(&credit_key), "a claimed credit frees its storage");
}

#[test]
fn seats_are_nft_tokens() {
    let mut c = setup();
    let id = create(&mut c, 3);
    join(&mut c, ADA, id);
    join(&mut c, BAYO, id);
    // No tokens until the circle fills and the turn order is final.
    assert!(events().iter().all(|e| e["event"] != "nft_mint"));
    join(&mut c, CHIOMA, id);
    let mint = event(&events(), "nep171", "nft_mint").clone();
    assert_eq!(mint["version"], "1.0.0");
    assert_eq!(
        mint["data"],
        json!([
            {"owner_id": ADA, "token_ids": ["0:0"]},
            {"owner_id": BAYO, "token_ids": ["0:1"]},
            {"owner_id": CHIOMA, "token_ids": ["0:2"]},
        ])
    );

    assert_eq!(view(&c, "", Contri::nft_total_supply), "3");
    assert_eq!(view(&c, &format!(r#"{{"account_id":"{BAYO}"}}"#), Contri::nft_supply_for_owner), "1");

    let page = view(&c, r#"{"from_index":"1","limit":1}"#, Contri::nft_tokens);
    assert_eq!(page.as_array().unwrap().len(), 1);
    assert_eq!(page[0]["token_id"], "0:1");
    assert_eq!(page[0]["owner_id"], BAYO);
    assert_eq!(page[0]["metadata"]["title"], "Contri seat - turn 2 of 3");
    let extra: Value = serde_json::from_str(page[0]["metadata"]["extra"].as_str().unwrap()).unwrap();
    assert_eq!(extra, json!({"circle": 0, "seat": 1, "payout_round": 1, "price": null}));
    // The seat's picture is drawn from the circle's live state.
    let media = page[0]["metadata"]["media"].as_str().unwrap();
    assert!(media.starts_with("data:image/svg+xml,%3Csvg"));
    assert!(media.contains("2/3") && media.contains("Pays in round 2"));
    assert!(media.is_ascii() && !media.contains('"') && !media.contains('<'));
    assert_eq!(view(&c, "", Contri::nft_tokens).as_array().unwrap().len(), 3);

    assert_eq!(view(&c, r#"{"token_id":"0:2"}"#, Contri::nft_token)["owner_id"], CHIOMA);
    assert_eq!(view(&c, r#"{"token_id":"0:3"}"#, Contri::nft_token), Value::Null);
    assert_eq!(view(&c, r#"{"token_id":"seat"}"#, Contri::nft_token), Value::Null);

    let meta = view(&c, "", |_| Contri::nft_metadata());
    assert_eq!(meta["spec"], "nft-1.0.0");
    assert_eq!(meta["symbol"], "SEAT");
    assert!(meta["icon"].as_str().unwrap().starts_with("data:image/svg+xml,"));

    // Selling a seat transfers both tokens: the earlier turn to the buyer,
    // the buyer's later turn to the seller.
    auth(&mut c, ADA, "list_seat:0:0:1000000", 50);
    assert_eq!(page_extra_price(&c, "0:0"), json!("1000000"));
    transfer(&mut c, CHIOMA, 1_000_000, "buy_seat:0:0", 60);
    let moved = event(&events(), "nep171", "nft_transfer").clone();
    assert_eq!(
        moved["data"],
        json!([
            {"old_owner_id": ADA, "new_owner_id": CHIOMA, "token_ids": ["0:0"]},
            {"old_owner_id": CHIOMA, "new_owner_id": ADA, "token_ids": ["0:2"]},
        ])
    );
    let chioma = view(&c, &format!(r#"{{"account_id":"{CHIOMA}"}}"#), Contri::nft_tokens_for_owner);
    assert_eq!(chioma.as_array().unwrap().len(), 1);
    assert_eq!(chioma[0]["token_id"], "0:0");
}

fn page_extra_price(c: &Contri, token_id: &str) -> Value {
    let token = view(c, &format!(r#"{{"token_id":"{token_id}"}}"#), Contri::nft_token);
    let extra: Value = serde_json::from_str(token["metadata"]["extra"].as_str().unwrap()).unwrap();
    extra["price"].clone()
}

#[test]
fn unstarted_and_cancelled_circles_have_no_seat_tokens() {
    let mut c = setup();
    let id = create(&mut c, 3);
    join(&mut c, ADA, id);
    join(&mut c, BAYO, id);
    assert_eq!(view(&c, "", Contri::nft_total_supply), "0");
    assert_eq!(view(&c, r#"{"token_id":"0:0"}"#, Contri::nft_token), Value::Null);
    auth(&mut c, ADA, &format!("cancel:{id}"), 20);
    assert!(events().iter().all(|e| e["standard"] != "nep171"));
    assert_eq!(view(&c, "", Contri::nft_total_supply), "0");
}

#[test]
fn circle_views() {
    let mut c = full_circle_of_three();
    organize(&mut c, BAYO, "create:1000000:2:3600:join:-:Second", 20);
    organize(&mut c, BAYO, "create:1000000:2:3600:join:-:Third", 20);

    let config = view(&c, "", Contri::get_config);
    assert_eq!(config["intents_id"], INTENTS);
    assert_eq!(config["token_id"], TOKEN);
    assert_eq!(config["circle_count"], 3);

    let deadline = ((10 + DAY) * 1_000_000_000).to_string();
    assert_eq!(view(&c, r#"{"circle_id":0}"#, Contri::get_round_deadline), deadline);
    assert_eq!(view(&c, r#"{"circle_id":1}"#, Contri::get_round_deadline), Value::Null);
    assert_eq!(view(&c, r#"{"circle_id":9}"#, Contri::get_round_deadline), Value::Null);
    assert_eq!(view(&c, r#"{"circle_id":0}"#, Contri::get_circle)["round_deadline"], deadline);
    assert_eq!(view(&c, r#"{"circle_id":9}"#, Contri::get_circle), Value::Null);

    let all = view(&c, "", Contri::get_circles);
    assert_eq!(all.as_array().unwrap().len(), 3);
    let page = view(&c, r#"{"from_index":1,"limit":1}"#, Contri::get_circles);
    assert_eq!(page.as_array().unwrap().len(), 1);
    assert_eq!(page[0]["name"], "Second");
    assert_eq!(view(&c, r#"{"from_index":"2","limit":null}"#, Contri::get_circles)[0]["name"], "Third");

    assert_eq!(view(&c, &format!(r#"{{"account_id":"{BAYO}"}}"#), Contri::get_circles_for), json!([0, 1, 2]));
    assert_eq!(view(&c, &format!(r#"{{"account_id":"{ADA}"}}"#), Contri::get_circles_for), json!([0]));
    assert_eq!(
        view(&c, &format!(r#"{{"account_id":"{ADA}"}}"#), Contri::get_record),
        json!({"completed": 0, "defaults": 0, "missed_payments": 0})
    );
}

#[test]
fn source_metadata_names_the_repo_and_standards() {
    let meta: Value = serde_json::from_str(CONTRACT_SOURCE_METADATA).unwrap();
    assert_eq!(meta["link"], "https://github.com/ohjay-official/contri");
    let standards: Vec<&str> = meta["standards"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["standard"].as_str().unwrap())
        .collect();
    assert!(standards.contains(&"nep297") && standards.contains(&"nep330"), "{standards:?}");
}

#[test]
fn near_accounts_can_call_directly() {
    let mut c = setup();
    set_with_deposit(
        "alice.near",
        1,
        r#"{"name":"Direct","contribution":"2000000","size":2,"period_secs":3600}"#,
        CREATE_FEE,
    );
    c.create_circle();
    assert_eq!(returned(), json!(0));
    assert_eq!(c.circle_of(0).unwrap().organizer, acc("alice.near"));

    // Money still comes through NEAR Intents, from the same accounts.
    assert_eq!(transfer(&mut c, "alice.near", 2_000_000, "join:0", 2), 0);
    assert_eq!(transfer(&mut c, "bob.near", 2_000_000, "join:0", 2), 0);

    set_with_input("bob.near", 3, r#"{"circle_id":0,"seat":1,"price":"500000"}"#);
    c.list_seat();
    assert_eq!(c.circle_of(0).unwrap().listings[1], Some(U128(500_000)));
    set_with_input("bob.near", 4, r#"{"circle_id":0,"seat":1}"#);
    c.unlist_seat();
    assert_eq!(c.circle_of(0).unwrap().listings[1], None);

    set("contri.near", 5);
    c.add_credit(acc("bob.near"), 9);
    set_with_input("bob.near", 6, "");
    c.claim_credit();
    assert_eq!(c.credit_of(&acc("bob.near")), U128(0));
    assert_eq!(get_created_receipts()[0].receiver_id, acc(INTENTS));

    set_with_deposit(
        "alice.near",
        7,
        r#"{"name":"Second","contribution":"1000000","size":3,"period_secs":60}"#,
        CREATE_FEE,
    );
    c.create_circle();
    assert_eq!(returned(), json!(1));
    set_with_input("alice.near", 8, r#"{"circle_id":1}"#);
    c.cancel_circle();
    assert_eq!(c.circle_of(1).unwrap().status, CircleStatus::Cancelled);
}

#[test]
#[should_panic(expected = "only the seat's owner can do this")]
fn direct_calls_act_only_for_the_caller() {
    let mut c = full_circle_of_three();
    set_with_input("mallory.near", 1, r#"{"circle_id":0,"seat":0,"price":"1"}"#);
    c.list_seat();
}

#[test]
#[should_panic(expected = "only the organizer can cancel")]
fn only_the_organizer_cancels_directly() {
    let mut c = setup();
    create(&mut c, 3);
    set_with_input("mallory.near", 1, r#"{"circle_id":0}"#);
    c.cancel_circle();
}

#[test]
#[should_panic(expected = "missing or invalid argument: size")]
fn sizes_past_u32_are_rejected_not_truncated() {
    let mut c = setup();
    // 2^32 + 3 would wrap to 3 if it were cast.
    set_with_deposit(
        "alice.near",
        1,
        r#"{"name":"x","contribution":"1000000","size":4294967299,"period_secs":3600}"#,
        CREATE_FEE,
    );
    c.create_circle();
}

/// Every value the contract returns must parse into the typed interface that
/// the ABI is generated from. Those types reject missing and unknown fields.
#[test]
fn views_match_the_typed_interface() {
    use contri_interface as typed;
    use near_sdk::json_types::U64;
    use near_sdk::serde::de::DeserializeOwned;

    fn parse<T: DeserializeOwned>(what: &str, v: Value) -> T {
        serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{what} does not match the interface: {e}\n{v}"))
    }

    // A circle with a finished round, a listed seat and a default, a finished
    // circle with records, and a cancelled one.
    let mut c = full_circle_of_three();
    for who in [ADA, BAYO, CHIOMA] {
        contribute(&mut c, who, 0, 0, 100);
    }
    set("contri.near", 101);
    c.finalize_payout(0, 0, U128(3 * CONTRIBUTION), true);
    auth(&mut c, CHIOMA, "list_seat:0:2:700000", 102);
    assert_eq!(transfer(&mut c, "coop.near", CONTRIBUTION, "back:0", 103), 0);

    organize(&mut c, BAYO, &format!("create:{CONTRIBUTION}:2:3600:join:-:Short"), 200);
    transfer(&mut c, ADA, CONTRIBUTION, "join:1", 201);
    transfer(&mut c, BAYO, CONTRIBUTION, "join:1", 201);
    for round in 0..2u32 {
        contribute(&mut c, ADA, 1, round, 400 + round as u64 * 3700);
        set("anyone.near", 201 + (round as u64 + 1) * 3700);
        c.internal_settle(1);
        set("contri.near", 202 + (round as u64 + 1) * 3700);
        c.finalize_payout(1, round, U128(2 * CONTRIBUTION), true);
    }
    organize(&mut c, ADA, &format!("create:{CONTRIBUTION}:3:3600:join:-:Cancelled"), 9_000);
    auth(&mut c, ADA, "cancel:2", 9_001);
    set("contri.near", 9_002);
    c.add_credit(acc(ADA), 5);

    let ada = format!(r#"{{"account_id":"{ADA}"}}"#);
    let config: typed::Config = parse("get_config", view(&c, "", Contri::get_config));
    assert_eq!(config.circle_count, 3);
    let circle: typed::Circle = parse("get_circle", view(&c, r#"{"circle_id":0}"#, Contri::get_circle));
    assert_eq!(circle.payouts.len(), 1);
    assert_eq!(circle.listings[2], Some(U128(700_000)));
    assert_eq!(circle.status, typed::CircleStatus::Active);
    assert_eq!(circle.backers[0].amount, U128(CONTRIBUTION));
    let short: typed::Circle = parse("get_circle", view(&c, r#"{"circle_id":1}"#, Contri::get_circle));
    assert_eq!(short.status, typed::CircleStatus::Finished);
    assert!(short.members[1].defaulted && short.round_deadline.is_none());
    let none: Option<typed::Circle> = parse("get_circle", view(&c, r#"{"circle_id":7}"#, Contri::get_circle));
    assert!(none.is_none());
    let all: Vec<typed::Circle> = parse("get_circles", view(&c, "", Contri::get_circles));
    assert_eq!(all.len(), 3);
    let _: Option<U64> = parse("get_round_deadline", view(&c, r#"{"circle_id":0}"#, Contri::get_round_deadline));
    let _: Option<U64> = parse("get_round_deadline", view(&c, r#"{"circle_id":1}"#, Contri::get_round_deadline));
    let _: Vec<u64> = parse("get_circles_for", view(&c, &ada, Contri::get_circles_for));
    let record: typed::Record = parse("get_record", view(&c, &ada, Contri::get_record));
    assert_eq!(record.completed, 1);
    let credit: U128 = parse("get_credit", view(&c, &ada, Contri::get_credit));
    assert_eq!(credit, U128(5));

    let _: typed::NftContractMetadata = parse("nft_metadata", view(&c, "", |_| Contri::nft_metadata()));
    let token: Option<typed::Token> = parse("nft_token", view(&c, r#"{"token_id":"0:2"}"#, Contri::nft_token));
    assert!(token.unwrap().metadata.extra.unwrap().contains("700000"));
    let _: Option<typed::Token> = parse("nft_token", view(&c, r#"{"token_id":"2:0"}"#, Contri::nft_token));
    let _: U128 = parse("nft_total_supply", view(&c, "", Contri::nft_total_supply));
    let _: Vec<typed::Token> = parse("nft_tokens", view(&c, "", Contri::nft_tokens));
    let _: U128 = parse("nft_supply_for_owner", view(&c, &ada, Contri::nft_supply_for_owner));
    let _: Vec<typed::Token> = parse("nft_tokens_for_owner", view(&c, &ada, Contri::nft_tokens_for_owner));

    // Calls that return a value.
    set_with_deposit("alice.near", 9_100, r#"{"name":"N","contribution":"1000000","size":2,"period_secs":60}"#, CREATE_FEE);
    c.create_circle();
    let _: u64 = parse("create_circle", returned());
    set_with_input(
        INTENTS,
        9_101,
        &format!(r#"{{"sender_id":"{ADA}","previous_owner_ids":[],"token_ids":["{TOKEN}"],"amounts":["1"],"msg":"join:3"}}"#),
    );
    c.mt_on_transfer();
    let _: Vec<U128> = parse("mt_on_transfer", returned());
    set_with_input("anyone.near", 9_102, r#"{"circle_id":2}"#);
    c.release_deposits();
    let _: u32 = parse("release_deposits", returned());
}

fn hexs(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The invite key the organizer's app makes for a circle. Its secret half
/// lives only in the invite link.
fn invite_key(seed: u8) -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[seed; 32])
}

fn signed_invite(key: &ed25519_dalek::SigningKey, circle: u64, who: &str, deposit: u128) -> String {
    use ed25519_dalek::Signer;
    let message = join_message(&acc("contri.near"), circle, &acc(who), deposit);
    hexs(&key.sign(message.as_bytes()).to_bytes())
}

#[test]
fn invite_only_circle_needs_a_signed_invite() {
    let mut c = setup();
    let key = invite_key(7);
    let public = hexs(key.verifying_key().as_bytes());
    organize(&mut c, "coop.near", &format!("create:{CONTRIBUTION}:2:{DAY}:join:{public}:c2VhbGVkIG5hbWU"), 1);
    assert_eq!(c.circle_of(0).unwrap().invite_key, Some(*key.verifying_key().as_bytes()));

    // No invite, an invite made for someone else, or one from another key: refunded.
    assert_eq!(transfer(&mut c, ADA, CONTRIBUTION, "join:0", 2), CONTRIBUTION);
    let for_bayo = signed_invite(&key, 0, BAYO, CONTRIBUTION);
    assert_eq!(transfer(&mut c, ADA, CONTRIBUTION, &format!("join:0:{for_bayo}"), 2), CONTRIBUTION);
    let forged = signed_invite(&invite_key(9), 0, ADA, CONTRIBUTION);
    assert_eq!(transfer(&mut c, ADA, CONTRIBUTION, &format!("join:0:{forged}"), 2), CONTRIBUTION);
    assert!(c.circle_of(0).unwrap().members.is_empty());

    // The right invites work, and the circle starts.
    let for_ada = signed_invite(&key, 0, ADA, CONTRIBUTION);
    assert_eq!(transfer(&mut c, ADA, CONTRIBUTION, &format!("join:0:{for_ada}"), 3), 0);
    assert_eq!(transfer(&mut c, BAYO, CONTRIBUTION, &format!("join:0:{for_bayo}"), 3), 0);
    assert_eq!(c.circle_of(0).unwrap().status, CircleStatus::Active);
    assert_eq!(view(&c, r#"{"circle_id":0}"#, Contri::get_circle)["invite_only"], true);
}

#[test]
fn open_circles_ignore_invites() {
    let mut c = setup();
    create(&mut c, 2);
    let sig = signed_invite(&invite_key(7), 0, ADA, CONTRIBUTION);
    assert_eq!(transfer(&mut c, ADA, CONTRIBUTION, &format!("join:0:{sig}"), 2), 0);
    assert_eq!(transfer(&mut c, BAYO, CONTRIBUTION, "join:0", 2), 0);
    assert_eq!(view(&c, r#"{"circle_id":0}"#, Contri::get_circle)["invite_only"], false);
}

#[test]
fn invite_messages_parse_strictly() {
    let sig = "ab".repeat(64);
    assert!(matches!(
        parse_transfer(&format!("join:1:{sig}")),
        Some(TransferMsg::Join { circle: 1, invite_sig: Some(_) })
    ));
    assert!(parse_transfer(&format!("join:1:{}", &sig[..126])).is_none());
    assert!(parse_transfer(&format!("join:1:{sig}:x")).is_none());
    assert!(parse_transfer(&format!("join:1:{}", "zz".repeat(64))).is_none());
    let key = "cd".repeat(32);
    assert!(matches!(
        parse_transfer(&format!("create:1:2:60:join:{key}:name")),
        Some(TransferMsg::Create { invite_key: Some(_), .. })
    ));
    assert!(parse_transfer("create:1:2:60:join:abc:name").is_none());
    assert!(parse_transfer("create:1:2:60:name").is_none());
}

#[test]
fn direct_create_takes_an_optional_invite_key() {
    let mut c = setup();
    let key = hexs(invite_key(7).verifying_key().as_bytes());
    set_with_deposit("alice.near", 1, &format!(r#"{{"name":"x","contribution":"1000000","size":2,"period_secs":60,"invite_key":"{key}"}}"#), CREATE_FEE);
    c.create_circle();
    assert!(c.circle_of(0).unwrap().invite_key.is_some());
    set_with_deposit("alice.near", 1, r#"{"name":"y","contribution":"1000000","size":2,"period_secs":60,"invite_key":null}"#, CREATE_FEE);
    c.create_circle();
    assert!(c.circle_of(1).unwrap().invite_key.is_none());
}

#[test]
#[should_panic(expected = "missing or invalid argument: invite_key")]
fn bad_invite_key_is_rejected() {
    let mut c = setup();
    set_with_deposit("alice.near", 1, r#"{"name":"x","contribution":"1000000","size":2,"period_secs":60,"invite_key":"xyz"}"#, CREATE_FEE);
    c.create_circle();
}

#[test]
fn encrypted_names_fit_and_oversized_ones_do_not() {
    let mut c = setup();
    set("someone.near", 0);
    let sealed = "A".repeat(MAX_NAME_LEN);
    assert_eq!(c.internal_create(&acc(ADA), sealed.clone(), U128(MIN_CONTRIBUTION), 3, DAY, false, None), Ok(0));
    assert!(c.internal_create(&acc(ADA), sealed + "A", U128(MIN_CONTRIBUTION), 3, DAY, false, None).is_err());
}

#[test]
fn an_invite_cannot_change_the_deposit() {
    // The invite key travels in the link, so anyone with the link can sign a
    // join for any deposit. Only one contribution is accepted.
    let mut c = setup();
    let key = invite_key(7);
    let public = hexs(key.verifying_key().as_bytes());
    organize(&mut c, ADA, &format!("create:{CONTRIBUTION}:2:{DAY}:join:{public}:sealed"), 1);
    for deposit in [1, 1_000_000, CONTRIBUTION + 1] {
        let signed = signed_invite(&key, 0, BAYO, deposit);
        assert_eq!(transfer(&mut c, BAYO, deposit, &format!("join:0:{signed}"), 2), deposit);
    }
    // A signature for one amount doesn't cover another.
    let signed = signed_invite(&key, 0, BAYO, 1_000_000);
    assert_eq!(transfer(&mut c, BAYO, CONTRIBUTION, &format!("join:0:{signed}"), 2), CONTRIBUTION);
    assert!(events().is_empty(), "a refused join logs no events");
    let signed = signed_invite(&key, 0, BAYO, CONTRIBUTION);
    assert_eq!(transfer(&mut c, BAYO, CONTRIBUTION, &format!("join:0:{signed}"), 2), 0);
    assert_eq!(c.circle_of(0).unwrap().members[0].deposit, U128(CONTRIBUTION));
}

/// A circle of three that a community treasury backs with 6 USDT.
fn backed_circle() -> Contri {
    let mut c = setup();
    let key = invite_key(7);
    let public = hexs(key.verifying_key().as_bytes());
    organize(&mut c, ADA, &format!("create:{CONTRIBUTION}:3:{DAY}:join:{public}:sealed"), 1);
    for who in [ADA, BAYO, CHIOMA] {
        let invite = signed_invite(&key, 0, who, CONTRIBUTION);
        assert_eq!(transfer(&mut c, who, CONTRIBUTION, &format!("join:0:{invite}"), 10), 0);
    }
    assert_eq!(transfer(&mut c, "coop.sputnik-dao.near", 6_000_000, "back:0", 11), 0);
    c
}

#[test]
fn community_backing_covers_what_a_deposit_cannot() {
    let mut c = backed_circle();
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.backing, U128(6_000_000));
    assert_eq!(circle.backers[0].account_id, acc("coop.sputnik-dao.near"));

    // Round 0: Chioma misses. Her deposit covers it.
    contribute(&mut c, ADA, 0, 0, 100);
    contribute(&mut c, BAYO, 0, 0, 100);
    set("anyone.near", 10 + DAY);
    c.internal_settle(0);
    let settled = event(&events(), "contri", "round_settled").clone();
    assert_eq!(settled["data"][0]["missed"], json!([CHIOMA]));
    assert_eq!(settled["data"][0]["from_backing"], "0");
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.pot, U128(3 * CONTRIBUTION));
    assert_eq!(circle.members[2].deposit, U128(0));
    set("contri.near", 10 + DAY + 1);
    c.finalize_payout(0, 0, U128(3 * CONTRIBUTION), true);

    // Round 1: Chioma misses again. Her deposit is gone; 5 USDT comes from the backing.
    // The round closed a second late, so its deadline is a full day after that.
    contribute(&mut c, ADA, 0, 1, 10 + DAY + 2);
    contribute(&mut c, BAYO, 0, 1, 10 + DAY + 2);
    set("anyone.near", 11 + 2 * DAY);
    c.internal_settle(0);
    let settled = event(&events(), "contri", "round_settled").clone();
    assert_eq!(settled["data"][0]["from_backing"], "5000000");
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.pot, U128(3 * CONTRIBUTION));
    assert_eq!(circle.backing, U128(1_000_000));
    set("contri.near", 12 + 2 * DAY);
    c.finalize_payout(0, 1, circle.pot, true);
    assert_eq!(c.circle_of(0).unwrap().payouts[1].shortfall, U128(0));

    // Round 2 is Chioma's own turn. Skipping her own share owes nobody, but the
    // 5 USDT the backing paid for her is held back from her pot and goes back
    // to the backing.
    contribute(&mut c, ADA, 0, 2, 13 + 2 * DAY);
    contribute(&mut c, BAYO, 0, 2, 13 + 2 * DAY);
    set("anyone.near", 12 + 3 * DAY);
    c.internal_settle(0);
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.pot, U128(CONTRIBUTION));
    assert_eq!(circle.backing, U128(6_000_000), "the backing is whole again");
    set("contri.near", 13 + 3 * DAY);
    c.finalize_payout(0, 2, circle.pot, true);
    assert_eq!(c.circle_of(0).unwrap().payouts[2].shortfall, U128(0));
    let paid = event(&events(), "contri", "paid_out").clone();
    assert_eq!(paid["data"][0]["withheld"], "5000000");
    assert_eq!(c.circle_of(0).unwrap().backers[0].due, U128(6_000_000));
}

#[test]
fn leftover_backing_goes_back_to_backers_in_proportion() {
    let mut c = backed_circle();
    assert_eq!(transfer(&mut c, "church.near", CONTRIBUTION, "back:0", 12), 0);
    assert_eq!(transfer(&mut c, "coop.sputnik-dao.near", CONTRIBUTION, "back:0", 12), 0);
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.backers.len(), 2);
    assert_eq!(circle.backers[0].amount, U128(11_000_000));
    assert_eq!(circle.backing, U128(16_000_000));

    // Everyone pays every round, so no backing is used.
    for round in 0..3u32 {
        let at = 100 + round as u64 * DAY;
        for who in [ADA, BAYO, CHIOMA] {
            contribute(&mut c, who, 0, round, at);
        }
        set("contri.near", at + 1);
        c.finalize_payout(0, round, U128(3 * CONTRIBUTION), true);
    }
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.status, CircleStatus::Finished);
    assert_eq!(circle.backing, U128(0));
    assert_eq!(circle.backers[0].due, U128(11_000_000));
    assert_eq!(circle.backers[1].due, U128(CONTRIBUTION));

    // Three deposits and two backers get their money back.
    set("anyone.near", 100 + 3 * DAY);
    assert_eq!(c.internal_release(0), 5);
    let circle = c.circle_of(0).unwrap();
    assert!(circle.backers.iter().all(|b| b.due == U128(0)));
    assert_eq!(get_created_receipts().len(), 10, "five transfers, each with its callback");
}

#[test]
fn backing_shares_round_down_and_the_rest_goes_to_the_first_backer() {
    let mut c = setup();
    create(&mut c, 2);
    let mut circle = c.circle_of(0).unwrap();
    circle.backers = vec![
        Backer { account_id: acc("a.near"), amount: U128(5_000_000), due: U128(0) },
        Backer { account_id: acc("b.near"), amount: U128(10_000_000), due: U128(0) },
    ];
    circle.backing = U128(7);
    close_backing(&mut circle);
    // 7 split 1:2 is 2.33 and 4.67: rounded down to 2 and 4, and the 1 left goes first.
    assert_eq!(circle.backers[0].due, U128(3));
    assert_eq!(circle.backers[1].due, U128(4));
    assert_eq!(circle.backing, U128(0));

    // Cancelling a circle gives every backer back exactly what they put in.
    organize(&mut c, ADA, &format!("create:{CONTRIBUTION}:2:{DAY}:join:-:second"), 6);
    for who in ["a.near", "b.near", "c.near"] {
        assert_eq!(transfer(&mut c, who, CONTRIBUTION + 1, "back:1", 7), 0);
    }
    auth(&mut c, ADA, "cancel:1", 8);
    let circle = c.circle_of(1).unwrap();
    let dues: Vec<u128> = circle.backers.iter().map(|b| b.due.0).collect();
    assert_eq!(dues.iter().sum::<u128>(), 3 * (CONTRIBUTION + 1));
    assert_eq!(dues, vec![CONTRIBUTION + 1; 3]);
}

#[test]
fn backing_rules() {
    let mut c = setup();
    create(&mut c, 2);
    // Less than one contribution is refunded.
    assert_eq!(transfer(&mut c, "coop.near", CONTRIBUTION - 1, "back:0", 2), CONTRIBUTION - 1);
    // At most MAX_BACKERS different backers.
    for i in 0..MAX_BACKERS {
        assert_eq!(transfer(&mut c, &format!("backer{i}.near"), CONTRIBUTION, "back:0", 2), 0);
    }
    assert_eq!(transfer(&mut c, "late.near", CONTRIBUTION, "back:0", 2), CONTRIBUTION);
    // An existing backer can add more.
    assert_eq!(transfer(&mut c, "backer0.near", CONTRIBUTION, "back:0", 2), 0);
    // A finished or cancelled circle takes no backing.
    auth(&mut c, ADA, "cancel:0", 3);
    assert_eq!(transfer(&mut c, "backer0.near", CONTRIBUTION, "back:0", 4), CONTRIBUTION);
}

#[test]
fn members_can_refill_their_deposit() {
    let mut c = full_circle_of_three();
    contribute(&mut c, ADA, 0, 0, 100);
    contribute(&mut c, BAYO, 0, 0, 100);
    set("anyone.near", 10 + DAY);
    c.internal_settle(0);
    assert_eq!(c.circle_of(0).unwrap().members[2].deposit, U128(0));

    // Chioma refills in steps, up to every round but her own (2 contributions
    // in a circle of 3); going over that is refunded.
    assert_eq!(transfer(&mut c, CHIOMA, 2_000_000, "refill:0", 10 + DAY + 5), 0);
    assert_eq!(transfer(&mut c, CHIOMA, 2 * CONTRIBUTION, "refill:0", 10 + DAY + 5), 2 * CONTRIBUTION);
    assert_eq!(transfer(&mut c, CHIOMA, 8_000_000, "refill:0", 10 + DAY + 5), 0);
    assert_eq!(c.circle_of(0).unwrap().members[2].deposit, U128(2 * CONTRIBUTION));
    // Only members refill.
    assert_eq!(transfer(&mut c, "stranger.near", 1, "refill:0", 10 + DAY + 5), 1);
}

#[test]
fn new_messages_parse_strictly() {
    assert!(matches!(parse_transfer("back:4"), Some(TransferMsg::Back { circle: 4 })));
    assert!(matches!(parse_transfer("refill:4"), Some(TransferMsg::Refill { circle: 4 })));
    assert!(parse_transfer("back:4:1").is_none());
    assert!(parse_transfer("refill").is_none());
}

/// Delivers a join as NEAR Intents would, in a block with the given random seed.
fn join_in_block(c: &mut Contri, who: &str, circle: u64, seed: [u8; 32]) -> u128 {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("contri.near"))
        .predecessor_account_id(acc(INTENTS))
        .block_timestamp(10 * 1_000_000_000)
        .random_seed(seed)
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
    c.internal_on_transfer(acc(who), vec![TOKEN.to_string()], vec![U128(CONTRIBUTION)], format!("join:{circle}"))[0]
}

#[test]
fn random_order_draws_turns_when_the_circle_fills() {
    let joined = [ADA, BAYO, CHIOMA, "0xd000000000000000000000000000000000000004"];
    let mut orders = std::collections::BTreeSet::new();
    for seed in 1..=12u8 {
        let mut c = setup();
        organize(&mut c, ADA, &format!("create:{CONTRIBUTION}:4:{DAY}:random:-:draw"), 1);
        for who in joined {
            assert_eq!(join_in_block(&mut c, who, 0, [seed; 32]), 0);
        }
        let circle = c.circle_of(0).unwrap();
        assert_eq!(circle.status, CircleStatus::Active);
        let order: Vec<String> = circle.members.iter().map(|m| m.account_id.to_string()).collect();
        let mut sorted = order.clone();
        sorted.sort();
        let mut expected: Vec<String> = joined.iter().map(|s| s.to_string()).collect();
        expected.sort();
        assert_eq!(sorted, expected, "the draw is a reordering of the members");

        // The start event and the seat tokens follow the drawn order.
        let all = events();
        assert!(event(&all, "contri", "circle_started")["data"][0]["first_deadline"].is_string());
        let mint = &event(&all, "nep171", "nft_mint")["data"];
        for (seat, who) in order.iter().enumerate() {
            assert_eq!(mint[seat]["owner_id"], who.as_str());
            assert_eq!(mint[seat]["token_ids"][0], format!("0:{seat}"));
        }
        orders.insert(order);
    }
    assert!(orders.len() > 3, "different seeds give different orders: {orders:?}");
}

#[test]
fn join_order_is_kept_when_not_random() {
    let mut c = setup();
    create(&mut c, 3);
    for who in [ADA, BAYO, CHIOMA] {
        join_in_block(&mut c, who, 0, [9; 32]);
    }
    let order: Vec<_> = c.circle_of(0).unwrap().members.iter().map(|m| m.account_id.clone()).collect();
    assert_eq!(order, vec![acc(ADA), acc(BAYO), acc(CHIOMA)]);
}

#[test]
fn members_can_leave_before_the_start() {
    let mut c = setup();
    create(&mut c, 3);
    join(&mut c, ADA, 0);
    join(&mut c, BAYO, 0);
    auth(&mut c, BAYO, "leave:0", 20);
    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, acc(INTENTS), "the deposit goes back");
    assert_eq!(event(&events(), "contri", "left")["data"][0]["member"], BAYO);
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.members.len(), 1);

    // The seat is free again, and the circle still fills.
    join(&mut c, CHIOMA, 0);
    join(&mut c, BAYO, 0);
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.status, CircleStatus::Active);
    assert_eq!(circle.members[2].account_id, acc(BAYO));

    // Direct call by a NEAR account.
    organize(&mut c, ADA, &format!("create:{CONTRIBUTION}:2:{DAY}:join:-:second"), 30);
    transfer(&mut c, "alice.near", CONTRIBUTION, "join:1", 31);
    set_with_input("alice.near", 32, r#"{"circle_id":1}"#);
    c.leave_circle();
    assert!(c.circle_of(1).unwrap().members.is_empty());
}

#[test]
#[should_panic(expected = "this circle has already started")]
fn nobody_leaves_a_running_circle() {
    let mut c = full_circle_of_three();
    auth(&mut c, BAYO, "leave:0", 20);
}

#[test]
fn anyone_can_cancel_a_circle_that_never_filled_then_close_it() {
    let mut c = setup();
    create(&mut c, 3);
    join(&mut c, BAYO, 0);
    let fill_by = c.circle_of(0).unwrap().fill_by;
    assert_eq!(fill_by, FILL_SECS * 1_000_000_000);
    assert_eq!(view(&c, r#"{"circle_id":0}"#, Contri::get_circle)["fill_by"], fill_by.to_string());

    // A stranger can't cancel before the fill deadline...
    set_with_input("stranger.near", FILL_SECS - 1, r#"{"circle_id":0}"#);
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.cancel_circle()));
    assert!(early.is_err());

    // ...but can after it, so Bayo's deposit doesn't stay stuck.
    set_with_input("stranger.near", FILL_SECS, r#"{"circle_id":0}"#);
    c.cancel_circle();
    assert_eq!(c.circle_of(0).unwrap().status, CircleStatus::Cancelled);

    // Closing waits until the money has gone back.
    set_with_input("stranger.near", FILL_SECS + 1, r#"{"circle_id":0}"#);
    let too_soon = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.close_circle()));
    assert!(too_soon.is_err());
    set_with_input("stranger.near", FILL_SECS + 2, r#"{"circle_id":0}"#);
    c.release_deposits();
    assert_eq!(returned(), json!(1));
    set_with_input("stranger.near", FILL_SECS + 3, r#"{"circle_id":0}"#);
    c.close_circle();
    assert!(c.circle_of(0).is_none(), "storage freed");
    assert_eq!(event(&events(), "contri", "circle_closed")["data"][0]["circle"], 0);
    assert_eq!(view(&c, r#"{"circle_id":0}"#, Contri::get_circle), Value::Null);
}

#[test]
#[should_panic(expected = "seats can only be traded while the circle is running")]
fn seats_are_not_listed_before_the_draw() {
    let mut c = setup();
    create(&mut c, 3);
    join(&mut c, ADA, 0);
    auth(&mut c, ADA, "list_seat:0:0:1000000", 20);
}

#[test]
fn direct_create_takes_an_order() {
    let mut c = setup();
    set_with_deposit("alice.near", 1, r#"{"name":"x","contribution":"1000000","size":2,"period_secs":60,"order":"random"}"#, CREATE_FEE);
    c.create_circle();
    assert!(c.circle_of(0).unwrap().random_order);
    set_with_deposit("alice.near", 1, r#"{"name":"x","contribution":"1000000","size":2,"period_secs":60}"#, CREATE_FEE);
    c.create_circle();
    assert!(!c.circle_of(1).unwrap().random_order);
}

#[test]
#[should_panic(expected = "missing or invalid argument: order")]
fn bad_order_is_rejected() {
    let mut c = setup();
    set_with_deposit("alice.near", 1, r#"{"name":"x","contribution":"1000000","size":2,"period_secs":60,"order":"vip"}"#, CREATE_FEE);
    c.create_circle();
}

#[test]
fn seat_image_follows_the_circle() {
    let mut c = full_circle_of_three();
    let media = |c: &Contri, token: &str| {
        view(c, &format!(r#"{{"token_id":"{token}"}}"#), Contri::nft_token)["metadata"]["media"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert!(media(&c, "0:0").contains("Pays this round"));
    assert!(media(&c, "0:0").contains("stroke-dasharray='0 490'"));
    auth(&mut c, CHIOMA, "list_seat:0:2:700000", 50);
    assert!(media(&c, "0:2").contains("For sale"));
    for who in [ADA, BAYO, CHIOMA] {
        contribute(&mut c, who, 0, 0, 100);
    }
    set("contri.near", 101);
    c.finalize_payout(0, 0, U128(3 * CONTRIBUTION), true);
    assert!(media(&c, "0:0").contains("Paid out"));
    assert!(media(&c, "0:0").contains("stroke-dasharray='163 490'"));
    assert!(media(&c, "0:1").contains("Pays this round"));
}

#[test]
fn creating_through_intents_costs_the_organizers_deposit() {
    let mut c = setup();
    let msg = format!("create:{CONTRIBUTION}:3:{DAY}:join:-:Coop");
    // Without a full deposit, nothing is created and the money comes back.
    assert_eq!(transfer(&mut c, ADA, CONTRIBUTION - 1, &msg, 1), CONTRIBUTION - 1);
    assert!(c.circle_of(0).is_none());
    // With it, the organizer creates the circle and takes the first seat.
    assert_eq!(transfer(&mut c, ADA, CONTRIBUTION, &msg, 2), 0);
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.organizer, acc(ADA));
    assert_eq!(circle.members.len(), 1);
    assert_eq!(circle.members[0].account_id, acc(ADA));
    assert_eq!(circle.members[0].deposit, U128(CONTRIBUTION));
    let all = events();
    assert_eq!(event(&all, "contri", "joined")["data"][0]["seat"], 0);
    event(&all, "contri", "circle_created");
    // The organizer can't join twice, and the circle fills with two more.
    assert_eq!(join(&mut c, ADA, 0), CONTRIBUTION);
    join(&mut c, BAYO, 0);
    join(&mut c, CHIOMA, 0);
    assert_eq!(c.circle_of(0).unwrap().status, CircleStatus::Active);
}

#[test]
#[should_panic(expected = "unreadable message")]
fn creating_is_not_a_free_authcall_anymore() {
    let mut c = setup();
    auth(&mut c, ADA, &format!("create:{CONTRIBUTION}:3:{DAY}:join:-:spam"), 1);
}

#[test]
#[should_panic(expected = "attach 0.01 NEAR to pay for the circle's storage")]
fn direct_create_needs_the_storage_fee() {
    let mut c = setup();
    set_with_input("alice.near", 1, r#"{"name":"x","contribution":"1000000","size":2,"period_secs":60}"#);
    c.create_circle();
}

#[test]
fn the_organizer_needs_no_invite_but_pays_one_contribution() {
    let mut c = setup();
    let public = hexs(invite_key(7).verifying_key().as_bytes());
    organize(&mut c, ADA, &format!("create:{CONTRIBUTION}:3:{DAY}:join:{public}:sealed"), 1);
    assert_eq!(transfer(&mut c, ADA, 2 * CONTRIBUTION, "join:0", 2), 2 * CONTRIBUTION);
    assert_eq!(transfer(&mut c, ADA, CONTRIBUTION, "join:0", 2), 0);
    // Through Intents, creating an invite-only circle seats the organizer the same way.
    assert_eq!(transfer(&mut c, BAYO, CONTRIBUTION, &format!("create:{CONTRIBUTION}:3:{DAY}:join:{public}:mine"), 3), 0);
    assert_eq!(c.circle_of(1).unwrap().members[0].account_id, acc(BAYO));
}

// ----------------------------------------------------------------------
// Fixes from the security review (docs/SECURITY.md)
// ----------------------------------------------------------------------

/// An implicit account: 64 characters, the longest an account can be.
fn implicit(i: u32) -> String {
    format!("{:064x}", 0xabcd_0000_u64 + i as u64)
}

/// Storage bytes a call adds, measured inside one mocked receipt.
fn grown<T>(f: impl FnOnce() -> T) -> (T, u64) {
    let before = env::storage_usage();
    let out = f();
    (out, env::storage_usage().saturating_sub(before))
}

/// A transfer from NEAR Intents while the contract holds `balance` and already
/// stores `usage` bytes.
fn transfer_holding(c: &mut Contri, from: &str, amount: u128, msg: &str, usage: u64, balance: u128) -> u128 {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("contri.near"))
        .predecessor_account_id(acc(INTENTS))
        .prepaid_gas(Gas::from_tgas(300))
        .storage_usage(usage)
        .account_balance(NearToken::from_yoctonear(balance));
    testing_env!(b.build());
    c.internal_on_transfer(acc(from), vec![TOKEN.to_string()], vec![U128(amount)], msg.to_string())[0]
}

const BYTE: u128 = 10_000_000_000_000_000_000; // yoctoNEAR per byte

#[test]
fn contributions_below_one_usdt_are_refused() {
    let mut c = setup();
    let small = MIN_CONTRIBUTION - 1;
    assert_eq!(transfer(&mut c, ADA, small, &format!("create:{small}:2:60:join:-:x"), 1), small);
    assert!(c.circle_of(0).is_none());
}

#[test]
fn nothing_grows_storage_the_contract_cannot_pay_for() {
    let mut c = setup();
    let usage = 100_000;
    // Room for the spare bytes and a little more, but not a circle.
    let tight = (usage + SPARE_BYTES + 300) as u128 * BYTE;
    let msg = format!("create:{CONTRIBUTION}:3:{DAY}:join:-:Lagos Ajo");
    assert_eq!(transfer_holding(&mut c, ADA, CONTRIBUTION, &msg, usage, tight), CONTRIBUTION, "refunded");
    assert!(c.circle_of(0).is_none(), "no circle was left behind");
    assert_eq!(c.next_circle_id, 0);
    // With enough NEAR the same create goes through and reserves the
    // organizer's payout record and track record.
    let roomy = (usage + SPARE_BYTES + 2_000) as u128 * BYTE;
    assert_eq!(transfer_holding(&mut c, ADA, CONTRIBUTION, &msg, usage, roomy), 0);
    assert_eq!(reserved(), MEMBER_RESERVE + CREDIT_BYTES);
    // A join is refused once the reservations fill what the NEAR covers.
    let joining = MEMBER_BYTES + MEMBER_RESERVE + CREDIT_BYTES;
    let full = (usage + SPARE_BYTES + MEMBER_RESERVE + CREDIT_BYTES + joining - 1) as u128 * BYTE;
    assert_eq!(transfer_holding(&mut c, BAYO, CONTRIBUTION, "join:0", usage, full), CONTRIBUTION);
    assert_eq!(c.circle_of(0).unwrap().members.len(), 1);
    assert_eq!(transfer_holding(&mut c, BAYO, CONTRIBUTION, "join:0", usage, full + BYTE), 0);
    assert_eq!(reserved(), 2 * (MEMBER_RESERVE + CREDIT_BYTES));
}

#[test]
fn payout_callbacks_only_use_storage_that_was_reserved() {
    // The largest circle: 20 members with 64-character accounts and an
    // encrypted name. What on_payout writes, round after round, must fit in
    // what the members reserved when they joined, so it can never run out of
    // room after the pot has been sent.
    let mut c = setup();
    let name = format!("v1.{}", "x".repeat(171));
    let msg = format!("create:{CONTRIBUTION}:20:{DAY}:join:-:{name}");
    assert_eq!(transfer(&mut c, &implicit(0), CONTRIBUTION, &msg, 0), 0);
    for i in 1..20 {
        assert_eq!(transfer(&mut c, &implicit(i), CONTRIBUTION, "join:0", 1), 0);
    }
    let held = reserved();
    assert_eq!(held, 20 * (MEMBER_RESERVE + CREDIT_BYTES));
    let mut written = 0;
    for round in 0..20u32 {
        let at = 2 + round as u64 * DAY;
        for i in 0..20 {
            contribute(&mut c, &implicit(i), 0, round, at);
        }
        set("contri.near", at + 1);
        let (ok, g) = grown(|| c.finalize_payout(0, round, U128(20 * CONTRIBUTION), true));
        assert!(ok);
        written += g;
        assert!(written <= held - reserved(), "round {round}: callbacks wrote {written} B, more than they released");
    }
    assert_eq!(c.circle_of(0).unwrap().status, CircleStatus::Finished);
    assert_eq!(reserved(), 20 * CREDIT_BYTES, "only the slots for the deposits still to send");
}

#[test]
fn failed_transfers_out_only_write_credits_into_reserved_slots() {
    // The worst case: NEAR Intents refuses every transfer of a 20-member
    // circle's release, and every member's account is 64 characters. Each
    // failure writes a credit from a callback that can't refuse; each must
    // land in a slot reserved when the member joined.
    let mut c = setup();
    let msg = format!("create:{CONTRIBUTION}:20:{DAY}:join:-:x");
    assert_eq!(transfer(&mut c, &implicit(0), CONTRIBUTION, &msg, 0), 0);
    for i in 1..20 {
        assert_eq!(transfer(&mut c, &implicit(i), CONTRIBUTION, "join:0", 1), 0);
    }
    // Every round paid by everyone, so every deposit is still there to return.
    for round in 0..20u32 {
        let at = 2 + round as u64 * DAY;
        for i in 0..20 {
            contribute(&mut c, &implicit(i), 0, round, at);
        }
        set("contri.near", at + 1);
        assert!(c.finalize_payout(0, round, U128(20 * CONTRIBUTION), true));
    }
    let held = reserved();
    assert_eq!(held, 20 * CREDIT_BYTES);
    let mut sends = vec![];
    while sends.len() < 20 {
        set("anyone.near", 30 * DAY);
        let sent = c.internal_release(0);
        assert!(sent > 0, "release makes progress");
        for r in get_created_receipts().iter().filter(|r| r.receiver_id == acc("contri.near")) {
            let near_sdk::mock::MockAction::FunctionCallWeight { args, .. } = &r.actions[0] else { panic!() };
            sends.push(String::from_utf8(args.clone()).unwrap());
        }
    }
    assert_eq!(reserved(), held, "slots stay held while the transfers are in flight");
    let mut written = 0;
    for args in &sends {
        assert!(args.contains(r#""slot":true"#));
        set_callback(args, PromiseResult::Failed);
        let (_, g) = grown(|| c.on_sent());
        written += g;
    }
    assert_eq!(c.credit_of(&acc(&implicit(7))), U128(CONTRIBUTION));
    assert!(written <= held, "credits wrote {written} B, more than the {held} B reserved");
    assert_eq!(reserved(), 0, "every slot is freed once its transfer resolves");
}

#[test]
fn listing_a_seat_holds_a_slot_for_paying_the_seller() {
    let mut c = full_circle_of_three();
    let base = reserved();
    auth(&mut c, BAYO, "list_seat:0:1:2000000", 20);
    assert_eq!(reserved(), base + CREDIT_BYTES);
    // A new price keeps the same slot.
    auth(&mut c, BAYO, "list_seat:0:1:3000000", 21);
    assert_eq!(reserved(), base + CREDIT_BYTES);
    auth(&mut c, BAYO, "unlist_seat:0:1", 22);
    assert_eq!(reserved(), base);
    // Sold: the slot goes with the payment, and the buyer's own listing ends.
    auth(&mut c, BAYO, "list_seat:0:1:2000000", 23);
    auth(&mut c, CHIOMA, "list_seat:0:2:9000000", 24);
    assert_eq!(reserved(), base + 2 * CREDIT_BYTES);
    assert_eq!(transfer(&mut c, CHIOMA, 2_000_000, "buy_seat:0:1", 25), 0);
    assert_eq!(reserved(), base + CREDIT_BYTES, "the buyer's listing slot is freed");
    let args = format!(r#"{{"to":"{BAYO}","amount":"2000000","slot":true}}"#);
    set_callback(&args, PromiseResult::Successful(vec![]));
    c.on_sent();
    assert_eq!(reserved(), base);
}

#[test]
fn a_listing_still_up_when_its_turn_is_paid_frees_its_slot() {
    let mut c = full_circle_of_three();
    let base = reserved();
    auth(&mut c, ADA, "list_seat:0:0:2000000", 20);
    for who in [ADA, BAYO, CHIOMA] {
        contribute(&mut c, who, 0, 0, 100);
    }
    set("contri.near", 101);
    assert!(c.finalize_payout(0, 0, U128(3 * CONTRIBUTION), true));
    assert_eq!(reserved(), base - PAYOUT_BYTES);
}

#[test]
fn claiming_a_credit_holds_a_slot_in_case_it_fails_again() {
    let mut c = setup();
    set("contri.near", 0);
    c.add_credit(acc(ADA), 700);
    auth(&mut c, ADA, "claim_credit", 600);
    assert_eq!(reserved(), CREDIT_BYTES);
    let args = format!(r#"{{"to":"{ADA}","amount":"700","slot":true}}"#);
    set_callback(&args, PromiseResult::Failed);
    c.on_sent();
    assert_eq!(c.credit_of(&acc(ADA)), U128(700));
    assert_eq!(reserved(), 0);
}

#[test]
fn members_whose_deposit_was_used_up_free_their_slot_at_the_end() {
    let mut c = full_circle_of_three();
    // Bayo never pays: his one-contribution deposit covers round 0 only.
    for round in 0..3u32 {
        let at = 10 + round as u64 * DAY;
        contribute(&mut c, ADA, 0, round, at + 100);
        contribute(&mut c, CHIOMA, 0, round, at + 100);
        set("anyone.near", c.circle_of(0).unwrap().round_deadline() / 1_000_000_000);
        c.internal_settle(0);
        set("contri.near", c.circle_of(0).unwrap().round_deadline() / 1_000_000_000 + 1);
        let pot = c.circle_of(0).unwrap().pot;
        if pot.0 > 0 {
            assert!(c.finalize_payout(0, round, pot, true));
        }
    }
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.status, CircleStatus::Finished);
    assert_eq!(circle.members.iter().filter(|m| m.deposit.0 > 0).count(), 2);
    assert_eq!(reserved(), 2 * CREDIT_BYTES, "Bayo has nothing coming, so no slot");
}

#[test]
fn circles_from_before_slots_hold_none() {
    let mut c = setup();
    set("contri.near", 0);
    store(FIRST_SLOTTED_KEY, &1u64);
    create(&mut c, 3);
    join(&mut c, ADA, 0);
    assert_eq!(reserved(), MEMBER_RESERVE);
    auth(&mut c, ADA, "leave:0", 20);
    let r = get_created_receipts();
    let near_sdk::mock::MockAction::FunctionCallWeight { args, .. } = &r[1].actions[0] else { panic!() };
    assert!(String::from_utf8(args.clone()).unwrap().contains(r#""slot":false"#));
    assert_eq!(reserved(), 0);
}

#[test]
fn leaving_and_cancelling_release_reservations() {
    let mut c = setup();
    create(&mut c, 3);
    join(&mut c, ADA, 0);
    join(&mut c, BAYO, 0);
    let member = MEMBER_RESERVE + CREDIT_BYTES;
    assert_eq!(reserved(), 2 * member);
    // Bayo's slot stays held until his deposit's transfer resolves.
    auth(&mut c, BAYO, "leave:0", 20);
    assert_eq!(reserved(), member + CREDIT_BYTES);
    let args = format!(r#"{{"to":"{BAYO}","amount":"{CONTRIBUTION}","slot":true}}"#);
    set_callback(&args, PromiseResult::Successful(vec![]));
    c.on_sent();
    assert_eq!(reserved(), member);
    auth(&mut c, ADA, "cancel:0", 21);
    assert_eq!(reserved(), CREDIT_BYTES, "Ada's deposit is still to send");
    set("anyone.near", 22);
    assert_eq!(c.internal_release(0), 1);
    let args = format!(r#"{{"to":"{ADA}","amount":"{CONTRIBUTION}","slot":true}}"#);
    set_callback(&args, PromiseResult::Successful(vec![]));
    c.on_sent();
    assert_eq!(reserved(), 0);
}

#[test]
fn an_empty_pot_closes_the_round_without_a_transfer() {
    let mut c = setup();
    let m = MIN_CONTRIBUTION;
    assert_eq!(transfer(&mut c, ADA, m, &format!("create:{m}:3:60:join:-:x"), 0), 0);
    assert_eq!(transfer(&mut c, BAYO, m, "join:0", 0), 0);
    assert_eq!(transfer(&mut c, CHIOMA, m, "join:0", 0), 0);
    // Nobody ever pays. Round 0: Bayo's and Chioma's deposits cover them.
    set("anyone.near", 60);
    c.internal_settle(0);
    set("contri.near", 61);
    assert!(c.finalize_payout(0, 0, U128(2 * m), true));
    // Round 1: Ada's deposit covers her; Chioma's is gone, so the pot is short.
    set("anyone.near", 121);
    c.internal_settle(0);
    set("contri.near", 122);
    assert!(c.finalize_payout(0, 1, U128(m), true));
    // Round 2: nothing is left to cover Ada or Bayo. The round closes with its
    // pot short, and no zero transfer is attempted.
    set("anyone.near", 182);
    c.internal_settle(0);
    assert!(get_created_receipts().is_empty(), "no transfer of nothing");
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.status, CircleStatus::Finished);
    assert!(!circle.paying);
    assert_eq!(circle.payouts[2].amount, U128(0));
    assert_eq!(circle.payouts[2].shortfall, U128(2 * m), "Chioma's own share isn't counted");
    assert_eq!(c.record_of(&acc(BAYO)).defaults, 1);
}

#[test]
fn backing_is_refused_once_some_has_covered_a_missed_payment() {
    let mut c = full_circle_of_three();
    assert_eq!(transfer(&mut c, "coop.near", 10_000_000, "back:0", 11), 0);
    // While none is used, more backing is welcome, while the circle runs too.
    assert_eq!(transfer(&mut c, "church.near", CONTRIBUTION, "back:0", 12), 0);
    // Rounds 0 and 1: Chioma misses; her deposit, then the backing, covers it.
    for round in 0..2u32 {
        let at = 10 + round as u64 * DAY;
        contribute(&mut c, ADA, 0, round, at + 100);
        contribute(&mut c, BAYO, 0, round, at + 100);
        set("anyone.near", c.circle_of(0).unwrap().round_deadline() / 1_000_000_000);
        c.internal_settle(0);
        set("contri.near", c.circle_of(0).unwrap().round_deadline() / 1_000_000_000 + 1);
        assert!(c.finalize_payout(0, round, U128(3 * CONTRIBUTION), true));
    }
    assert_eq!(c.circle_of(0).unwrap().backing, U128(10_000_000), "5 of 15 used");
    // A late backer would pay for that loss, so new backing is refused.
    let now = c.circle_of(0).unwrap().payouts[1].at / 1_000_000_000 + 1;
    assert_eq!(transfer(&mut c, "dao.near", 100_000_000, "back:0", now), 100_000_000);
    assert_eq!(transfer(&mut c, "coop.near", CONTRIBUTION, "back:0", now), CONTRIBUTION);
}

#[test]
fn a_round_closed_late_still_gets_a_full_period() {
    let mut c = full_circle_of_three();
    contribute(&mut c, ADA, 0, 0, 100);
    contribute(&mut c, BAYO, 0, 0, 100);
    // Round 0's deadline is 10 + DAY. Nobody settles it until a day later.
    let late = 10 + 2 * DAY + 5;
    set("anyone.near", late);
    c.internal_settle(0);
    set("contri.near", late + 1);
    assert!(c.finalize_payout(0, 0, U128(3 * CONTRIBUTION), true));
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.round_deadline(), (late + 1 + DAY) * 1_000_000_000);
    // Round 1 can't be settled before members have had their day to pay.
    set("griefer.near", late + 2);
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.internal_settle(0)));
    assert!(early.is_err());
    // On schedule, rounds keep their original deadlines.
    let mut c = full_circle_of_three();
    for who in [ADA, BAYO, CHIOMA] {
        contribute(&mut c, who, 0, 0, 100);
    }
    set("contri.near", 101);
    assert!(c.finalize_payout(0, 0, U128(3 * CONTRIBUTION), true));
    assert_eq!(c.circle_of(0).unwrap().round_deadline(), (10 + 2 * DAY) * 1_000_000_000);
}

/// The money a circle holds, by its own books: pot, deposits, backing not yet
/// used, backers' shares and what was held back from members who owed.
fn held(c: &Contri, id: u64) -> u128 {
    let x = c.circle_of(id).unwrap();
    x.pot.0 + x.members.iter().map(|m| m.deposit.0).sum::<u128>() + x.backing.0 + x.backers.iter().map(|b| b.due.0).sum::<u128>() + x.recovered.0
}

#[test]
fn a_member_who_never_pays_has_what_they_owe_held_back_from_their_own_turn() {
    // Chioma (seat 2) never pays. Her deposit covers round 0; round 1 is short
    // and she owes it; round 2 is her own turn. She gets the pot less what she
    // owes, and that goes to Bayo, whose pot was short, when the circle ends.
    let mut c = full_circle_of_three();
    let one = CONTRIBUTION;
    contribute(&mut c, ADA, 0, 0, 100);
    contribute(&mut c, BAYO, 0, 0, 100);
    set("anyone.near", 10 + DAY + 1);
    c.internal_settle(0);
    assert!(c.finalize_payout(0, 0, U128(3 * one), true));
    contribute(&mut c, ADA, 0, 1, 10 + DAY + 100);
    contribute(&mut c, BAYO, 0, 1, 10 + DAY + 100);
    set("anyone.near", c.circle_of(0).unwrap().round_deadline() / 1_000_000_000);
    c.internal_settle(0);
    assert_eq!(c.circle_of(0).unwrap().members[2].owed, U128(one));
    assert!(c.finalize_payout(0, 1, U128(2 * one), true));
    assert_eq!(c.circle_of(0).unwrap().payouts[1].shortfall, U128(one));
    contribute(&mut c, ADA, 0, 2, 10 + 2 * DAY + 100);
    contribute(&mut c, BAYO, 0, 2, 10 + 2 * DAY + 100);
    set("anyone.near", c.circle_of(0).unwrap().round_deadline() / 1_000_000_000);
    c.internal_settle(0);
    let paying = c.circle_of(0).unwrap();
    assert_eq!(paying.pot, U128(one), "2 paid in, 1 held back");
    assert_eq!(paying.recovered, U128(one));
    assert_eq!(paying.members[2].owed, U128(0));
    assert_eq!(paying.members[2].deposit, U128(0), "her own turn doesn't take a deposit");
    assert!(c.finalize_payout(0, 2, U128(one), true));
    let done = c.circle_of(0).unwrap();
    assert_eq!(done.status, CircleStatus::Finished);
    assert_eq!(done.payouts[2].amount, U128(one));
    assert_eq!(done.payouts[2].shortfall, U128(0));
    assert_eq!(done.recovered, U128(0));
    // Everyone ends even: Ada's deposit back; Bayo's deposit plus the 1 his pot
    // was short; Chioma paid 1 (her deposit) and received 1.
    assert_eq!(done.members[0].deposit, U128(one));
    assert_eq!(done.members[1].deposit, U128(2 * one));
    assert_eq!(done.members[2].deposit, U128(0));
    assert_eq!(held(&c, 0), 3 * one);
    let event = events().into_iter().filter(|e| e["event"] == "paid_out").last().unwrap();
    assert_eq!(event["data"][0]["withheld"], json!(one.to_string()));
}

#[test]
fn backing_that_covered_a_member_is_repaid_from_their_turn_first() {
    let mut c = full_circle_of_three();
    let one = CONTRIBUTION;
    assert_eq!(transfer(&mut c, "dao.near", one, "back:0", 20), 0);
    // Chioma misses rounds 0 and 1: her deposit, then the backing, cover them.
    for round in 0..2u32 {
        let at = 10 + round as u64 * DAY;
        contribute(&mut c, ADA, 0, round, at + 100);
        contribute(&mut c, BAYO, 0, round, at + 100);
        set("anyone.near", c.circle_of(0).unwrap().round_deadline() / 1_000_000_000);
        c.internal_settle(0);
        assert!(c.finalize_payout(0, round, U128(3 * one), true));
    }
    let mid = c.circle_of(0).unwrap();
    assert_eq!(mid.backing, U128(0));
    assert_eq!((mid.members[2].owed, mid.members[2].backed), (U128(one), U128(one)));
    // Her turn: what she owes goes back to the backing, not to her.
    contribute(&mut c, ADA, 0, 2, 10 + 2 * DAY + 100);
    contribute(&mut c, BAYO, 0, 2, 10 + 2 * DAY + 100);
    contribute(&mut c, CHIOMA, 0, 2, 10 + 2 * DAY + 100);
    let paying = c.circle_of(0).unwrap();
    assert_eq!(paying.pot, U128(2 * one));
    assert_eq!(paying.backing, U128(one));
    assert!(c.finalize_payout(0, 2, U128(2 * one), true));
    let done = c.circle_of(0).unwrap();
    assert_eq!(done.backers[0].due, U128(one), "the backer gets all of it back");
    assert_eq!(held(&c, 0), 3 * one);
}

#[test]
fn the_member_whose_turn_it_is_owes_nobody_for_skipping_it() {
    let mut c = full_circle_of_three();
    contribute(&mut c, BAYO, 0, 0, 100);
    contribute(&mut c, CHIOMA, 0, 0, 100);
    set("anyone.near", 10 + DAY + 1);
    c.internal_settle(0);
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.pot, U128(2 * CONTRIBUTION));
    assert_eq!(circle.members[0].deposit, U128(CONTRIBUTION), "Ada's deposit stays for later rounds");
    assert!(!circle.members[0].defaulted);
    assert_eq!(circle.members[0].owed, U128(0));
    assert!(c.finalize_payout(0, 0, U128(2 * CONTRIBUTION), true));
    assert_eq!(c.circle_of(0).unwrap().payouts[0].shortfall, U128(0));
}

#[test]
fn an_organizer_who_leaves_their_empty_circle_cancels_it() {
    let mut c = setup();
    let m = MIN_CONTRIBUTION;
    assert_eq!(transfer(&mut c, ADA, m, &format!("create:{m}:20:60:join:-:spam"), 0), 0);
    auth(&mut c, ADA, "leave:0", 5);
    assert_eq!(c.circle_of(0).unwrap().status, CircleStatus::Cancelled);
    set("anyone.near", 6);
    c.internal_close(0);
    assert!(c.circle_of(0).is_none(), "its storage is freed at once");
    // A circle organized by an account that took no seat isn't cancelled by
    // someone joining and leaving it.
    organize(&mut c, "dao.near", &format!("create:{m}:3:60:join:-:coop"), 10);
    assert_eq!(transfer(&mut c, BAYO, m, "join:1", 11), 0);
    auth(&mut c, BAYO, "leave:1", 12);
    assert_eq!(c.circle_of(1).unwrap().status, CircleStatus::Open);
}

fn pay_ahead(c: &mut Contri, who: &str, circle: u64, rounds: u32, secs: u64) -> u128 {
    transfer(c, who, CONTRIBUTION * rounds as u128, &format!("ahead:{circle}:{rounds}"), secs)
}

#[test]
fn rounds_paid_ahead_pay_each_new_round_by_themselves() {
    let mut c = full_circle_of_three();
    // Ada pays all three rounds at once: this one now, two ahead.
    assert_eq!(pay_ahead(&mut c, ADA, 0, 3, 100), 0);
    let circle = c.circle_of(0).unwrap();
    assert!(circle.members[0].paid_this_round);
    assert_eq!(circle.members[0].ahead, 2);
    assert_eq!(circle.pot, U128(CONTRIBUTION));
    let all = events();
    assert_eq!(event(&all, "contri", "paid_ahead")["data"][0]["rounds"], 2);

    for round in 0..3u32 {
        let secs = 100 + round as u64 * DAY;
        if round > 0 {
            // Ada's round is already paid; she does nothing.
            let circle = c.circle_of(0).unwrap();
            assert!(circle.members[0].paid_this_round, "round {round}");
            assert_eq!(circle.members[0].ahead, 2 - round);
            assert_eq!(circle.pot, U128(CONTRIBUTION));
            assert_eq!(contribute(&mut c, ADA, 0, round, secs), CONTRIBUTION, "no double payment");
        }
        assert_eq!(contribute(&mut c, BAYO, 0, round, secs), 0);
        assert_eq!(contribute(&mut c, CHIOMA, 0, round, secs), 0);
        assert!(c.circle_of(0).unwrap().paying);
        set("contri.near", secs + 1);
        assert!(c.finalize_payout(0, round, U128(3 * CONTRIBUTION), true));
    }
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.status, CircleStatus::Finished);
    assert!(circle.payouts.iter().all(|p| p.amount == U128(3 * CONTRIBUTION) && p.shortfall == U128(0)));
    assert_eq!(circle.members[0].ahead, 0);
    assert_eq!(circle.members[0].missed, 0);
    assert_eq!(c.record_of(&acc(ADA)).completed, 1);
    // Deposits come back and the circle can close: nothing paid ahead is left in it.
    set("anyone.near", 100 + 3 * DAY);
    assert_eq!(c.internal_release(0), 3);
    c.internal_close(0);
    assert!(c.circle_of(0).is_none());
}

#[test]
fn paying_ahead_is_refused_past_the_last_round_or_for_the_wrong_amount() {
    let mut c = full_circle_of_three();
    assert_eq!(pay_ahead(&mut c, ADA, 0, 4, 100), 4 * CONTRIBUTION, "only three rounds");
    assert_eq!(pay_ahead(&mut c, ADA, 0, 0, 100), 0, "nothing sent, nothing to refund");
    assert_eq!(transfer(&mut c, ADA, 2 * CONTRIBUTION, "ahead:0:3", 100), 2 * CONTRIBUTION, "short");
    assert_eq!(transfer(&mut c, ADA, 4 * CONTRIBUTION, "ahead:0:3", 100), 4 * CONTRIBUTION, "too much");
    assert_eq!(pay_ahead(&mut c, "stranger.near", 0, 1, 100), CONTRIBUTION);
    assert_eq!(pay_ahead(&mut c, ADA, 9, 1, 100), CONTRIBUTION);
    // Paid this round already: two later rounds are left.
    assert_eq!(contribute(&mut c, ADA, 0, 0, 100), 0);
    assert_eq!(pay_ahead(&mut c, ADA, 0, 3, 100), 3 * CONTRIBUTION);
    assert_eq!(pay_ahead(&mut c, ADA, 0, 2, 100), 0);
    assert_eq!(pay_ahead(&mut c, ADA, 0, 1, 100), CONTRIBUTION, "every round is paid");
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.members[0].ahead, 2);
    assert_eq!(circle.pot, U128(CONTRIBUTION));
    // Not before the circle starts.
    let mut c = setup();
    let id = create(&mut c, 3);
    join(&mut c, ADA, id);
    assert_eq!(pay_ahead(&mut c, ADA, id, 1, 20), CONTRIBUTION);
}

#[test]
fn when_everyone_paid_ahead_the_next_round_is_ready_to_pay_out() {
    let mut c = full_circle_of_three();
    for who in [ADA, BAYO, CHIOMA] {
        assert_eq!(pay_ahead(&mut c, who, 0, 2, 100), 0);
    }
    assert!(c.circle_of(0).unwrap().paying, "the last one started round 0's payout");
    set("contri.near", 101);
    assert!(c.finalize_payout(0, 0, U128(3 * CONTRIBUTION), true));
    let circle = c.circle_of(0).unwrap();
    assert!(circle.all_paid());
    assert_eq!(circle.pot, U128(3 * CONTRIBUTION));
    // Anyone (the keeper) starts it; round 2 is then unpaid by everyone.
    set("anyone.near", 102);
    c.internal_pay_out(0);
    assert!(c.circle_of(0).unwrap().paying);
    set("contri.near", 103);
    assert!(c.finalize_payout(0, 1, U128(3 * CONTRIBUTION), true));
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.round, 2);
    assert!(circle.members.iter().all(|m| !m.paid_this_round && m.ahead == 0));
}

#[test]
fn a_late_round_settles_without_charging_a_member_who_paid_ahead() {
    let mut c = full_circle_of_three();
    assert_eq!(pay_ahead(&mut c, CHIOMA, 0, 2, 100), 0);
    contribute(&mut c, ADA, 0, 0, 100);
    contribute(&mut c, BAYO, 0, 0, 100);
    set("contri.near", 101);
    c.finalize_payout(0, 0, U128(3 * CONTRIBUTION), true);
    // Round 1: only Chioma's prepaid share comes in; the round runs late.
    set("anyone.near", 10 + 2 * DAY + 1);
    c.internal_settle(0);
    let circle = c.circle_of(0).unwrap();
    assert_eq!(circle.members[2].missed, 0);
    assert_eq!(circle.members[2].deposit, U128(CONTRIBUTION));
    assert_eq!(circle.members[0].missed, 1);
}
