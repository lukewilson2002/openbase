//! Operators, coercion rules, blanks and error propagation.

use super::support::*;
use crate::formula::{format_number, to_text};
use crate::value::Value;

#[test]
fn arithmetic() {
    check("1 + 2", n(3.0));
    check("5 - 7", n(-2.0));
    check("6 * 7", n(42.0));
    check("7 / 2", n(3.5));
    check("2 + 3 * 4", n(14.0));
    check("(2 + 3) * 4", n(20.0));
    check("-3 + 1", n(-2.0));
    check("--3", n(3.0));
    check("10 - 2 - 3", n(5.0));
    check("100 / 10 / 5", n(2.0));
    check("-0", n(0.0));
}

#[test]
fn division_by_zero_is_an_error() {
    check("1 / 0", Value::Error("#ERROR: Division by zero".into()));
    check_err("0 / 0", "Division by zero");
    check_err("1 / {Empty}", "Division by zero");
}

#[test]
fn overflow_is_an_error() {
    check_err("1e308 * 10", "not a finite number");
    check_err("-1e308 - 1e308", "not a finite number");
}

#[test]
fn blank_is_zero_in_arithmetic() {
    let c = with(&[("Price", n(10.0))]);
    check_in("{Price} + {Missing}", &c, n(10.0));
    check_in("{Missing} * 5", &c, n(0.0));
    check_in("-{Missing}", &c, n(0.0));
    check("BLANK() + 1", n(1.0));
    let c = with(&[("Empty", t(""))]);
    check_in("{Empty} + 2", &c, n(2.0));
}

#[test]
fn booleans_are_one_and_zero() {
    check("TRUE() + TRUE()", n(2.0));
    check("TRUE + 1", n(2.0));
    check("FALSE() * 5", n(0.0));
    check("(1 < 2) + (2 < 1)", n(1.0));
}

#[test]
fn numeric_text_coerces_in_arithmetic() {
    check("\"5\" + 1", n(6.0));
    check("' 2.5 ' * 2", n(5.0));
    check("\"1e2\" / 4", n(25.0));
    check_err("\"abc\" + 1", "Cannot use the text 'abc' as a number");
    check_err("\"inf\" + 1", "as a number");
    check_err("\"NaN\" * 1", "as a number");
}

#[test]
fn dates_in_arithmetic_point_to_date_functions() {
    let c = with(&[("Due", date(2024, 1, 1))]);
    check_err_in("{Due} + 1", &c, "DATEADD");
    check_err_in("{Due} - {Due}", &c, "DATETIME_DIFF");
}

#[test]
fn single_item_arrays_unwrap_in_arithmetic() {
    let c = with(&[
        ("One", arr(vec![n(4.0)])),
        ("Many", arr(vec![n(1.0), n(2.0)])),
        ("None", arr(vec![])),
    ]);
    check_in("{One} * 2", &c, n(8.0));
    check_in("{None} + 1", &c, n(1.0));
    check_err_in("{Many} + 1", &c, "list of 2 values");
}

#[test]
fn concatenation() {
    check("\"a\" & \"b\"", t("ab"));
    check("1 & 2", t("12"));
    check("3.0 & \"\"", t("3"));
    check("1.5 & \"x\"", t("1.5x"));
    check("0.1 + 0.2 & \"\"", t("0.30000000000000004"));
    check("-0.5 & \"\"", t("-0.5"));
    check("1e21 & \"\"", t("1000000000000000000000"));
    check("TRUE() & \"\"", t("1"));
    check("FALSE() & \"\"", t("0"));
    check("\"x\" & BLANK() & \"y\"", t("xy"));
    let c = with(&[("Tags", arr(vec![t("a"), t("b"), n(3.0)]))]);
    check_in("{Tags} & \"!\"", &c, t("a, b, 3!"));
    let c = with(&[("Nested", arr(vec![t("a"), arr(vec![t("b"), t("c")])]))]);
    check_in("\"\" & {Nested}", &c, t("a, b, c"));
}

#[test]
fn dates_render_as_iso_in_text() {
    let c = with(&[("D", date(2024, 2, 9)), ("T", dt("2024-02-09T13:05:00Z"))]);
    check_in("{D} & \"\"", &c, t("2024-02-09"));
    check_in("{T} & \"\"", &c, t("2024-02-09T13:05:00.000Z"));
}

#[test]
fn concatenation_is_length_limited() {
    check_err("REPT(\"a\", 300000) & REPT(\"b\", 300000)", "too long");
}

#[test]
fn equality() {
    check("1 = 1", b(true));
    check("1 = 2", b(false));
    check("1 != 2", b(true));
    check("1 <> 1", b(false));
    check("\"abc\" = \"abc\"", b(true));
    check("\"abc\" = \"ABC\"", b(false));
    check("\"5\" = 5", b(true));
    check("5 = \"5.0\"", b(true));
    check("\"x\" = 5", b(false));
    check("\"x\" != 5", b(true));
    check("TRUE() = 1", b(true));
    check("FALSE() = 0", b(true));
    check("BLANK() = 0", b(true));
    check("BLANK() = \"\"", b(true));
    check("BLANK() = BLANK()", b(true));
    check("BLANK() = \"a\"", b(false));
    check("0 = \"\"", b(true));
}

#[test]
fn ordering() {
    check("1 < 2", b(true));
    check("2 < 1", b(false));
    check("2 <= 2", b(true));
    check("3 >= 4", b(false));
    check("3 > -4", b(true));
    check("\"apple\" < \"banana\"", b(true));
    check("\"B\" < \"a\"", b(true));
    check("\"10\" > 9", b(true));
    check("\"abc\" < 5", b(false));
    check("\"abc\" > 5", b(false));
    check("BLANK() < 1", b(true));
    check("BLANK() < \"a\"", b(true));
}

#[test]
fn date_comparisons() {
    let c = with(&[
        ("A", date(2024, 1, 1)),
        ("B", dt("2024-01-01T00:00:00Z")),
        ("C", dt("2024-06-01T10:00:00Z")),
        ("Lookup", arr(vec![date(2024, 1, 1)])),
    ]);
    check_in("{A} = {B}", &c, b(true));
    check_in("{A} < {C}", &c, b(true));
    check_in("{C} > {A}", &c, b(true));
    check_in("{A} = \"2024-01-01\"", &c, b(true));
    check_in("{C} > \"2024-05-31\"", &c, b(true));
    check_in("{A} = \"not a date\"", &c, b(false));
    check_in("{A} = BLANK()", &c, b(false));
    check_in("{A} != BLANK()", &c, b(true));
    check_in("{A} < 5", &c, b(false));
    check_in("{Lookup} = {A}", &c, b(true));
}

#[test]
fn array_comparisons_use_text() {
    let c = with(&[
        ("Tags", arr(vec![t("a"), t("b")])),
        ("One", arr(vec![n(5.0)])),
    ]);
    check_in("{Tags} = \"a, b\"", &c, b(true));
    check_in("{One} = 5", &c, b(true));
}

#[test]
fn errors_propagate_through_operators() {
    check_err("ERROR() + 1", "#ERROR!");
    check_err("1 + ERROR()", "#ERROR!");
    check_err("-ERROR()", "#ERROR!");
    check_err("ERROR() & \"x\"", "#ERROR!");
    check_err("ERROR() = 1", "#ERROR!");
    check_err("(1/0) < 1", "Division by zero");
    check_err("UPPER(1/0)", "Division by zero");
    check_err("ROUND(1/0, 2) & \"\"", "Division by zero");
    // Left error wins.
    check(
        "(1/0) + ERROR()",
        Value::Error("#ERROR: Division by zero".into()),
    );
    let c = with(&[("Bad", Value::Error("#ERROR: upstream".into()))]);
    check_err_in("{Bad} * 2", &c, "upstream");
}

#[test]
fn format_number_has_no_trailing_zeros() {
    assert_eq!(format_number(3.0), "3");
    assert_eq!(format_number(1.5), "1.5");
    assert_eq!(format_number(-0.0), "0");
    assert_eq!(format_number(-12.25), "-12.25");
    assert_eq!(format_number(1e-7), "0.0000001");
    assert_eq!(format_number(123456789.0), "123456789");
}

#[test]
fn to_text_public_helper() {
    assert_eq!(to_text(&Value::Null).unwrap(), "");
    assert_eq!(to_text(&n(2.0)).unwrap(), "2");
    assert_eq!(
        to_text(&arr(vec![n(1.0), Value::Null, t("x")])).unwrap(),
        "1, , x"
    );
    assert!(to_text(&Value::Error("#ERROR!".into())).is_err());
}

#[test]
fn eval_hand_built_deep_tree_is_an_error_not_overflow() {
    use crate::formula::{Expr, eval};
    let mut e = Expr::Number(1.0);
    for _ in 0..2000 {
        e = Expr::Neg(Box::new(e));
    }
    let r = std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let v = eval(&e, &Ctx::default());
            // Drop iteratively-ish inside the big stack too.
            drop(e);
            v
        })
        .unwrap()
        .join()
        .unwrap();
    assert!(matches!(r, Value::Error(m) if m.contains("nested too deeply")));
}

#[test]
fn longest_allowed_chain_evaluates_on_a_small_stack() {
    let src = vec!["{A}"; crate::formula::MAX_EXPR_HEIGHT].join(" & ");
    let r = std::thread::Builder::new()
        .stack_size(1024 * 1024)
        .spawn(move || ev_in(&src, &with(&[("A", t("x"))])))
        .unwrap()
        .join()
        .unwrap();
    assert_eq!(r, t(&"x".repeat(crate::formula::MAX_EXPR_HEIGHT)));
}
