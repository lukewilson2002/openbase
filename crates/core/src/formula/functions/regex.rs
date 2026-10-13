//! Regular expression functions using the `regex` crate (RE2 syntax,
//! linear-time matching, so no catastrophic backtracking). Compiled
//! patterns are size-limited and cached per thread.

use std::cell::RefCell;
use std::collections::HashMap;

use regex::{Regex, RegexBuilder};

use super::{FnSpec, Imp, literal_text, r_bool, r_text, text_arg};
use crate::formula::ast::Expr;
use crate::formula::coerce::{MAX_TEXT_BYTES, R, err, too_long};
use crate::formula::eval::Evaluator;
use crate::formula::types::Ty;
use crate::value::Value;

const MAX_PATTERN_LEN: usize = 2_000;
const REGEX_SIZE_LIMIT: usize = 1 << 20;
const CACHE_SIZE: usize = 64;

pub(crate) const SPECS: &[FnSpec] = &[
    FnSpec::new(
        "REGEX_EXTRACT",
        2,
        Some(2),
        r_regex_text,
        Imp::Eager(regex_extract),
    ),
    FnSpec::new(
        "REGEX_MATCH",
        2,
        Some(2),
        r_regex_bool,
        Imp::Eager(regex_match),
    ),
    FnSpec::new(
        "REGEX_REPLACE",
        3,
        Some(3),
        r_regex_text,
        Imp::Eager(regex_replace),
    ),
];

/// Save-time check of a literal pattern.
fn check_literal(args: &[Expr]) -> Result<(), String> {
    match literal_text(args.get(1)) {
        Some(p) => compile(p).map(|_| ()).map_err(|e| match e {
            Value::Error(m) => m.trim_start_matches("#ERROR: ").to_string(),
            _ => "invalid regular expression".into(),
        }),
        None => Ok(()),
    }
}

fn r_regex_text(tys: &[Ty], args: &[Expr]) -> Result<Ty, String> {
    check_literal(args)?;
    r_text(tys, args)
}

fn r_regex_bool(tys: &[Ty], args: &[Expr]) -> Result<Ty, String> {
    check_literal(args)?;
    r_bool(tys, args)
}

/// Compiles (or fetches from the per-thread cache) a pattern.
fn compile(pattern: &str) -> R<Regex> {
    thread_local! {
        static CACHE: RefCell<HashMap<String, Regex>> = RefCell::new(HashMap::new());
    }
    if pattern.len() > MAX_PATTERN_LEN {
        return Err(err(format!(
            "Regular expression is too long (maximum {MAX_PATTERN_LEN} characters)"
        )));
    }
    if let Some(re) = CACHE.with(|c| c.borrow().get(pattern).cloned()) {
        return Ok(re);
    }
    let re = RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_SIZE_LIMIT)
        .build()
        .map_err(|e| {
            let msg = e.to_string();
            let last = msg.lines().last().unwrap_or("").trim();
            let last = last.strip_prefix("error: ").unwrap_or(last);
            err(format!("Invalid regular expression: {last}"))
        })?;
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() >= CACHE_SIZE {
            c.clear();
        }
        c.insert(pattern.to_string(), re.clone());
    });
    Ok(re)
}

/// `REGEX_MATCH(text, regex)`: true if the pattern matches anywhere.
fn regex_match(a: &[Value], _: &Evaluator) -> R {
    let s = text_arg(a, 0)?;
    let re = compile(&text_arg(a, 1)?)?;
    Ok(Value::Bool(re.is_match(&s)))
}

/// `REGEX_EXTRACT(text, regex)`: the first match, or blank if none.
fn regex_extract(a: &[Value], _: &Evaluator) -> R {
    let s = text_arg(a, 0)?;
    let re = compile(&text_arg(a, 1)?)?;
    Ok(re
        .find(&s)
        .map(|m| Value::Text(m.as_str().to_string()))
        .unwrap_or(Value::Null))
}

/// `REGEX_REPLACE(text, regex, replacement)`: replaces every match;
/// `$1` / `${name}` in the replacement refer to capture groups.
fn regex_replace(a: &[Value], _: &Evaluator) -> R {
    let s = text_arg(a, 0)?;
    let re = compile(&text_arg(a, 1)?)?;
    let replacement = text_arg(a, 2)?;
    let mut out = String::with_capacity(s.len());
    let mut last = 0;
    for caps in re.captures_iter(&s) {
        let Some(m) = caps.get(0) else { continue };
        out.push_str(&s[last..m.start()]);
        caps.expand(&replacement, &mut out);
        last = m.end();
        if out.len() > MAX_TEXT_BYTES {
            return Err(too_long());
        }
    }
    out.push_str(&s[last..]);
    if out.len() > MAX_TEXT_BYTES {
        return Err(too_long());
    }
    Ok(Value::Text(out))
}
