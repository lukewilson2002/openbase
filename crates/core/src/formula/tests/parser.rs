//! Lexer and parser: literals, references, precedence, errors, limits.

use crate::formula::{Expr, FormulaError, MAX_EXPR_HEIGHT, parse};
use crate::limits::{MAX_FORMULA_DEPTH, MAX_FORMULA_LEN};

/// Canonical fully-parenthesized rendering of a parsed formula.
fn canon(src: &str) -> String {
    parse(src)
        .unwrap_or_else(|e| panic!("parse failed for {src:?}: {e}"))
        .to_string()
}

fn perr(src: &str) -> FormulaError {
    match parse(src) {
        Err(e) => e,
        Ok(e) => panic!("expected parse error for {src:?}, got {e:?}"),
    }
}

#[test]
fn number_literals() {
    assert_eq!(parse("42").unwrap(), Expr::Number(42.0));
    assert_eq!(parse("3.25").unwrap(), Expr::Number(3.25));
    assert_eq!(parse(".5").unwrap(), Expr::Number(0.5));
    assert_eq!(parse("1.").unwrap(), Expr::Number(1.0));
    assert_eq!(parse("1e3").unwrap(), Expr::Number(1000.0));
    assert_eq!(parse("1.5E-3").unwrap(), Expr::Number(0.0015));
    assert_eq!(parse("2e+2").unwrap(), Expr::Number(200.0));
}

#[test]
fn number_errors() {
    assert!(perr("1e999").message.contains("too large"));
    // `1e` is a number followed by a bare identifier: two values in a row.
    let e = perr("1e");
    assert_eq!(e.pos, Some(1));
    assert!(perr(".").message.contains("'.'"));
}

#[test]
fn string_literals_and_escapes() {
    assert_eq!(parse("\"hi\"").unwrap(), Expr::Text("hi".into()));
    assert_eq!(parse("'hi'").unwrap(), Expr::Text("hi".into()));
    assert_eq!(parse(r#""a\nb""#).unwrap(), Expr::Text("a\nb".into()));
    assert_eq!(parse(r#""a\tb""#).unwrap(), Expr::Text("a\tb".into()));
    assert_eq!(
        parse(r#""say \"x\"""#).unwrap(),
        Expr::Text("say \"x\"".into())
    );
    assert_eq!(parse(r#"'it\'s'"#).unwrap(), Expr::Text("it's".into()));
    assert_eq!(
        parse(r#""back\\slash""#).unwrap(),
        Expr::Text("back\\slash".into())
    );
    assert_eq!(parse(r#"'"'"#).unwrap(), Expr::Text("\"".into()));
    assert_eq!(parse(r#""'""#).unwrap(), Expr::Text("'".into()));
    // Unknown escapes keep the backslash (regex patterns like "\d").
    assert_eq!(parse(r#""\d+""#).unwrap(), Expr::Text("\\d+".into()));
    // Literal newlines inside strings are fine.
    assert_eq!(parse("\"a\nb\"").unwrap(), Expr::Text("a\nb".into()));
    assert_eq!(parse("\"héllo ✓\"").unwrap(), Expr::Text("héllo ✓".into()));
}

#[test]
fn unterminated_string_reports_opening_position() {
    let e = perr("1 & \"abc");
    assert_eq!(e.pos, Some(4));
    assert!(e.message.contains("closing"));
    assert_eq!(perr("'abc\\'").pos, Some(0));
    assert_eq!(perr("\"abc\\").pos, Some(0));
}

#[test]
fn smart_quotes_get_a_helpful_error() {
    let e = perr("\u{201C}hi\u{201D}");
    assert_eq!(e.pos, Some(0));
    assert!(e.message.contains("straight quotes"));
}

#[test]
fn booleans() {
    assert_eq!(parse("TRUE").unwrap(), Expr::Bool(true));
    assert_eq!(parse("false").unwrap(), Expr::Bool(false));
    assert_eq!(canon("TRUE()"), "TRUE()");
    assert_eq!(canon("true()"), "TRUE()");
}

#[test]
fn braced_field_references() {
    match parse("{Unit Price}").unwrap() {
        Expr::Field { name, span } => {
            assert_eq!(name, "Unit Price");
            assert_eq!((span.start, span.end), (0, 12));
        }
        other => panic!("{other:?}"),
    }
    // Any character except an unescaped '}' is allowed.
    match parse("{a+b (c), \"d\" {e}").unwrap() {
        Expr::Field { name, .. } => assert_eq!(name, "a+b (c), \"d\" {e"),
        other => panic!("{other:?}"),
    }
    match parse(r"{a\}b}").unwrap() {
        Expr::Field { name, .. } => assert_eq!(name, "a}b"),
        other => panic!("{other:?}"),
    }
    match parse(r"{C:\\dir}").unwrap() {
        Expr::Field { name, .. } => assert_eq!(name, "C:\\dir"),
        other => panic!("{other:?}"),
    }
    match parse(r"{a\b}").unwrap() {
        Expr::Field { name, .. } => assert_eq!(name, "a\\b"),
        other => panic!("{other:?}"),
    }
    match parse("{Prix €}").unwrap() {
        Expr::Field { name, .. } => assert_eq!(name, "Prix €"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn field_reference_errors() {
    let e = perr("1 + {Price");
    assert_eq!(e.pos, Some(4));
    assert!(e.message.contains("'}'"));
    let e = perr("{}");
    assert_eq!(e.pos, Some(0));
    assert!(e.message.contains("Empty"));
    assert_eq!(perr(r"{abc\}").pos, Some(0));
}

#[test]
fn bare_identifiers_are_field_refs_unless_called() {
    match parse("Price").unwrap() {
        Expr::Field { name, span } => {
            assert_eq!(name, "Price");
            assert_eq!((span.start, span.end), (0, 5));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(canon("Price * Qty"), "({Price} * {Qty})");
    assert_eq!(canon("first_name"), "{first_name}");
    assert_eq!(canon("sum(1, 2)"), "SUM(1, 2)");
    assert_eq!(canon("Sum (1)"), "SUM(1)");
}

#[test]
fn values_is_reserved() {
    assert_eq!(parse("values").unwrap(), Expr::Values);
    assert_eq!(canon("SUM(values) * 2"), "(SUM(values) * 2)");
    // Only the exact lowercase word; braces always mean a field.
    assert!(matches!(parse("Values").unwrap(), Expr::Field { .. }));
    assert!(matches!(parse("{values}").unwrap(), Expr::Field { .. }));
}

#[test]
fn function_calls() {
    assert_eq!(canon("NOW()"), "NOW()");
    assert_eq!(canon("if(1, 2, 3)"), "IF(1, 2, 3)");
    assert_eq!(canon("Concatenate({a}, \"b\")"), "CONCATENATE({a}, \"b\")");
    assert_eq!(
        canon("IF(AND(1,2),SUM(1,2,3),'x')"),
        "IF(AND(1, 2), SUM(1, 2, 3), \"x\")"
    );
    match parse("  round(1)").unwrap() {
        Expr::Call { name, pos, args } => {
            assert_eq!(name, "ROUND");
            assert_eq!(pos, 2);
            assert_eq!(args.len(), 1);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn precedence_matches_airtable() {
    assert_eq!(canon("1 + 2 * 3"), "(1 + (2 * 3))");
    assert_eq!(canon("1 * 2 + 3"), "((1 * 2) + 3)");
    assert_eq!(canon("1 - 2 - 3"), "((1 - 2) - 3)");
    assert_eq!(canon("8 / 4 / 2"), "((8 / 4) / 2)");
    assert_eq!(canon("1 + 2 & 3 + 4"), "((1 + 2) & (3 + 4))");
    assert_eq!(canon("1 & 2 = 12"), "((1 & 2) = 12)");
    assert_eq!(canon("1 + 1 = 2"), "((1 + 1) = 2)");
    assert_eq!(canon("1 < 2 = TRUE"), "((1 < 2) = TRUE)");
    assert_eq!(canon("-2 * 3"), "(-2 * 3)");
    assert_eq!(canon("-{a} & {b}"), "(-{a} & {b})");
    assert_eq!(canon("2 * -3"), "(2 * -3)");
    assert_eq!(canon("--1"), "--1");
    assert_eq!(canon("(1 + 2) * 3"), "((1 + 2) * 3)");
    assert_eq!(canon("-(1 + 2)"), "-(1 + 2)");
    assert_eq!(canon("1 + 2 * 3 & 4 > 5"), "(((1 + (2 * 3)) & 4) > 5)");
}

#[test]
fn comparison_operators() {
    assert_eq!(canon("1 = 2"), "(1 = 2)");
    assert_eq!(canon("1 == 2"), "(1 = 2)");
    assert_eq!(canon("1 != 2"), "(1 != 2)");
    assert_eq!(canon("1 <> 2"), "(1 != 2)");
    assert_eq!(canon("1 < 2"), "(1 < 2)");
    assert_eq!(canon("1 > 2"), "(1 > 2)");
    assert_eq!(canon("1 <= 2"), "(1 <= 2)");
    assert_eq!(canon("1 >= 2"), "(1 >= 2)");
}

#[test]
fn whitespace_and_newlines_are_ignored() {
    assert_eq!(canon("\n IF(\n\t{a} ,\r\n 1\n)\n"), "IF({a}, 1)");
}

#[test]
fn syntax_errors_have_positions() {
    let e = perr("");
    assert_eq!(e.pos, Some(0));
    assert!(e.message.contains("empty"));
    assert_eq!(perr("   ").pos, Some(0));

    let e = perr("1 +");
    assert_eq!(e.pos, Some(3));
    assert!(e.message.contains("end of formula"));

    let e = perr("1 2");
    assert_eq!(e.pos, Some(2));
    assert!(e.message.contains("number 2"));

    let e = perr("(1 + 2");
    assert_eq!(e.pos, Some(6));
    assert!(e.message.contains("')'"), "{}", e.message);

    let e = perr("SUM(1, 2");
    assert_eq!(e.pos, Some(8));
    assert!(e.message.contains("SUM"));

    let e = perr("SUM(1,)");
    assert_eq!(e.pos, Some(6));

    let e = perr("SUM(1 2)");
    assert_eq!(e.pos, Some(6));

    let e = perr("1 ! 2");
    assert_eq!(e.pos, Some(2));
    assert!(e.message.contains("!="));

    let e = perr("1 # 2");
    assert_eq!(e.pos, Some(2));
    assert!(e.message.contains('#'));

    let e = perr(")");
    assert_eq!(e.pos, Some(0));

    let e = perr("1 + * 2");
    assert_eq!(e.pos, Some(4));

    let e = perr("{a} {b}");
    assert_eq!(e.pos, Some(4));
}

#[test]
fn error_display_includes_position() {
    let e = perr("1 +");
    assert_eq!(e.to_string(), format!("{} (at position 3)", e.message));
}

#[test]
fn positions_are_byte_offsets_with_unicode() {
    let e = perr("\"é\" 2");
    assert_eq!(e.pos, Some(5));
}

#[test]
fn length_limit() {
    let ok = format!("\"{}\"", "a".repeat(MAX_FORMULA_LEN - 2));
    assert!(parse(&ok).is_ok());
    let too_long = format!("\"{}\"", "a".repeat(MAX_FORMULA_LEN));
    let e = perr(&too_long);
    assert!(e.message.contains("too long"));
}

#[test]
fn nesting_limit() {
    let ok = format!(
        "{}1{}",
        "(".repeat(MAX_FORMULA_DEPTH),
        ")".repeat(MAX_FORMULA_DEPTH)
    );
    assert!(parse(&ok).is_ok());
    let deep = format!(
        "{}1{}",
        "(".repeat(MAX_FORMULA_DEPTH + 1),
        ")".repeat(MAX_FORMULA_DEPTH + 1)
    );
    assert!(perr(&deep).message.contains("nested too deeply"));

    let calls = format!(
        "{}1{}",
        "ABS(".repeat(MAX_FORMULA_DEPTH + 1),
        ")".repeat(MAX_FORMULA_DEPTH + 1)
    );
    assert!(perr(&calls).message.contains("nested too deeply"));

    let minus = format!("{}1", "-".repeat(MAX_FORMULA_DEPTH + 1));
    assert!(perr(&minus).message.contains("nested too deeply"));

    // Thousands of open parentheses must be an error, not a stack overflow.
    assert!(parse(&"(".repeat(5000)).is_err());
}

#[test]
fn operator_chain_limit() {
    let ok = vec!["1"; MAX_EXPR_HEIGHT].join("+");
    assert!(parse(&ok).is_ok());
    let long = vec!["1"; MAX_EXPR_HEIGHT + 2].join("+");
    assert!(perr(&long).message.contains("too complex"));
}

#[test]
fn display_round_trips() {
    for src in [
        "IF({a} > 1, \"big\\n\", 'small')",
        "-(1 + 2) * {x\\}y}",
        "SUM(values) / COUNT(values)",
        "1.5e-7 & \"\\\"q\\\"\"",
        "TRUE = FALSE()",
    ] {
        let once = canon(src);
        assert_eq!(canon(&once), once, "{src}");
    }
}
