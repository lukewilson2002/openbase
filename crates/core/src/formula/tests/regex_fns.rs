//! Regex functions.

use super::support::*;
use crate::value::Value;

#[test]
fn regex_match() {
    check("REGEX_MATCH(\"Order 1234\", \"\\d+\")", b(true));
    check("REGEX_MATCH(\"Order\", \"\\\\d+\")", b(false));
    check("REGEX_MATCH(\"Hello\", \"^h\")", b(false));
    check("REGEX_MATCH(\"Hello\", \"(?i)^h\")", b(true));
    check(
        "REGEX_MATCH(\"a@b.co\", \"^[^@\\s]+@[^@\\s]+\\.[a-z]+$\")",
        b(true),
    );
    check("REGEX_MATCH(BLANK(), \"^$\")", b(true));
    check("REGEX_MATCH(12345, \"^\\d{5}$\")", b(true));
    check("REGEX_MATCH(\"日本\", \"^\\p{Han}+$\")", b(true));
    check_err("REGEX_MATCH(\"x\", \"(\")", "Invalid regular expression");
    check_err("REGEX_MATCH(ERROR(), \"x\")", "#ERROR!");
}

#[test]
fn regex_extract() {
    check("REGEX_EXTRACT(\"Order 1234 and 99\", \"\\d+\")", t("1234"));
    check("REGEX_EXTRACT(\"no digits\", \"\\d+\")", Value::Null);
    check(
        "REGEX_EXTRACT(\"user@example.com\", \"@(.*)$\")",
        t("@example.com"),
    );
    check("REGEX_EXTRACT(\"ABC\", \"(?i)b\")", t("B"));
}

#[test]
fn regex_replace() {
    check("REGEX_REPLACE(\"a1b22c333\", \"\\d+\", \"#\")", t("a#b#c#"));
    check(
        "REGEX_REPLACE(\"John Smith\", \"(\\w+) (\\w+)\", \"$2, $1\")",
        t("Smith, John"),
    );
    check(
        "REGEX_REPLACE(\"2024-03-15\", \"(?P<y>\\d+)-(?P<m>\\d+)-(?P<d>\\d+)\", \"${d}/${m}/${y}\")",
        t("15/03/2024"),
    );
    check("REGEX_REPLACE(\"  a   b \", \"\\s+\", \" \")", t(" a b "));
    check("REGEX_REPLACE(\"abc\", \"x\", \"y\")", t("abc"));
    check("REGEX_REPLACE(\"abc\", \"\", \"-\")", t("-a-b-c-"));
    check_err(
        "REGEX_REPLACE(REPT(\"a\", 100000), \"\", REPT(\"b\", 100))",
        "too long",
    );
}

#[test]
fn regex_limits() {
    check_err(
        &format!("REGEX_MATCH(\"x\", \"{}\")", "a".repeat(2001)),
        "too long",
    );
    // A pattern that compiles to a huge program is rejected, not built.
    check_err(
        "REGEX_MATCH(\"x\", \"(\\w{100}){100}\")",
        "Invalid regular expression",
    );
}

#[test]
fn regex_is_linear_time() {
    // Catastrophic for backtracking engines; instant with the regex crate.
    let start = std::time::Instant::now();
    let src = format!("REGEX_MATCH(\"{}!\", \"^(a+)+$\")", "a".repeat(5000));
    check(&src, b(false));
    assert!(start.elapsed().as_secs() < 5);
}

#[test]
fn replace_expands_references_into_the_output() {
    check("REGEX_REPLACE(\"abc\", \"(b)\", \"[$1$0]\")", t("a[bb]c"));
    check("REGEX_REPLACE(\"abc\", \"b\", \"$$\")", t("a$c"));
    check(
        "REGEX_REPLACE(\"ab\", \"(?P<x>a)\", \"${x}${x}\")",
        t("aab"),
    );
}

#[test]
fn replace_stops_an_expansion_that_would_not_fit_before_building_it() {
    // One 400,000 byte match and 200,000 references to it: 80 GB if built,
    // so the size is checked before the expansion, not after (F3).
    check_err(
        "REGEX_REPLACE(REPT(\"a\", 400000), \".+\", REPT(\"$0\", 200000))",
        "too long",
    );
    // Smaller than the limit, so the answer is the text itself.
    check_num(
        "LEN(REGEX_REPLACE(REPT(\"a\", 1000), \".+\", \"$0$0\"))",
        2000.0,
    );
}

#[test]
fn scan_cost_grows_with_the_size_of_the_pattern() {
    // A 12,000-state pattern over 400 KB is billions of steps once the lazy
    // DFA gives up, so it runs out of budget instead (F40).
    check_err(
        "REGEX_MATCH(REPT(\"a\", 400000), \"[ab]{12000}[^ab]\")",
        "too expensive",
    );
    check_err(
        "REGEX_EXTRACT(REPT(\"a\", 400000), \"[ab]{12000}[^ab]\")",
        "too expensive",
    );
    check_err(
        "REGEX_REPLACE(REPT(\"a\", 400000), \"[ab]{12000}[^ab]\", \"\")",
        "too expensive",
    );
    // The same pattern over a short text, and ordinary patterns over long
    // text, cost what they always did.
    check(
        "REGEX_MATCH(REPT(\"a\", 1000), \"[ab]{12000}[^ab]\")",
        b(false),
    );
    check("REGEX_MATCH(REPT(\"a\", 400000), \"\\\\w+\")", b(true));
    check(
        "REGEX_MATCH(REPT(\"a\", 400000), \"^[a-z]{5,20}\\\\d{3}\")",
        b(false),
    );
}
