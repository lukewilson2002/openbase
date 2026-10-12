//! Text functions. Positions and lengths count Unicode scalar values, and
//! positions are 1-based like Airtable's.

use super::{FnSpec, Imp, arg, int, num_arg, r_number, r_text, text_arg};
use crate::formula::coerce::{MAX_TEXT_BYTES, R, err, num, text, to_text, too_long};
use crate::formula::eval::Evaluator;
use crate::value::Value;

pub(crate) const SPECS: &[FnSpec] = &[
    FnSpec::new("CONCATENATE", 1, None, r_text, Imp::Eager(concatenate)),
    FnSpec::new(
        "ENCODE_URL_COMPONENT",
        1,
        Some(1),
        r_text,
        Imp::Eager(encode_url_component),
    ),
    FnSpec::new("FIND", 2, Some(3), r_number, Imp::Eager(find)),
    FnSpec::new("LEFT", 2, Some(2), r_text, Imp::Eager(left)),
    FnSpec::new("LEN", 1, Some(1), r_number, Imp::Eager(len)),
    FnSpec::new("LOWER", 1, Some(1), r_text, Imp::Eager(lower)),
    FnSpec::new("MID", 3, Some(3), r_text, Imp::Eager(mid)),
    FnSpec::new("REPLACE", 4, Some(4), r_text, Imp::Eager(replace)),
    FnSpec::new("REPT", 2, Some(2), r_text, Imp::Eager(rept)),
    FnSpec::new("RIGHT", 2, Some(2), r_text, Imp::Eager(right)),
    FnSpec::new("SEARCH", 2, Some(3), r_number, Imp::Eager(search)),
    FnSpec::new("SUBSTITUTE", 3, Some(4), r_text, Imp::Eager(substitute)),
    FnSpec::new("T", 1, Some(1), r_text, Imp::Eager(t)),
    FnSpec::new("TRIM", 1, Some(1), r_text, Imp::Eager(trim)),
    FnSpec::new("UPPER", 1, Some(1), r_text, Imp::Eager(upper)),
];

fn concatenate(a: &[Value], _: &Evaluator) -> R {
    let mut out = String::new();
    for v in a {
        out.push_str(&to_text(v)?);
        if out.len() > MAX_TEXT_BYTES {
            return Err(too_long());
        }
    }
    Ok(Value::Text(out))
}

/// Like JavaScript's `encodeURIComponent`.
fn encode_url_component(a: &[Value], _: &Evaluator) -> R {
    let s = text_arg(a, 0)?;
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    text(out)
}

/// Byte offset of the char at `char_idx` (or the end).
fn byte_at(s: &str, char_idx: usize) -> usize {
    s.char_indices()
        .nth(char_idx)
        .map(|(b, _)| b)
        .unwrap_or(s.len())
}

fn char_slice(s: &str, start: usize, count: usize) -> String {
    s.chars().skip(start).take(count).collect()
}

/// 1-based position of `needle` in `hay` at or after 1-based `start`.
fn position(needle: &str, hay: &str, start: f64) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let from = (int(start).max(1) - 1) as usize;
    let off = byte_at(hay, from);
    let found = hay[off..].find(needle)?;
    Some(hay[..off + found].chars().count() + 1)
}

/// `FIND(needle, haystack, [start])`: case-sensitive; 0 when not found.
fn find(a: &[Value], _: &Evaluator) -> R {
    let needle = text_arg(a, 0)?;
    let hay = text_arg(a, 1)?;
    let start = super::opt_num_arg(a, 2, 1.0)?;
    num(position(&needle, &hay, start).unwrap_or(0) as f64)
}

/// Lower-cases char by char so positions keep matching the original text.
fn fold(s: &str) -> String {
    s.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

/// `SEARCH(needle, haystack, [start])`: case-insensitive; blank when not found.
fn search(a: &[Value], _: &Evaluator) -> R {
    let needle = fold(&text_arg(a, 0)?);
    let hay = fold(&text_arg(a, 1)?);
    let start = super::opt_num_arg(a, 2, 1.0)?;
    match position(&needle, &hay, start) {
        Some(p) => num(p as f64),
        None => Ok(Value::Null),
    }
}

fn count_arg(a: &[Value], i: usize) -> R<usize> {
    Ok(int(num_arg(a, i)?).max(0) as usize)
}

fn left(a: &[Value], _: &Evaluator) -> R {
    let s = text_arg(a, 0)?;
    Ok(Value::Text(char_slice(&s, 0, count_arg(a, 1)?)))
}

fn right(a: &[Value], _: &Evaluator) -> R {
    let s = text_arg(a, 0)?;
    let n = count_arg(a, 1)?;
    let total = s.chars().count();
    Ok(Value::Text(char_slice(&s, total.saturating_sub(n), n)))
}

fn mid(a: &[Value], _: &Evaluator) -> R {
    let s = text_arg(a, 0)?;
    let start = (int(num_arg(a, 1)?).max(1) - 1) as usize;
    Ok(Value::Text(char_slice(&s, start, count_arg(a, 2)?)))
}

fn len(a: &[Value], _: &Evaluator) -> R {
    num(text_arg(a, 0)?.chars().count() as f64)
}

fn lower(a: &[Value], _: &Evaluator) -> R {
    text(text_arg(a, 0)?.to_lowercase())
}

fn upper(a: &[Value], _: &Evaluator) -> R {
    text(text_arg(a, 0)?.to_uppercase())
}

/// `REPLACE(text, start, count, replacement)`.
fn replace(a: &[Value], _: &Evaluator) -> R {
    let s = text_arg(a, 0)?;
    let start = (int(num_arg(a, 1)?).max(1) - 1) as usize;
    let count = count_arg(a, 2)?;
    let replacement = text_arg(a, 3)?;
    let from = byte_at(&s, start);
    let to = byte_at(&s, start.saturating_add(count));
    let mut out = String::with_capacity(s.len() + replacement.len());
    out.push_str(&s[..from]);
    out.push_str(&replacement);
    out.push_str(&s[to..]);
    text(out)
}

fn rept(a: &[Value], _: &Evaluator) -> R {
    let s = text_arg(a, 0)?;
    let n = count_arg(a, 1)?;
    match s.len().checked_mul(n) {
        Some(total) if total <= MAX_TEXT_BYTES => Ok(Value::Text(s.repeat(n))),
        _ => Err(too_long()),
    }
}

/// `SUBSTITUTE(text, old, new, [index])`: replaces every occurrence, or only
/// the `index`-th (1-based) when given.
fn substitute(a: &[Value], _: &Evaluator) -> R {
    let s = text_arg(a, 0)?;
    let old = text_arg(a, 1)?;
    let new = text_arg(a, 2)?;
    if old.is_empty() {
        return Ok(Value::Text(s));
    }
    if !matches!(arg(a, 3), Value::Null) {
        let index = int(num_arg(a, 3)?);
        if index < 1 {
            return Err(err("SUBSTITUTE index must be 1 or more"));
        }
        let Some((pos, _)) = s.match_indices(old.as_str()).nth((index - 1) as usize) else {
            return Ok(Value::Text(s));
        };
        let mut out = String::with_capacity(s.len() + new.len());
        out.push_str(&s[..pos]);
        out.push_str(&new);
        out.push_str(&s[pos + old.len()..]);
        return text(out);
    }
    let occurrences = s.matches(old.as_str()).count();
    let projected = occurrences
        .checked_mul(new.len())
        .and_then(|n| n.checked_add(s.len()));
    match projected {
        Some(n) if n <= MAX_TEXT_BYTES => Ok(Value::Text(s.replace(old.as_str(), &new))),
        _ => Err(too_long()),
    }
}

/// `T(value)`: the value if it is text, otherwise blank.
fn t(a: &[Value], _: &Evaluator) -> R {
    Ok(match arg(a, 0) {
        v @ Value::Text(_) => v.clone(),
        _ => Value::Null,
    })
}

fn trim(a: &[Value], _: &Evaluator) -> R {
    Ok(Value::Text(text_arg(a, 0)?.trim().to_string()))
}
