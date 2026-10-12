//! Search and row colouring.

use chrono_tz::Tz;
use serde_json::json;

use super::*;
use crate::field::Field;
use crate::query::{compile_row_color, matches_search, row_color, row_color_compiled};
use crate::view::{ColorRule, Conjunction, Filter, FilterOp, RowColor};

#[test]
fn search_over_display_text() {
    let t = table();
    let fields: Vec<&Field> = [
        "fldText", "fldNum", "fldSel", "fldLink", "fldDate", "fldCheck",
    ]
    .iter()
    .map(|id| &t[*id])
    .collect();
    let r = row(
        "r1",
        json!({"fldText": "Quarterly Report", "fldNum": 1234.5, "fldSel": "selBlue", "fldLink": ["recA"], "fldDate": "2026-10-12", "fldCheck": true}),
    );
    let s = |q: &str| matches_search(&r, &fields, q, &names(), Tz::UTC);
    assert!(s(""));
    assert!(s("   "));
    assert!(s("report"));
    assert!(s("  QUARTERLY  "));
    assert!(s("1234.50"), "numbers by display text");
    assert!(s("blue"), "selects by name, not id");
    assert!(!s("selBlue"));
    assert!(s("alpha"), "links by primary name");
    assert!(s("10/12/2026"), "dates by display text");
    assert!(s("checked"));
    assert!(!s("missing"));
    // Only the given (visible) fields are searched.
    let only_num = vec![&t["fldNum"]];
    assert!(!matches_search(&r, &only_num, "report", &names(), Tz::UTC));
    assert!(!matches_search(&r, &[], "report", &names(), Tz::UTC));
    assert!(matches_search(&r, &[], "", &names(), Tz::UTC));
}

#[test]
fn search_uses_viewer_zone_for_datetimes() {
    let t = table();
    let fields = vec![&t["fldDt"]];
    let r = row("r1", json!({"fldDt": "2026-10-12T23:30:00.000Z"}));
    assert!(matches_search(&r, &fields, "10/12/2026", &names(), Tz::UTC));
    assert!(matches_search(
        &r,
        &fields,
        "10/13/2026",
        &names(),
        "Pacific/Auckland".parse().unwrap()
    ));
}

#[test]
fn color_by_select() {
    let t = table();
    let config = RowColor::BySelect {
        field_id: "fldSel".into(),
    };
    let c = |cells| row_color(&config, &row("r", cells), &t, &qctx(), &names());
    assert_eq!(c(json!({"fldSel": "selGreen"})), Some("green".into()));
    assert_eq!(c(json!({"fldSel": "selDark"})), Some("red_dark".into()));
    assert_eq!(c(json!({})), None);
    assert_eq!(c(json!({"fldSel": "selGone"})), None);
    assert!(
        compile_row_color(
            &RowColor::BySelect {
                field_id: "fldMulti".into()
            },
            &t
        )
        .unwrap_err()
        .contains("single select")
    );
    assert!(
        compile_row_color(
            &RowColor::BySelect {
                field_id: "nope".into()
            },
            &t
        )
        .unwrap_err()
        .contains("unknown field")
    );
    let bad = RowColor::BySelect {
        field_id: "fldText".into(),
    };
    assert_eq!(
        row_color(
            &bad,
            &row("r", json!({"fldText": "x"})),
            &t,
            &qctx(),
            &names()
        ),
        None
    );
}

#[test]
fn color_by_conditions_first_match_wins() {
    let t = table();
    let rules = vec![
        ColorRule {
            color: "red".into(),
            filter: cond("fldNum", FilterOp::Gt, json!(100)),
        },
        ColorRule {
            color: "yellow".into(),
            filter: cond("fldNum", FilterOp::Gt, json!(10)),
        },
        ColorRule {
            color: "blue".into(),
            filter: cond("fldOwner", FilterOp::Is, json!("me")),
        },
    ];
    let config = RowColor::ByConditions { rules };
    let compiled = compile_row_color(&config, &t).unwrap();
    let c = |cells| row_color_compiled(&compiled, &row("r", cells), &qctx(), &names());
    assert_eq!(c(json!({"fldNum": 500})), Some("red".into()));
    assert_eq!(c(json!({"fldNum": 50})), Some("yellow".into()));
    assert_eq!(
        c(json!({"fldNum": 5, "fldOwner": ["usr1"]})),
        Some("blue".into())
    );
    assert_eq!(c(json!({"fldNum": 5})), None);
    assert_eq!(
        row_color(
            &config,
            &row("r", json!({"fldNum": 50})),
            &t,
            &qctx(),
            &names()
        ),
        Some("yellow".into())
    );
    // An empty rule filter is a catch-all default colour.
    let with_default = RowColor::ByConditions {
        rules: vec![
            ColorRule {
                color: "red".into(),
                filter: cond("fldNum", FilterOp::Gt, json!(100)),
            },
            ColorRule {
                color: "gray".into(),
                filter: Filter {
                    conjunction: Conjunction::And,
                    items: vec![],
                },
            },
        ],
    };
    assert_eq!(
        row_color(&with_default, &row("r", json!({})), &t, &qctx(), &names()),
        Some("gray".into())
    );
}

#[test]
fn color_rule_validation() {
    let t = table();
    let bad_color = RowColor::ByConditions {
        rules: vec![ColorRule {
            color: "chartreuse".into(),
            filter: Filter::default(),
        }],
    };
    assert!(
        compile_row_color(&bad_color, &t)
            .unwrap_err()
            .contains("unknown colour")
    );
    let bad_filter = RowColor::ByConditions {
        rules: vec![ColorRule {
            color: "red".into(),
            filter: cond("fldNope", FilterOp::Is, json!(1)),
        }],
    };
    assert!(
        compile_row_color(&bad_filter, &t)
            .unwrap_err()
            .contains("unknown field")
    );
    let too_many = RowColor::ByConditions {
        rules: (0..=crate::limits::MAX_FILTER_CONDITIONS)
            .map(|_| ColorRule {
                color: "red".into(),
                filter: Filter::default(),
            })
            .collect(),
    };
    assert!(
        compile_row_color(&too_many, &t)
            .unwrap_err()
            .contains("at most")
    );
}
