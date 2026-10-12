//! Logical functions.

use super::support::*;
use crate::value::Value;

#[test]
fn and() {
    check("AND(1, \"x\", TRUE())", b(true));
    check("AND(1, 0)", b(false));
    check("AND(BLANK())", b(false));
    check("AND(1 > 0, 2 > 1)", b(true));
    let c = with(&[
        ("V", arr(vec![b(true), n(1.0)])),
        ("W", arr(vec![b(true), b(false)])),
    ]);
    check_in("AND({V})", &c, b(true));
    check_in("AND({W})", &c, b(false));
    check_err("AND(1, ERROR())", "#ERROR!");
}

#[test]
fn or() {
    check("OR(0, \"\", 3)", b(true));
    check("OR(0, FALSE(), BLANK())", b(false));
    let c = with(&[("W", arr(vec![b(false), b(true)]))]);
    check_in("OR({W})", &c, b(true));
    check_err("OR(1, 1/0)", "Division by zero");
}

#[test]
fn xor() {
    check("XOR(1, 0)", b(true));
    check("XOR(1, 1)", b(false));
    check("XOR(1, 1, 1)", b(true));
    check("XOR(0)", b(false));
    check_err("XOR(ERROR())", "#ERROR!");
}

#[test]
fn not() {
    check("NOT(TRUE())", b(false));
    check("NOT(0)", b(true));
    check("NOT(\"\")", b(true));
    check("NOT(\"a\")", b(false));
    check("NOT(BLANK())", b(true));
    check_err("NOT(ERROR())", "#ERROR!");
}

#[test]
fn blank_true_false_error() {
    check("BLANK()", Value::Null);
    check("TRUE()", b(true));
    check("FALSE()", b(false));
    check("ERROR()", Value::Error("#ERROR!".into()));
}

#[test]
fn if_() {
    check("IF(1 > 0, \"yes\", \"no\")", t("yes"));
    check("IF(0, \"yes\", \"no\")", t("no"));
    check("IF(0, \"yes\")", Value::Null);
    check("IF(\"\", 1, 2)", n(2.0));
    check("IF(BLANK(), 1, 2)", n(2.0));
    check("if({Missing}, 1, 2)", n(2.0));
    // Untaken branch errors do not surface.
    check("IF(1, 5, 1/0)", n(5.0));
    check("IF(0, ERROR(), 7)", n(7.0));
    check_err("IF(1, 1/0, 5)", "Division by zero");
    check_err("IF(ERROR(), 1, 2)", "#ERROR!");
    check("IF(IF(1, 0, 1), \"a\", \"b\")", t("b"));
}

#[test]
fn iserror() {
    check("ISERROR(1/0)", b(true));
    check("ISERROR(ERROR())", b(true));
    check("ISERROR(1)", b(false));
    check("ISERROR(BLANK())", b(false));
    check("IF(ISERROR(1/0), \"oops\", \"fine\")", t("oops"));
    check("ISERROR(\"abc\" * 1)", b(true));
    let c = with(&[("L", arr(vec![n(1.0), Value::Error("#ERROR!".into())]))]);
    check_in("ISERROR({L})", &c, b(true));
}

#[test]
fn switch() {
    check("SWITCH(2, 1, \"one\", 2, \"two\", \"other\")", t("two"));
    check("SWITCH(9, 1, \"one\", 2, \"two\", \"other\")", t("other"));
    check("SWITCH(9, 1, \"one\", 2, \"two\")", Value::Null);
    check("SWITCH(\"b\", \"a\", 1, \"b\", 2)", n(2.0));
    check("SWITCH(\"B\", \"a\", 1, \"b\", 2, 0)", n(0.0));
    check("SWITCH(BLANK(), BLANK(), \"empty\", \"full\")", t("empty"));
    check("SWITCH(0, BLANK(), \"empty\", \"full\")", t("full"));
    check("SWITCH(\"1\", 1, \"num\", \"text\")", t("text"));
    check("SWITCH(1, 1, \"a\", ERROR())", t("a"));
    check("SWITCH(2, 1, ERROR(), 2, \"b\")", t("b"));
    check_err("SWITCH(ERROR(), 1, 2)", "#ERROR!");
    check_err("SWITCH(3, 1, 2, 3, 1/0)", "Division by zero");
    let c = with(&[("Status", t("Done"))]);
    check_in(
        "SWITCH({Status}, \"Todo\", 0, \"Doing\", 50, \"Done\", 100)",
        &c,
        n(100.0),
    );
}
