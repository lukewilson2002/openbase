//! Array functions and rollup-style use of `values`.

use super::support::*;
use crate::value::Value;

fn rollup(items: Vec<Value>) -> Ctx {
    Ctx {
        values: arr(items),
        ..Ctx::default()
    }
}

#[test]
fn arrayjoin() {
    let c = rollup(vec![t("a"), t("b"), n(3.0)]);
    check_in("ARRAYJOIN(values)", &c, t("a, b, 3"));
    check_in("ARRAYJOIN(values, \"; \")", &c, t("a; b; 3"));
    check_in("ARRAYJOIN(values, \"\")", &c, t("ab3"));
    check_in("ARRAYJOIN(values, BLANK())", &c, t("ab3"));
    let nested = rollup(vec![t("a"), arr(vec![t("b"), t("c")])]);
    check_in("ARRAYJOIN(values, \"|\")", &nested, t("a|b|c"));
    let blanks = rollup(vec![t("a"), Value::Null, t("b")]);
    check_in("ARRAYJOIN(values, \"-\")", &blanks, t("a--b"));
    check("ARRAYJOIN(\"solo\")", t("solo"));
    check("ARRAYJOIN(BLANK())", t(""));
    let dates = rollup(vec![date(2024, 1, 2)]);
    check_in("ARRAYJOIN(values)", &dates, t("2024-01-02"));
    let bad = rollup(vec![t("a"), Value::Error("#ERROR: bad".into())]);
    check_err_in("ARRAYJOIN(values)", &bad, "bad");
}

#[test]
fn arraycompact() {
    let c = rollup(vec![t("a"), t(""), Value::Null, b(false), n(0.0), t(" ")]);
    check_in(
        "ARRAYCOMPACT(values)",
        &c,
        arr(vec![t("a"), b(false), n(0.0), t(" ")]),
    );
    check("ARRAYCOMPACT(BLANK())", arr(vec![]));
    check("ARRAYCOMPACT(\"x\")", arr(vec![t("x")]));
}

#[test]
fn arrayflatten() {
    let c = rollup(vec![
        t("a"),
        arr(vec![t("b"), arr(vec![t("c")])]),
        Value::Null,
    ]);
    check_in(
        "ARRAYFLATTEN(values)",
        &c,
        arr(vec![t("a"), t("b"), t("c"), Value::Null]),
    );
    check("ARRAYFLATTEN(5)", arr(vec![n(5.0)]));
    check("ARRAYFLATTEN(BLANK())", arr(vec![]));
}

#[test]
fn arrayunique() {
    let c = rollup(vec![t("a"), t("b"), t("a"), n(1.0), n(1.0), t("A")]);
    check_in(
        "ARRAYUNIQUE(values)",
        &c,
        arr(vec![t("a"), t("b"), n(1.0), t("A")]),
    );
    check("ARRAYUNIQUE(BLANK())", arr(vec![]));
    check_in(
        "ARRAYJOIN(ARRAYUNIQUE(values), \", \")",
        &c,
        t("a, b, 1, A"),
    );
}

#[test]
fn arrayslice() {
    let c = rollup(vec![t("a"), t("b"), t("c"), t("d")]);
    check_in("ARRAYSLICE(values, 2, 3)", &c, arr(vec![t("b"), t("c")]));
    check_in(
        "ARRAYSLICE(values, 2)",
        &c,
        arr(vec![t("b"), t("c"), t("d")]),
    );
    check_in("ARRAYSLICE(values, -2)", &c, arr(vec![t("c"), t("d")]));
    check_in(
        "ARRAYSLICE(values, 1, -2)",
        &c,
        arr(vec![t("a"), t("b"), t("c")]),
    );
    check_in("ARRAYSLICE(values, 1, 1)", &c, arr(vec![t("a")]));
    check_in("ARRAYSLICE(values, 0, 2)", &c, arr(vec![t("a"), t("b")]));
    check_in("ARRAYSLICE(values, 3, 2)", &c, arr(vec![]));
    check_in("ARRAYSLICE(values, 10)", &c, arr(vec![]));
    check_in("ARRAYSLICE(values, -10, 99)", &c, c.values.clone());
    check_in(
        "ARRAYSLICE(values, 2, 0)",
        &c,
        arr(vec![t("b"), t("c"), t("d")]),
    );
    check_err_in("ARRAYSLICE(values, \"x\")", &c, "as a number");
}

#[test]
fn rollup_expressions() {
    let c = rollup(vec![n(2.0), n(4.0), n(6.0)]);
    // Plain binary floating point, like Airtable's JavaScript engine.
    check_in("SUM(values) * 1.2", &c, n(12.0 * 1.2));
    check_in("ROUND(SUM(values) * 1.2, 2)", &c, n(14.4));
    check_in("IF(COUNTALL(values) > 2, \"many\", \"few\")", &c, t("many"));
    check_in("AND(values)", &c, b(true));
    check_in("OR(values)", &c, b(true));
    check_in("XOR(values)", &c, b(true));
    check_in("CONCATENATE(values)", &c, t("2, 4, 6"));
    check_in("MAX(values) - MIN(values)", &c, n(4.0));
    let empty = rollup(vec![]);
    check_in("SUM(values)", &empty, n(0.0));
    check_in("ARRAYJOIN(values)", &empty, t(""));
    check_in("AND(values)", &empty, b(true));
    check_in("OR(values)", &empty, b(false));
    // Outside a rollup, `values` is blank.
    check("COUNTALL(values)", n(1.0));
    check("ARRAYJOIN(values)", t(""));
}

#[test]
fn lookup_fields_behave_like_arrays() {
    let c = with(&[("Names", arr(vec![t("Ann"), t("Bob")]))]);
    check_in("ARRAYJOIN({Names}, \" & \")", &c, t("Ann & Bob"));
    check_in("LEN({Names})", &c, n(8.0));
    check_in("UPPER({Names})", &c, t("ANN, BOB"));
    check_in("COUNTA({Names})", &c, n(2.0));
}
