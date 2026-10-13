//! Type inference, save-time checks, `conform`, registry completeness,
//! volatility and the `Formula` convenience type.

use std::collections::HashMap;

use super::support::*;
use crate::formula::{
    Formula, FormulaError, TypeEnv, conform, function_names, infer_type, is_volatile, parse,
};
use crate::value::{ResultType, Value};

struct Env {
    fields: HashMap<&'static str, ResultType>,
    values: Option<ResultType>,
}

impl TypeEnv for Env {
    fn field_type(&self, field_id: &str) -> Option<ResultType> {
        self.fields.get(field_id).cloned()
    }
    fn values_type(&self) -> Option<ResultType> {
        self.values.clone()
    }
}

fn env() -> Env {
    Env {
        fields: [
            ("Name", ResultType::Text),
            ("Price", ResultType::Number),
            ("Done", ResultType::Bool),
            ("Due", ResultType::Date),
            ("At", ResultType::DateTime),
            ("Tags", ResultType::Array(Box::new(ResultType::Text))),
            ("Dates", ResultType::Array(Box::new(ResultType::Date))),
        ]
        .into(),
        values: None,
    }
}

fn ty(src: &str) -> ResultType {
    infer_type(&parse(src).unwrap(), &env()).unwrap_or_else(|e| panic!("{src}: {e}"))
}

fn ty_err(src: &str) -> FormulaError {
    match infer_type(&parse(src).unwrap(), &env()) {
        Err(e) => e,
        Ok(t) => panic!("{src}: expected type error, got {t:?}"),
    }
}

fn arr_of(t: ResultType) -> ResultType {
    ResultType::Array(Box::new(t))
}

#[test]
fn literal_and_operator_types() {
    assert_eq!(ty("1"), ResultType::Number);
    assert_eq!(ty("'a'"), ResultType::Text);
    assert_eq!(ty("TRUE"), ResultType::Bool);
    assert_eq!(ty("{Name} & 1"), ResultType::Text);
    assert_eq!(ty("{Name} + 1"), ResultType::Number);
    assert_eq!(ty("-{Name}"), ResultType::Number);
    assert_eq!(ty("{Price} > 2"), ResultType::Bool);
    assert_eq!(ty("{Price} * {Done}"), ResultType::Number);
}

#[test]
fn field_types_flow_through() {
    assert_eq!(ty("{Name}"), ResultType::Text);
    assert_eq!(ty("{Due}"), ResultType::Date);
    assert_eq!(ty("{Tags}"), arr_of(ResultType::Text));
}

#[test]
fn function_result_types() {
    assert_eq!(ty("UPPER({Price})"), ResultType::Text);
    assert_eq!(ty("LEN({Name})"), ResultType::Number);
    assert_eq!(ty("FIND('a', {Name})"), ResultType::Number);
    assert_eq!(ty("AND(1, 0)"), ResultType::Bool);
    assert_eq!(ty("ISERROR(1)"), ResultType::Bool);
    assert_eq!(ty("BLANK()"), ResultType::Text);
    assert_eq!(ty("ROUND({Price}, 2)"), ResultType::Number);
    assert_eq!(ty("NOW()"), ResultType::DateTime);
    assert_eq!(ty("TODAY()"), ResultType::Date);
    assert_eq!(ty("CREATED_TIME()"), ResultType::DateTime);
    assert_eq!(ty("DATETIME_PARSE('2024-01-01')"), ResultType::DateTime);
    assert_eq!(ty("DATETIME_FORMAT({At}, 'LL')"), ResultType::Text);
    assert_eq!(ty("DATETIME_DIFF({At}, {Due}, 'days')"), ResultType::Number);
    assert_eq!(ty("IS_BEFORE({At}, {Due})"), ResultType::Bool);
    assert_eq!(ty("WORKDAY({Due}, 3)"), ResultType::Date);
    assert_eq!(ty("YEAR({Due})"), ResultType::Number);
    assert_eq!(ty("TONOW({Due})"), ResultType::Text);
    assert_eq!(ty("RECORD_ID()"), ResultType::Text);
    assert_eq!(ty("REGEX_MATCH({Name}, 'a')"), ResultType::Bool);
    assert_eq!(ty("REGEX_REPLACE({Name}, 'a', 'b')"), ResultType::Text);
    assert_eq!(ty("ARRAYJOIN({Tags})"), ResultType::Text);
    assert_eq!(ty("ARRAYUNIQUE({Tags})"), arr_of(ResultType::Text));
    assert_eq!(ty("ARRAYSLICE({Dates}, 1, 2)"), arr_of(ResultType::Date));
    assert_eq!(ty("ARRAYCOMPACT({Name})"), arr_of(ResultType::Text));
    assert_eq!(
        ty("SET_TIMEZONE({At}, 'Europe/Paris')"),
        ResultType::DateTime
    );
    assert_eq!(ty("SET_LOCALE({Due}, 'fr')"), ResultType::Date);
}

#[test]
fn dateadd_type_depends_on_input_and_literal_unit() {
    assert_eq!(ty("DATEADD({Due}, 1, 'days')"), ResultType::Date);
    assert_eq!(ty("DATEADD({Due}, 1, 'hours')"), ResultType::DateTime);
    assert_eq!(ty("DATEADD({At}, 1, 'days')"), ResultType::DateTime);
    assert_eq!(ty("DATEADD({Due}, 1, {Name})"), ResultType::DateTime);
}

#[test]
fn branch_types_unify() {
    assert_eq!(ty("IF({Done}, 1, 2)"), ResultType::Number);
    assert_eq!(ty("IF({Done}, 1)"), ResultType::Number);
    assert_eq!(ty("IF({Done}, BLANK(), 'x')"), ResultType::Text);
    assert_eq!(ty("IF({Done}, 1, 'x')"), ResultType::Text);
    assert_eq!(ty("IF({Done}, {Due}, {At})"), ResultType::DateTime);
    assert_eq!(ty("IF({Done}, {Due}, BLANK())"), ResultType::Date);
    assert_eq!(ty("SWITCH({Name}, 'a', 1, 'b', 2)"), ResultType::Number);
    assert_eq!(ty("SWITCH({Name}, 'a', 1, 'b', 2, 'z')"), ResultType::Text);
    assert_eq!(ty("SWITCH({Name}, 'a', {Due}, {At})"), ResultType::DateTime);
}

#[test]
fn max_min_of_dates_are_dates() {
    assert_eq!(ty("MAX({Dates})"), ResultType::Date);
    assert_eq!(ty("MIN({Due}, {At})"), ResultType::DateTime);
    assert_eq!(ty("MAX(1, {Price})"), ResultType::Number);
}

#[test]
fn rollup_values_type() {
    let mut e = env();
    e.values = Some(ResultType::Number);
    let t = |src: &str| infer_type(&parse(src).unwrap(), &e).unwrap();
    assert_eq!(t("values"), arr_of(ResultType::Number));
    assert_eq!(t("SUM(values)"), ResultType::Number);
    assert_eq!(t("ARRAYUNIQUE(values)"), arr_of(ResultType::Number));
    e.values = Some(arr_of(ResultType::Date));
    let t = |src: &str| infer_type(&parse(src).unwrap(), &e).unwrap();
    assert_eq!(t("MAX(values)"), ResultType::Date);
    assert_eq!(t("ARRAYFLATTEN(values)"), arr_of(ResultType::Date));
}

#[test]
fn values_outside_rollup_is_an_error() {
    assert!(ty_err("SUM(values)").message.contains("rollup"));
}

#[test]
fn unknown_field_is_reported_with_position() {
    let e = ty_err("{Price} + {Nope}");
    assert!(e.message.contains("'Nope'"));
    assert_eq!(e.pos, Some(10));
}

#[test]
fn unknown_function_is_reported_with_position() {
    let e = ty_err("1 + FOO(2)");
    assert_eq!(e.message, "Unknown function FOO");
    assert_eq!(e.pos, Some(4));
    // Evaluation of an unknown function is an error value, not a panic.
    check_err("FOO(1)", "Unknown function FOO");
}

#[test]
fn wrong_argument_counts() {
    let e = ty_err("LEFT('a')");
    assert_eq!(e.message, "LEFT expects 2 arguments but got 1");
    assert_eq!(e.pos, Some(0));
    assert_eq!(
        ty_err("NOW(1)").message,
        "NOW expects 0 arguments but got 1"
    );
    assert_eq!(
        ty_err("ROUND(1, 2, 3)").message,
        "ROUND expects at most 2 arguments but got 3"
    );
    assert_eq!(
        ty_err("SUM()").message,
        "SUM expects at least 1 argument but got 0"
    );
    assert_eq!(
        ty_err("IF(1)").message,
        "IF expects at least 2 arguments but got 1"
    );
    assert_eq!(
        ty_err("SWITCH(1, 2)").message,
        "SWITCH expects at least 3 arguments but got 2"
    );
    // Nested errors are found too.
    let e = ty_err("IF(1, MID('a', 1), 2)");
    assert_eq!(e.pos, Some(6));
    // And evaluation agrees.
    check_err("LEFT(\"a\")", "LEFT expects 2 arguments");
}

#[test]
fn invalid_literals_are_save_time_errors() {
    let e = ty_err("SET_TIMEZONE({At}, 'Mars/Olympus')");
    assert!(
        e.message.contains("unknown timezone 'Mars/Olympus'"),
        "{}",
        e.message
    );
    assert!(
        ty_err("DATEADD({At}, 1, 'fortnights')")
            .message
            .contains("unknown unit")
    );
    assert!(
        ty_err("DATETIME_DIFF({At}, {Due}, 'eons')")
            .message
            .contains("unknown unit")
    );
    assert!(
        ty_err("IS_SAME({At}, {Due}, 'decade')")
            .message
            .contains("unknown unit")
    );
    assert!(
        ty_err("WEEKDAY({At}, 'Friday')")
            .message
            .contains("week start")
    );
    assert!(
        ty_err("REGEX_MATCH({Name}, '(')")
            .message
            .contains("Invalid regular expression")
    );
    assert!(
        ty_err("LAST_MODIFIED_TIME('x')")
            .message
            .contains("field references")
    );
    // Non-literal arguments are checked at evaluation time instead.
    assert_eq!(ty("SET_TIMEZONE({At}, {Name})"), ResultType::DateTime);
}

#[test]
fn types_are_lenient_where_airtable_coerces() {
    assert_eq!(ty("LEFT({Price}, '2')"), ResultType::Text);
    assert_eq!(ty("SUM({Name}, {Tags})"), ResultType::Number);
    assert_eq!(ty("DATETIME_FORMAT({Name}, 'LL')"), ResultType::Text);
}

#[test]
fn conform_converts_to_declared_type() {
    assert_eq!(conform(n(1.0), &ResultType::Text), t("1"));
    assert_eq!(conform(b(true), &ResultType::Number), n(1.0));
    assert_eq!(conform(t("2.5"), &ResultType::Number), n(2.5));
    assert!(conform(t("x"), &ResultType::Number).is_error());
    assert_eq!(conform(n(0.0), &ResultType::Bool), b(false));
    assert_eq!(
        conform(t("2024-01-02"), &ResultType::Date),
        date(2024, 1, 2)
    );
    assert_eq!(
        conform(dt("2024-01-02T23:00:00Z"), &ResultType::Date),
        date(2024, 1, 2)
    );
    assert_eq!(
        conform(date(2024, 1, 2), &ResultType::DateTime),
        dt("2024-01-02T00:00:00Z")
    );
    assert_eq!(
        conform(t("x"), &arr_of(ResultType::Text)),
        arr(vec![t("x")])
    );
    assert_eq!(
        conform(arr(vec![n(1.0), n(2.0)]), &arr_of(ResultType::Text)),
        arr(vec![t("1"), t("2")])
    );
    assert_eq!(conform(Value::Null, &ResultType::Number), Value::Null);
    let e = Value::Error("#ERROR!".into());
    assert_eq!(conform(e.clone(), &ResultType::Text), e);
    assert_eq!(conform(arr(vec![n(1.0)]), &ResultType::Text), t("1"));
}

#[test]
fn all_84_airtable_functions_exist() {
    let expected = [
        // Text (16)
        "ARRAYJOIN",
        "CONCATENATE",
        "ENCODE_URL_COMPONENT",
        "FIND",
        "LEFT",
        "LEN",
        "LOWER",
        "MID",
        "REPLACE",
        "REPT",
        "RIGHT",
        "SEARCH",
        "SUBSTITUTE",
        "T",
        "TRIM",
        "UPPER",
        // Logical (11)
        "AND",
        "BLANK",
        "ERROR",
        "FALSE",
        "IF",
        "ISERROR",
        "NOT",
        "OR",
        "SWITCH",
        "TRUE",
        "XOR",
        // Numeric (22)
        "ABS",
        "AVERAGE",
        "CEILING",
        "COUNT",
        "COUNTA",
        "COUNTALL",
        "EVEN",
        "EXP",
        "FLOOR",
        "INT",
        "LOG",
        "MAX",
        "MIN",
        "MOD",
        "ODD",
        "POWER",
        "ROUND",
        "ROUNDDOWN",
        "ROUNDUP",
        "SQRT",
        "SUM",
        "VALUE",
        // Date (27)
        "CREATED_TIME",
        "DATEADD",
        "DATESTR",
        "DATETIME_DIFF",
        "DATETIME_FORMAT",
        "DATETIME_PARSE",
        "DAY",
        "HOUR",
        "IS_AFTER",
        "IS_BEFORE",
        "IS_SAME",
        "LAST_MODIFIED_TIME",
        "MINUTE",
        "MONTH",
        "NOW",
        "SECOND",
        "SET_LOCALE",
        "SET_TIMEZONE",
        "TIMESTR",
        "TONOW",
        "FROMNOW",
        "TODAY",
        "WEEKDAY",
        "WEEKNUM",
        "WORKDAY",
        "WORKDAY_DIFF",
        "YEAR",
        // Array (ARRAYJOIN counted above)
        "ARRAYCOMPACT",
        "ARRAYFLATTEN",
        "ARRAYSLICE",
        "ARRAYUNIQUE",
        // Record (the other two counted above)
        "RECORD_ID",
        // Regex
        "REGEX_MATCH",
        "REGEX_EXTRACT",
        "REGEX_REPLACE",
    ];
    assert_eq!(expected.len(), 84);
    let names = function_names();
    for f in expected {
        assert!(names.contains(&f), "missing function {f}");
    }
    assert_eq!(names.len(), 84);
    assert_eq!(
        crate::formula::functions::spec_count(),
        84,
        "duplicate specs"
    );
}

#[test]
fn volatility() {
    for src in [
        "NOW()",
        "TODAY()",
        "TONOW({Due})",
        "FROMNOW({Due})",
        "IF(1, DATETIME_FORMAT(NOW(), 'LL'))",
    ] {
        assert!(is_volatile(&parse(src).unwrap()), "{src}");
    }
    for src in [
        "1 + 2",
        "CREATED_TIME()",
        "DATEADD({Due}, 1, 'day')",
        "{NOW}",
    ] {
        assert!(!is_volatile(&parse(src).unwrap()), "{src}");
    }
}

#[test]
fn formula_struct() {
    let f = Formula::parse("IF({Done}, {Price} * 2, 'n/a')").unwrap();
    assert!(!f.volatile);
    assert_eq!(f.referenced_fields(), vec!["Done", "Price"]);
    assert_eq!(f.infer_type(&env()).unwrap(), ResultType::Text);
    let c = with(&[("Done", b(true)), ("Price", n(4.0))]);
    assert_eq!(f.eval(&c), n(8.0));
    assert_eq!(f.eval_as(&c, &ResultType::Text), t("8"));
    assert!(Formula::parse("NOW()").unwrap().volatile);
    assert!(Formula::parse("1 +").is_err());
}
