use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

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
        vec![acc(from)],
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

fn create(c: &mut Contri, size: u32) -> u64 {
    auth(
        c,
        ADA,
        &format!("create:{CONTRIBUTION}:{size}:{DAY}:Lagos Ajo"),
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
        vec![acc(ADA)],
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
        vec![acc(ADA)],
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
        vec![acc(ADA)],
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

    // Round 1: Bayo misses, deposit covers it.
    contribute(&mut c, ADA, id, 1, 200);
    set("anyone.near", 10 + 2 * DAY + 1);
    c.internal_settle(id);
    set("contri.near", 10 + 2 * DAY + 2);
    c.finalize_payout(id, 1, U128(2 * CONTRIBUTION), true);

    let circle = c.circle_of(id).unwrap();
    assert_eq!(circle.status, CircleStatus::Finished);
    assert_eq!(circle.payouts[1].to, acc(BAYO));
    assert_eq!(c.record_of(&acc(ADA)).completed, 1);
    assert_eq!(c.record_of(&acc(BAYO)).defaults, 1);
    assert_eq!(c.record_of(&acc(BAYO)).missed_payments, 1);

    // Ada's deposit is still held and can be released.
    assert_eq!(circle.members[0].deposit, U128(CONTRIBUTION));
    set("anyone.near", 10 + 2 * DAY + 3);
    assert_eq!(c.internal_release(id), 1);
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
    assert!(c.internal_create(&acc(ADA), "".into(), U128(1), 3, DAY).is_err());
    assert!(c.internal_create(&acc(ADA), "x".into(), U128(0), 3, DAY).is_err());
    assert!(c.internal_create(&acc(ADA), "x".into(), U128(1), 1, DAY).is_err());
    assert!(c.internal_create(&acc(ADA), "x".into(), U128(1), 21, DAY).is_err());
    assert!(c.internal_create(&acc(ADA), "x".into(), U128(1), 3, 10).is_err());
    assert_eq!(c.internal_create(&acc(ADA), "x".into(), U128(1), 3, DAY), Ok(0));
}

#[test]
fn messages_parse_strictly() {
    assert!(matches!(parse_transfer("join:3"), Some(TransferMsg::Join { circle: 3 })));
    assert!(matches!(
        parse_transfer("contribute:3:2"),
        Some(TransferMsg::Contribute { circle: 3, round: 2 })
    ));
    assert!(matches!(parse_transfer("buy_seat:1:0"), Some(TransferMsg::BuySeat { circle: 1, seat: 0 })));
    assert!(parse_transfer("join:3:9").is_none());
    assert!(parse_transfer("contribute:3").is_none());
    assert!(parse_transfer("join:x").is_none());
    assert!(parse_transfer("steal:1").is_none());
    assert!(parse_transfer("").is_none());

    match parse_auth("create:5000000:5:86400:Ada's: Lagos circle") {
        Some(AuthMsg::Create { name, contribution, size, period_secs }) => {
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
    assert!(parse_auth("create:5:5:86400").is_none());
}

#[test]
#[should_panic(expected = "unreadable message")]
fn unreadable_auth_message_panics() {
    let mut c = setup();
    auth(&mut c, ADA, "make_me_rich", 1);
}

#[test]
fn views_return_valid_json() {
    use near_sdk::serde_json::{self, Value};
    let mut c = full_circle_of_three();
    auth(&mut c, ADA, "create:1000000:2:3600:Mama \"Tolu\" \\ circle", 1);
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
    use near_sdk::serde_json::{self, Value};
    let raw = "line\nbreak\ttab\u{1}end";
    let v: Value = serde_json::from_str(&jstr(raw)).unwrap();
    assert_eq!(v, raw);
}

#[test]
fn public_methods_read_json_arguments() {
    let mut c = setup();
    set_with_input(
        INTENTS,
        1,
        &format!(r#"{{"signer_id":"{ADA}","msg":"create:5000000:2:86400:Test"}}"#),
    );
    c.on_auth();
    assert_eq!(c.circle_of(0).unwrap().name, "Test");

    for who in [ADA, BAYO] {
        set_with_input(
            INTENTS,
            2,
            &format!(
                r#"{{"sender_id":"{who}","previous_owner_ids":["{who}"],"token_ids":["{TOKEN}"],"amounts":["5000000"],"msg":"join:0"}}"#
            ),
        );
        c.mt_on_transfer();
    }
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
