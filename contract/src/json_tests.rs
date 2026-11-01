//! Differential tests: the contract's JSON reader (`json.rs`) against serde_json.
//!
//! Every document is parsed by both. They must agree on whether it is valid
//! JSON and, when it is, on its value. Documents are generated at random
//! (seeded, so failures reproduce), then mutated one byte at a time to produce
//! near-miss invalid input. serde_json is the reference, with one change that
//! matches near-sdk contracts: an object with a repeated key is rejected, as
//! serde rejects a repeated field.

use crate::json::{self, Json};
use crate::jstr;
use near_sdk::serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use near_sdk::serde_json::{self, Map, Number, Value};
use std::fmt;

// ----------------------------------------------------------------------
// Reference parser: serde_json, rejecting repeated keys
// ----------------------------------------------------------------------

struct Strict(Value);

impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(StrictVisitor).map(Strict)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
        Ok(Number::from_f64(v).map_or(Value::Null, Value::Number))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.to_string()))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = vec![];
        while let Some(Strict(v)) = seq.next_element()? {
            items.push(v);
        }
        Ok(Value::Array(items))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut out = Map::new();
        while let Some(k) = map.next_key::<String>()? {
            let Strict(v) = map.next_value()?;
            if out.insert(k.clone(), v).is_some() {
                return Err(de::Error::custom(format!("repeated key {k}")));
            }
        }
        Ok(Value::Object(out))
    }
}

fn reference(doc: &[u8]) -> Result<Value, serde_json::Error> {
    serde_json::from_slice::<Strict>(doc).map(|s| s.0)
}

/// Our parse result as a serde_json value. Numbers keep their source text in
/// `Json`, so serde_json reads that text to compare like for like.
fn to_value(j: &Json) -> Value {
    match j {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Num(n) => serde_json::from_str(n).expect("number text is valid JSON"),
        Json::Str(s) => Value::String(s.clone()),
        Json::Arr(items) => Value::Array(items.iter().map(to_value).collect()),
        Json::Obj(fields) => Value::Object(fields.iter().map(|(k, v)| (k.clone(), to_value(v))).collect()),
    }
}

/// Parses `doc` with both and checks they agree. Returns whether it was valid.
fn agree(doc: &[u8]) -> bool {
    let ours = json::parse(doc);
    match (&ours, reference(doc)) {
        (Some(o), Ok(t)) => {
            assert_eq!(to_value(o), t, "different values for {:?}", String::from_utf8_lossy(doc));
            true
        }
        (None, Err(_)) => false,
        // The one known difference. serde_json reads a number as a 64-bit
        // integer or an f64 and rejects one past f64's range (like 1e400). The
        // contract keeps number text and only reads numbers as integers, which
        // fails for such a number, so the call is rejected either way.
        (Some(_), Err(e)) if e.to_string().starts_with("number out of range") => true,
        (_, theirs) => panic!(
            "contract accepts: {}, serde_json accepts: {}, input: {:?}",
            ours.is_some(),
            theirs.is_ok(),
            String::from_utf8_lossy(doc)
        ),
    }
}

// ----------------------------------------------------------------------
// Seeded random generator (xorshift64*)
// ----------------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }
}

/// Deep enough to cover nesting, shallow enough that one inserted bracket
/// cannot reach the contract's depth limit (8) while serde_json allows 128.
const GEN_DEPTH: u32 = 4;

fn ws(r: &mut Rng, out: &mut String) {
    while r.chance(25) {
        out.push(*r.pick(&[' ', '\n', '\t', '\r']));
    }
}

fn digits(r: &mut Rng, out: &mut String, max: u64) {
    for _ in 0..=r.below(max) {
        out.push((b'0' + r.below(10) as u8) as char);
    }
}

fn number(r: &mut Rng, out: &mut String) {
    if r.chance(30) {
        out.push('-');
    }
    if r.chance(20) {
        out.push('0');
    } else {
        out.push((b'1' + r.below(9) as u8) as char);
        if r.chance(70) {
            digits(r, out, 38); // up to u128 length
        }
    }
    if r.chance(25) {
        out.push('.');
        digits(r, out, 5);
    }
    if r.chance(20) {
        out.push(*r.pick(&['e', 'E']));
        if r.chance(50) {
            out.push(*r.pick(&['+', '-']));
        }
        // One exponent digit: a one-byte insertion still cannot overflow f64,
        // which serde_json rejects as out of range.
        digits(r, out, 1);
    }
}

fn string(r: &mut Rng, out: &mut String) {
    out.push('"');
    for _ in 0..r.below(12) {
        match r.below(12) {
            0 => out.push_str("\\\""),
            1 => out.push_str("\\\\"),
            2 => out.push_str(*r.pick(&["\\n", "\\t", "\\r", "\\b", "\\f", "\\/"])),
            3 => {
                let c = *r.pick(&['\u{0}', '\u{1}', '\u{1f}', 'é', '€', '\u{7f}']);
                let hex = format!("{:04x}", c as u32);
                out.push_str("\\u");
                out.push_str(&if r.chance(50) { hex.to_uppercase() } else { hex });
            }
            4 => out.push_str(*r.pick(&["\\ud83d\\ude00", "\\uD834\\uDD1E"])),
            5 => out.push(*r.pick(&['é', 'ß', '€', '漢', '😀'])),
            6 => out.push(*r.pick(&[':', ',', '{', '}', '[', ']', ' '])),
            _ => out.push((b'a' + r.below(26) as u8) as char),
        }
    }
    out.push('"');
}

fn value(r: &mut Rng, depth: u32, out: &mut String) {
    ws(r, out);
    let kind = if depth >= GEN_DEPTH { r.below(4) } else { r.below(6) };
    match kind {
        0 => out.push_str(*r.pick(&["null", "true", "false"])),
        1 => number(r, out),
        2 | 3 => string(r, out),
        4 => {
            out.push('[');
            for i in 0..r.below(4) {
                if i > 0 {
                    out.push(',');
                }
                value(r, depth + 1, out);
            }
            ws(r, out);
            out.push(']');
        }
        _ => {
            out.push('{');
            for i in 0..r.below(4) {
                if i > 0 {
                    out.push(',');
                }
                ws(r, out);
                // A small key set, so repeated keys come up regularly.
                if r.chance(80) {
                    out.push_str(*r.pick(&["\"id\"", "\"msg\"", "\"amount\"", "\"a\"", "\"\\u0061\""]));
                } else {
                    string(r, out);
                }
                ws(r, out);
                out.push(':');
                value(r, depth + 1, out);
            }
            ws(r, out);
            out.push('}');
        }
    }
    ws(r, out);
}

const MUTATION_BYTES: &[u8] = b"{}[],:\"\\ \n\t0123456789-+.eEtrufalsn/ubx\x00\x01\x1f\x7f\xc3\xa9\xff";

fn mutate(r: &mut Rng, doc: &[u8]) -> Vec<u8> {
    let mut m = doc.to_vec();
    let at = r.below(m.len() as u64 + 1) as usize;
    match r.below(4) {
        0 if at < m.len() => {
            m.remove(at);
        }
        1 if at < m.len() => m[at] = *r.pick(MUTATION_BYTES),
        2 => m.truncate(at),
        _ => m.insert(at, *r.pick(MUTATION_BYTES)),
    }
    m
}

// ----------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------

#[test]
fn agrees_with_serde_json_on_generated_and_mutated_documents() {
    let mut r = Rng(0x00C0_FFEE_D00D_F00D);
    let (mut valid, mut invalid, mut mutated_valid, mut mutated_invalid) = (0, 0, 0, 0);
    for _ in 0..20_000 {
        let mut doc = String::new();
        value(&mut r, 0, &mut doc);
        if agree(doc.as_bytes()) {
            valid += 1;
        } else {
            invalid += 1;
        }
        for _ in 0..4 {
            if agree(&mutate(&mut r, doc.as_bytes())) {
                mutated_valid += 1;
            } else {
                mutated_invalid += 1;
            }
        }
    }
    // Both sides must be exercised: generated documents are valid unless an
    // object repeats a key, and mutations land on both sides.
    println!("generated: {valid} valid, {invalid} invalid; mutated: {mutated_valid} valid, {mutated_invalid} invalid");
    assert!(valid > 5_000 && invalid > 100, "generated: {valid} valid, {invalid} invalid");
    assert!(mutated_valid > 5_000 && mutated_invalid > 20_000, "mutated: {mutated_valid} valid, {mutated_invalid} invalid");
}

#[test]
fn agrees_with_serde_json_on_edge_cases() {
    let cases: &[&[u8]] = &[
        // Numbers
        b"0", b"-0", b"01", b"-01", b"-", b"+1", b"1.", b".5", b"1.5", b"1e", b"1e+", b"1E-2", b"0e0",
        b"1.0e+10", b"00", b"-a", b"1-2", b"1.2.3", b"1ee2", b"340282366920938463463374607431768211455",
        b"18446744073709551616", b"-9223372036854775809", b"1e99", b"1e-99", b"1e400", b"-1e400", b"[1e999]",
        // Strings and escapes
        b"\"\"", b"\"\\u00e9\"", b"\"\\u00E9\"", b"\"\\u+abc\"", b"\"\\u-abc\"", b"\"\\u12\"", b"\"\\u12g4\"",
        b"\"\\ud83d\\ude00\"", b"\"\\ud83d\"", b"\"\\ud83d\\u0041\"", b"\"\\udc00\"", b"\"\\ud83dx\"", b"\"\\x\"",
        b"\"\\'\"", b"\"\x7f\"", b"\"\x1f\"", b"\"\x00\"", b"\"\xc3\xa9\"", b"\"\xc3\"", b"\"\xff\"", b"\"abc",
        b"\"\\\"", b"\"\\/\"",
        // Literals and structure
        b"null", b"nul", b"nulll", b"true", b"True", b"truex", b"false", b"[]", b"{}", b"[ ]", b"{ }",
        b"[1,]", b"[,1]", b"[1 2]", b"{,}", b"{\"a\"}", b"{\"a\":}", b"{\"a\":1,}", b"{\"a\" 1}", b"{a:1}",
        b"{\"a\":1,\"a\":2}", b"{\"a\":1,\"\\u0061\":2}", b"{\"a\":{\"a\":1}}", b"[[[[[[[1]]]]]]]",
        b" \t\n\r1 \t\n\r", b"\x0b1", b"1 2", b"", b" ", b"\xef\xbb\xbf1", b"[1]x", b"{\"a\":1}}",
    ];
    for case in cases {
        agree(case);
    }
}

#[test]
fn nesting_limit_is_eight() {
    let nested = |n: usize| format!("{}1{}", "[".repeat(n), "]".repeat(n));
    assert!(json::parse(nested(8).as_bytes()).is_some());
    assert!(json::parse(nested(9).as_bytes()).is_none());
    assert!(reference(nested(9).as_bytes()).is_ok(), "serde_json allows deeper nesting");
}

#[test]
fn jstr_round_trips_through_both_parsers() {
    let mut r = Rng(0x5EED_0F_C0_47_1E);
    let pool = ['a', 'Z', '0', ' ', '"', '\\', '/', '\n', '\r', '\t', '\u{0}', '\u{1}', '\u{1f}', '\u{7f}', 'é', '€', '😀', ':'];
    for _ in 0..5_000 {
        let s: String = (0..r.below(20)).map(|_| *r.pick(&pool)).collect();
        let encoded = jstr(&s);
        assert_eq!(serde_json::from_str::<String>(&encoded).unwrap(), s);
        assert_eq!(json::parse(encoded.as_bytes()).unwrap().as_str(), Some(s.as_str()));
    }
}
