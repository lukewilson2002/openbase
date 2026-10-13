//! Property tests: the parser and evaluator never panic, and reference
//! rewriting round-trips.

use proptest::prelude::*;

use super::support::*;
use crate::formula::{
    Expr, TypeEnv, escape_field_name, eval, function_names, infer_type, parse, to_display,
    to_storage,
};
use crate::value::{ResultType, Value};

struct AnyEnv;

impl TypeEnv for AnyEnv {
    fn field_type(&self, _: &str) -> Option<ResultType> {
        Some(ResultType::Text)
    }
    fn values_type(&self) -> Option<ResultType> {
        Some(ResultType::Number)
    }
}

/// Characters that make up formulas, so random strings often parse.
const FORMULA_CHARS: &str = "[ (){}\"'\\\\a-zA-Z0-9_,+*/&=<>!.\\-\n]{0,120}";

fn ctx_with_odd_values() -> Ctx {
    let mut c = with(&[
        ("a", n(1.5)),
        ("b", t("2024-03-15")),
        (
            "c",
            arr(vec![n(1.0), t("x"), Value::Null, date(2024, 1, 1)]),
        ),
        ("d", dt("2024-03-15T10:00:00Z")),
        ("e", Value::Error("#ERROR: field".into())),
        ("f", n(f64::NAN)),
        ("g", n(-1e308)),
        ("h", t("")),
    ]);
    c.values = arr(vec![n(1.0), n(2.0), Value::Null]);
    c
}

/// Random leaf expressions.
fn leaf() -> impl Strategy<Value = Expr> {
    prop_oneof![
        prop_oneof![
            Just(0.0),
            Just(-1.0),
            Just(1e300),
            Just(0.5),
            Just(1e15),
            any::<i32>().prop_map(f64::from),
        ]
        .prop_map(Expr::Number),
        prop_oneof![
            Just(String::new()),
            Just("2024-02-29".to_string()),
            Just("days".to_string()),
            Just("M".to_string()),
            Just("America/New_York".to_string()),
            Just("YYYY-MM-DD Do LLLL [x] X".to_string()),
            Just("(a+)+".to_string()),
            "[a-z0-9 ,%$.-]{0,12}",
        ]
        .prop_map(Expr::Text),
        any::<bool>().prop_map(Expr::Bool),
        Just(Expr::Values),
        prop::sample::select(vec!["a", "b", "c", "d", "e", "f", "g", "h", "missing"]).prop_map(
            |name| Expr::Field {
                name: name.to_string(),
                span: crate::formula::Span { start: 0, end: 0 },
            }
        ),
    ]
}

/// Random trees calling every registered function with 0–4 random arguments.
fn expr() -> impl Strategy<Value = Expr> {
    let names: Vec<&'static str> = function_names();
    leaf().prop_recursive(5, 48, 4, move |inner| {
        let names = names.clone();
        prop_oneof![
            (
                prop::sample::select(names),
                prop::collection::vec(inner.clone(), 0..4)
            )
                .prop_map(|(name, args)| Expr::Call {
                    name: name.to_string(),
                    args,
                    pos: 0,
                }),
            (
                prop::sample::select(vec![
                    crate::formula::BinOp::Add,
                    crate::formula::BinOp::Sub,
                    crate::formula::BinOp::Mul,
                    crate::formula::BinOp::Div,
                    crate::formula::BinOp::Concat,
                    crate::formula::BinOp::Eq,
                    crate::formula::BinOp::Lt,
                    crate::formula::BinOp::Ge,
                ]),
                inner.clone(),
                inner.clone()
            )
                .prop_map(|(op, l, r)| Expr::Binary {
                    op,
                    lhs: Box::new(l),
                    rhs: Box::new(r),
                }),
            inner.prop_map(|e| Expr::Neg(Box::new(e))),
        ]
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn parse_never_panics_on_arbitrary_text(s in ".{0,200}") {
        let _ = parse(&s);
    }

    #[test]
    fn parse_and_eval_never_panic_on_formula_like_text(s in FORMULA_CHARS) {
        if let Ok(e) = parse(&s) {
            let _ = infer_type(&e, &AnyEnv);
            let _ = eval(&e, &ctx_with_odd_values());
            let _ = to_display(&s, &|id: &str| Some(format!("N {id}")));
            // Printing then reparsing gives the same canonical form.
            let printed = e.to_string();
            let reparsed = parse(&printed).expect("canonical form parses");
            prop_assert_eq!(reparsed.to_string(), printed);
        }
    }

    #[test]
    fn errors_point_inside_the_source(s in FORMULA_CHARS) {
        if let Err(e) = parse(&s) {
            prop_assert!(e.pos.unwrap_or(0) <= s.len());
            prop_assert!(!e.message.is_empty());
        }
    }

    #[test]
    fn every_function_with_random_args_never_panics(e in expr()) {
        let c = ctx_with_odd_values();
        let v = eval(&e, &c);
        // Evaluation is deterministic.
        prop_assert_eq!(format!("{v:?}"), format!("{:?}", eval(&e, &c)));
        let _ = infer_type(&e, &AnyEnv);
        // Its canonical text parses (unless it exceeds the limits).
        let printed = e.to_string();
        if printed.len() < crate::limits::MAX_FORMULA_LEN {
            let reparsed = parse(&printed);
            prop_assert!(reparsed.is_ok(), "{printed}: {reparsed:?}");
        }
    }

    #[test]
    fn storage_round_trip(
        names in prop::collection::vec("[^\\x00]{1,12}", 1..5),
        ops in prop::collection::vec(prop::sample::select(vec![" + ", " & ", "*", " = ", ", "]), 4),
    ) {
        // Build `{n0} op {n1} ...` inside CONCATENATE so ", " is valid.
        let mut src = String::from("CONCATENATE(");
        for (i, name) in names.iter().enumerate() {
            if i > 0 {
                src.push_str(ops[i % ops.len()]);
            }
            src.push('{');
            src.push_str(&escape_field_name(name));
            src.push('}');
        }
        src.push(')');
        let id_of = |name: &str| {
            names.iter().position(|n| n == name).map(|i| format!("fld{i}"))
        };
        let name_of = |id: &str| {
            id.strip_prefix("fld")
                .and_then(|i| i.parse::<usize>().ok())
                .and_then(|i| names.get(i).cloned())
        };
        let stored = to_storage(&src, &id_of).expect("all names resolve");
        let refs = crate::formula::referenced_fields(&parse(&stored).expect("stored parses"));
        prop_assert!(refs.iter().all(|r| r.starts_with("fld")), "{:?}", refs);
        prop_assert_eq!(to_display(&stored, &name_of), src);
    }

    #[test]
    fn escaped_names_parse_back(name in "[^\\x00]{1,20}") {
        let src = format!("{{{}}}", escape_field_name(&name));
        match parse(&src) {
            Ok(Expr::Field { name: parsed, .. }) => prop_assert_eq!(parsed, name),
            other => prop_assert!(false, "{:?}", other),
        }
    }
}
