//! Evaluation cost budgets: a hostile formula must run out of budget and
//! return an error instead of burning CPU or memory without bound.

use super::support::*;

const BUDGET_MSG: &str = "too expensive";

/// `REGEX_MATCH("a", "\w{N}"&"")+...` with `count` terms; the pattern is
/// built at run time, so the save-time literal check does not see it.
fn regex_formula(distinct: bool, count: usize) -> String {
    (0..count)
        .map(|i| {
            let reps = if distinct { 60 + i } else { 99 };
            format!("REGEX_MATCH(\"a\", \"\\\\w{{{reps}}}\"&\"\")")
        })
        .collect::<Vec<_>>()
        .join("+")
}

#[test]
fn many_distinct_uncached_regex_compiles_run_out_of_budget() {
    // Every pattern is different, so none can come from the cache.
    check_err(&format!("0+{}", regex_formula(true, 300)), BUDGET_MSG);
}

#[test]
fn repeated_failing_regex_compile_is_cached() {
    // The same invalid pattern 300 times: after the first failure the rest
    // are cache hits, so the budget is not used up and the plain compile
    // error comes back (instead of "too expensive").
    check_err(
        &format!("0+{}", regex_formula(false, 300)),
        "Invalid regular expression",
    );
}

#[test]
fn memory_budget_stops_concatenate_of_many_large_arguments() {
    let args = vec!["REPT(\"aaaa\", 100000)"; 40].join(",");
    check_err(&format!("LEN(CONCATENATE({args}))"), BUDGET_MSG);
}

#[test]
fn memory_budget_applies_to_binary_operands() {
    // 40 held 400 KB operands via a right-nested `&` chain.
    let mut src = String::from("\"x\"");
    for _ in 0..40 {
        src = format!("REPT(\"aaaa\", 100000)&({src})");
    }
    check_err(&format!("LEN({src})"), BUDGET_MSG);
}

#[test]
fn modest_large_text_formulas_still_work() {
    check_num(
        "LEN(CONCATENATE(REPT(\"aaaa\", 20000), REPT(\"bb\", 20000), \"c\"))",
        120_001.0,
    );
}

#[test]
fn work_budget_stops_many_large_text_operations() {
    let term = "LEN(REPT(\"a\", 100000))";
    let src = vec![term; 400].join("+");
    check_err(&src, BUDGET_MSG);
}

#[test]
fn exhausted_budget_cannot_be_swallowed_by_iserror() {
    let term = "LEN(REPT(\"a\", 100000))";
    let heavy = vec![term; 400].join("+");
    check_err(
        &format!("IF(ISERROR({heavy}), \"fine\", \"fine\")"),
        BUDGET_MSG,
    );
}

#[test]
fn ordinary_formulas_are_unaffected() {
    check_num("LEN(UPPER(\"hello\")) + 2", 7.0);
    check("IF(ISERROR(1/0), \"div\", \"ok\")", t("div"));
}
