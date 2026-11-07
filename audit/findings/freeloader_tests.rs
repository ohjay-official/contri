// Append to contract/src/tests.rs (uses its helpers). cargo test can't run in
// the audit sandbox; each test states what it should show.

/// SHOULD PASS on the current code, proving the finding: CHIOMA pays only her
/// join deposit (1 C), never contributes, and still receives a 2 C pot in her
/// own turn (round 2). Net +1 C; ADA and BAYO each end 0.5 C down on average.
/// With n = 20 the same strategy nets +(n - 2) C.
#[test]
fn a_member_who_never_pays_still_collects_their_pot() {
    let mut c = full_circle_of_three(); // started at t = 10 s, period 1 day
    // Round 0: CHIOMA skips; her deposit covers her share.
    contribute(&mut c, ADA, 0, 0, 100);
    contribute(&mut c, BAYO, 0, 0, 100);
    set("anyone.near", 10 + DAY + 1);
    c.internal_settle(0);
    assert!(c.finalize_payout(0, 0, U128(3 * CONTRIBUTION), true));
    // Round 1: CHIOMA skips again; nothing covers it, BAYO is paid short.
    contribute(&mut c, ADA, 0, 1, 10 + DAY + 100);
    contribute(&mut c, BAYO, 0, 1, 10 + DAY + 100);
    set("anyone.near", 12 + 2 * DAY);
    c.internal_settle(0);
    assert!(c.finalize_payout(0, 1, U128(2 * CONTRIBUTION), true));
    // Round 2 is CHIOMA's turn. She skips a third time.
    contribute(&mut c, ADA, 0, 2, 12 + 2 * DAY + 100);
    contribute(&mut c, BAYO, 0, 2, 12 + 2 * DAY + 100);
    set("anyone.near", 13 + 3 * DAY);
    c.internal_settle(0);
    let mid = c.circle_of(0).unwrap();
    assert!(mid.paying);
    assert_eq!(mid.pot, U128(2 * CONTRIBUTION)); // all of it goes to the defaulter
    assert!(c.finalize_payout(0, 2, U128(2 * CONTRIBUTION), true));
    let done = c.circle_of(0).unwrap();
    assert_eq!(done.payouts[2].to, acc(CHIOMA));
    assert_eq!(done.payouts[2].amount, U128(2 * CONTRIBUTION));
    assert_eq!(done.members[2].missed, 3);
}

/// SHOULD FAIL on the current code and PASS after the fix (withhold arrears
/// from the defaulter's own payout and pay them to the members who were short):
/// CHIOMA's round-2 payout is the pot minus her 2 C of uncovered arrears.
#[test]
fn a_defaulters_payout_is_cut_by_what_they_skipped() {
    let mut c = full_circle_of_three();
    contribute(&mut c, ADA, 0, 0, 100);
    contribute(&mut c, BAYO, 0, 0, 100);
    set("anyone.near", 10 + DAY + 1);
    c.internal_settle(0);
    assert!(c.finalize_payout(0, 0, U128(3 * CONTRIBUTION), true));
    contribute(&mut c, ADA, 0, 1, 10 + DAY + 100);
    contribute(&mut c, BAYO, 0, 1, 10 + DAY + 100);
    set("anyone.near", 12 + 2 * DAY);
    c.internal_settle(0);
    assert!(c.finalize_payout(0, 1, U128(2 * CONTRIBUTION), true));
    contribute(&mut c, ADA, 0, 2, 12 + 2 * DAY + 100);
    contribute(&mut c, BAYO, 0, 2, 12 + 2 * DAY + 100);
    set("anyone.near", 13 + 3 * DAY);
    c.internal_settle(0);
    // Arrears not covered by her own deposit: rounds 1 and 2 = 2 C. Pot is 2 C.
    assert_eq!(c.circle_of(0).unwrap().pot, U128(0), "the defaulter's pot should be withheld");
}

/// SHOULD FAIL on the current code and PASS after the seat-sale fix: a member
/// can only buy a turn k seats earlier after topping their deposit up by k C.
#[test]
fn buying_an_earlier_turn_needs_a_bigger_deposit() {
    let mut c = full_circle_of_three();
    auth(&mut c, ADA, "list_seat:0:0:1000000", 20);
    // CHIOMA (seat 2) buys seat 0 with only her 1 C join deposit.
    let refund = transfer(&mut c, CHIOMA, 1_000_000, "buy_seat:0:0", 30);
    assert_eq!(refund, 1_000_000, "should be refused until her deposit is 3 C");
}
