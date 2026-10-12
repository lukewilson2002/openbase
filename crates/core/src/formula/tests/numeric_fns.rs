//! Numeric functions.

use super::support::*;
use crate::value::Value;

#[test]
fn abs() {
    check("ABS(-3.5)", n(3.5));
    check("ABS(2)", n(2.0));
    check("ABS(BLANK())", n(0.0));
    check("ABS(\"-4\")", n(4.0));
    check_err("ABS(\"x\")", "as a number");
}

#[test]
fn round_ties_go_up() {
    check("ROUND(1.5)", n(2.0));
    check("ROUND(2.5)", n(3.0));
    check("ROUND(-2.5)", n(-2.0));
    check("ROUND(-2.6)", n(-3.0));
    check("ROUND(1.2345, 2)", n(1.23));
    check("ROUND(1.005, 2)", n(1.01));
    check("ROUND(1234.5678, -2)", n(1200.0));
    check("ROUND(5, 400)", n(5.0));
    check("ROUND(5, -400)", n(0.0));
    check("ROUND(BLANK(), 2)", n(0.0));
    check("ROUND(0.125, 2)", n(0.13));
}

#[test]
fn roundup_rounddown() {
    check("ROUNDUP(1.1)", n(2.0));
    check("ROUNDUP(-1.1)", n(-2.0));
    check("ROUNDUP(1.231, 2)", n(1.24));
    check("ROUNDUP(1234, -2)", n(1300.0));
    check("ROUNDUP(2, 0)", n(2.0));
    check("ROUNDDOWN(1.9)", n(1.0));
    check("ROUNDDOWN(-1.9)", n(-1.0));
    check("ROUNDDOWN(1.239, 2)", n(1.23));
    check("ROUNDDOWN(1299, -2)", n(1200.0));
}

#[test]
fn ceiling_floor() {
    check("CEILING(2.1)", n(3.0));
    check("CEILING(2.5, 2)", n(4.0));
    check("CEILING(-2.5, 2)", n(-2.0));
    check("CEILING(0.21, 0.1)", n(0.3));
    check("CEILING(7, 0)", n(0.0));
    check("FLOOR(2.9)", n(2.0));
    check("FLOOR(7, 5)", n(5.0));
    check("FLOOR(-2.5, 2)", n(-4.0));
    check("FLOOR(0.39, 0.1)", n(0.3));
}

#[test]
fn int() {
    check("INT(3.9)", n(3.0));
    check("INT(-3.1)", n(-4.0));
    check("INT(5)", n(5.0));
}

#[test]
fn even_odd() {
    check("EVEN(1.5)", n(2.0));
    check("EVEN(3)", n(4.0));
    check("EVEN(2)", n(2.0));
    check("EVEN(-1)", n(-2.0));
    check("EVEN(0)", n(0.0));
    check("ODD(1.5)", n(3.0));
    check("ODD(2)", n(3.0));
    check("ODD(3)", n(3.0));
    check("ODD(-1)", n(-1.0));
    check("ODD(-2.5)", n(-3.0));
    check("ODD(0)", n(1.0));
}

#[test]
fn exp_log_sqrt_power() {
    check_num("EXP(1)", std::f64::consts::E);
    check("EXP(0)", n(1.0));
    check_num("LOG(1000)", 3.0);
    check_num("LOG(8, 2)", 3.0);
    check_num("LOG(100, 10)", 2.0);
    check_err("LOG(0)", "greater than 0");
    check_err("LOG(-1)", "greater than 0");
    check_err("LOG(10, 1)", "base");
    check_err("LOG(10, 0)", "base");
    check("SQRT(16)", n(4.0));
    check("SQRT(0)", n(0.0));
    check_err("SQRT(-1)", "negative");
    check("POWER(2, 10)", n(1024.0));
    check("POWER(4, 0.5)", n(2.0));
    check("POWER(2, -1)", n(0.5));
    check_err("POWER(-8, 0.5)", "not a finite number");
    check_err("POWER(10, 400)", "not a finite number");
    check_err("EXP(1000)", "not a finite number");
}

#[test]
fn mod_keeps_sign_of_dividend() {
    check("MOD(7, 3)", n(1.0));
    check("MOD(-7, 3)", n(-1.0));
    check("MOD(7, -3)", n(1.0));
    check("MOD(7.5, 2)", n(1.5));
    check_err("MOD(5, 0)", "Division by zero");
}

#[test]
fn sum_average_varargs_and_arrays() {
    check("SUM(1, 2, 3)", n(6.0));
    check("SUM(1, \"2\", TRUE(), BLANK(), \"x\")", n(4.0));
    check("AVERAGE(1, 2, 3, 4)", n(2.5));
    check("AVERAGE(BLANK(), \"x\")", Value::Null);
    let c = Ctx {
        values: arr(vec![n(10.0), n(20.0), Value::Null, n(30.0)]),
        ..Ctx::default()
    };
    check_in("SUM(values)", &c, n(60.0));
    check_in("AVERAGE(values)", &c, n(20.0));
    check_in("SUM(values) * 1.5", &c, n(90.0));
    check_in("SUM(values, 5)", &c, n(65.0));
    let nested = with(&[("L", arr(vec![n(1.0), arr(vec![n(2.0), n(3.0)])]))]);
    check_in("SUM({L})", &nested, n(6.0));
    check("SUM(BLANK())", n(0.0));
    check_err("SUM(1, ERROR())", "#ERROR!");
    let bad = with(&[("L", arr(vec![n(1.0), Value::Error("#ERROR: x".into())]))]);
    check_err_in("SUM({L})", &bad, "x");
}

#[test]
fn max_min() {
    check("MAX(1, 5, 3)", n(5.0));
    check("MIN(4, -2, 9)", n(-2.0));
    check("MAX(\"7\", 3)", n(7.0));
    check("MAX(BLANK())", Value::Null);
    let c = Ctx {
        values: arr(vec![n(3.0), n(8.0), n(1.0)]),
        ..Ctx::default()
    };
    check_in("MAX(values)", &c, n(8.0));
    check_in("MIN(values)", &c, n(1.0));
    let dates = Ctx {
        values: arr(vec![date(2024, 5, 1), date(2023, 1, 1), date(2024, 12, 31)]),
        ..Ctx::default()
    };
    check_in("MAX(values)", &dates, date(2024, 12, 31));
    check_in("MIN(values)", &dates, date(2023, 1, 1));
    let mixed = with(&[("D", arr(vec![dt("2024-01-01T10:00:00Z"), date(2024, 1, 2)]))]);
    check_in("MAX({D})", &mixed, date(2024, 1, 2));
    check_in("MIN({D})", &mixed, dt("2024-01-01T10:00:00Z"));
}

#[test]
fn counts() {
    check("COUNT(1, 2, \"3\", BLANK(), TRUE())", n(2.0));
    check("COUNTA(1, \"a\", \"\", BLANK(), 0)", n(3.0));
    check("COUNTALL(1, \"a\", \"\", BLANK())", n(4.0));
    let c = Ctx {
        values: arr(vec![n(1.0), Value::Null, t("x"), t(""), n(2.0)]),
        ..Ctx::default()
    };
    check_in("COUNT(values)", &c, n(2.0));
    check_in("COUNTA(values)", &c, n(3.0));
    check_in("COUNTALL(values)", &c, n(5.0));
    let empty = Ctx {
        values: arr(vec![]),
        ..Ctx::default()
    };
    check_in("COUNTALL(values)", &empty, n(0.0));
    check_in("COUNT(values)", &empty, n(0.0));
    check_err("COUNT(ERROR())", "#ERROR!");
}

#[test]
fn value_parses_formatted_numbers() {
    check("VALUE(\"42\")", n(42.0));
    check("VALUE(\" -3.5 \")", n(-3.5));
    check("VALUE(\"$1,000.50\")", n(1000.5));
    check("VALUE(\"1,000.5 USD\")", n(1000.5));
    check("VALUE(\"50%\")", n(0.5));
    check("VALUE(\"(25)\")", n(-25.0));
    check("VALUE(\"1e3\")", n(1000.0));
    check("VALUE(7)", n(7.0));
    check("VALUE(\"\")", Value::Null);
    check("VALUE(BLANK())", Value::Null);
    check_err("VALUE(\"abc\")", "VALUE could not read");
    check_err("VALUE(\"three dollars\")", "VALUE could not read");
}
