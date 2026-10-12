//! Filter compilation (operator × type matrix, validation) and evaluation.

use serde_json::{Value as Json, json};

use super::*;
use crate::cell::tests::fixtures::sample_field;
use crate::limits::{MAX_FILTER_CONDITIONS, MAX_FILTER_DEPTH};
use crate::query::{CompiledFilter, compile_filter, filter_ops_for, matches};
use crate::view::{Condition, Conjunction, Filter, FilterItem, FilterOp};

const ALL_OPS: [FilterOp; 23] = [
    FilterOp::Is,
    FilterOp::IsNot,
    FilterOp::IsEmpty,
    FilterOp::IsNotEmpty,
    FilterOp::Contains,
    FilterOp::DoesNotContain,
    FilterOp::StartsWith,
    FilterOp::EndsWith,
    FilterOp::Lt,
    FilterOp::Lte,
    FilterOp::Gt,
    FilterOp::Gte,
    FilterOp::IsAnyOf,
    FilterOp::IsNoneOf,
    FilterOp::HasAnyOf,
    FilterOp::HasAllOf,
    FilterOp::HasNoneOf,
    FilterOp::IsExactly,
    FilterOp::IsBefore,
    FilterOp::IsAfter,
    FilterOp::IsOnOrBefore,
    FilterOp::IsOnOrAfter,
    FilterOp::IsWithin,
];

/// Evaluate a one-condition filter on a row of the fixture table.
fn m(field: &str, op: FilterOp, value: Json, cells: Json) -> bool {
    let f = compile_filter(&cond(field, op, value.clone()), &table())
        .unwrap_or_else(|e| panic!("{field} {op:?} {value}: {e}"));
    matches(&f, &row("rec1", cells), &qctx(), &names())
}

fn compile_err(field: &str, op: FilterOp, value: Json) -> String {
    compile_filter(&cond(field, op, value.clone()), &table())
        .expect_err(&format!("{field} {op:?} {value} should not compile"))
}

/// A well-formed operand for `op` on a field of type `t`.
fn operand(t: FieldType, op: FilterOp) -> Json {
    use FilterOp::*;
    match op {
        IsEmpty | IsNotEmpty => Json::Null,
        IsWithin => json!({"mode": "past_week"}),
        IsBefore | IsAfter | IsOnOrBefore | IsOnOrAfter => json!({"mode": "today"}),
        Lt | Lte | Gt | Gte => json!(1),
        Contains | DoesNotContain | StartsWith | EndsWith => json!("a"),
        IsAnyOf | IsNoneOf | HasAnyOf | HasAllOf | HasNoneOf | IsExactly => json!(["x"]),
        Is | IsNot => {
            let field = sample_field(t);
            match crate::query::kind_of(&field) {
                crate::query::Kind::Number => json!(1),
                crate::query::Kind::Bool => json!(true),
                crate::query::Kind::Date => json!({"mode": "today"}),
                _ => json!("x"),
            }
        }
    }
}

#[test]
fn operator_matrix_every_type_and_operator() {
    let mut checked = 0;
    for t in FieldType::ALL {
        let mut f = sample_field(t);
        f.id = "fldM".into();
        let fields = vec![f.clone()];
        let allowed = filter_ops_for(&f);
        for op in ALL_OPS {
            let filter = cond("fldM", op, operand(t, op));
            let result = compile_filter(&filter, &fields);
            if allowed.contains(&op) {
                let compiled = result.unwrap_or_else(|e| panic!("{t:?} {op:?}: {e}"));
                // Evaluating against empty and sample rows never panics.
                let _ = matches(&compiled, &row("r", json!({})), &qctx(), &names());
                for v in crate::cell::tests::fixtures::sample_values(t) {
                    let _ = matches(&compiled, &row("r", json!({"fldM": v})), &qctx(), &names());
                }
            } else {
                let e = result.expect_err(&format!("{t:?} {op:?} should be rejected"));
                assert!(e.contains("not available"), "{t:?} {op:?}: {e}");
            }
            checked += 1;
        }
    }
    assert_eq!(checked, 28 * ALL_OPS.len());
}

#[test]
fn operator_lists_per_type() {
    use FilterOp::*;
    let ops = |t| filter_ops_for(&sample_field(t));
    let text = vec![
        Contains,
        DoesNotContain,
        Is,
        IsNot,
        StartsWith,
        EndsWith,
        IsEmpty,
        IsNotEmpty,
    ];
    for t in [
        FieldType::SingleLineText,
        FieldType::LongText,
        FieldType::Email,
        FieldType::Url,
        FieldType::Phone,
        FieldType::Barcode,
    ] {
        assert_eq!(ops(t), text, "{t:?}");
    }
    let num = vec![Is, IsNot, Lt, Lte, Gt, Gte, IsEmpty, IsNotEmpty];
    for t in [
        FieldType::Number,
        FieldType::Currency,
        FieldType::Percent,
        FieldType::Duration,
        FieldType::Rating,
        FieldType::Autonumber,
        FieldType::Count,
        FieldType::Formula,
        FieldType::Rollup,
    ] {
        assert_eq!(ops(t), num, "{t:?}");
    }
    assert_eq!(ops(FieldType::Checkbox), vec![Is]);
    assert_eq!(
        ops(FieldType::SingleSelect),
        vec![Is, IsNot, IsAnyOf, IsNoneOf, IsEmpty, IsNotEmpty]
    );
    assert_eq!(
        ops(FieldType::CreatedBy),
        vec![Is, IsNot, IsAnyOf, IsNoneOf, IsEmpty, IsNotEmpty]
    );
    assert_eq!(
        ops(FieldType::LastModifiedBy),
        vec![Is, IsNot, IsAnyOf, IsNoneOf, IsEmpty, IsNotEmpty]
    );
    let multi = vec![
        HasAnyOf, HasAllOf, HasNoneOf, IsExactly, IsEmpty, IsNotEmpty,
    ];
    assert_eq!(ops(FieldType::MultipleSelect), multi);
    assert_eq!(ops(FieldType::User), multi, "sample user field is multiple");
    let date = vec![
        Is,
        IsNot,
        IsBefore,
        IsAfter,
        IsOnOrBefore,
        IsOnOrAfter,
        IsWithin,
        IsEmpty,
        IsNotEmpty,
    ];
    for t in [
        FieldType::Date,
        FieldType::CreatedTime,
        FieldType::LastModifiedTime,
    ] {
        assert_eq!(ops(t), date, "{t:?}");
    }
    assert_eq!(
        ops(FieldType::Attachment),
        vec![Contains, DoesNotContain, IsEmpty, IsNotEmpty]
    );
    let link = vec![
        Contains,
        DoesNotContain,
        HasAnyOf,
        HasAllOf,
        HasNoneOf,
        IsExactly,
        IsEmpty,
        IsNotEmpty,
    ];
    assert_eq!(ops(FieldType::Link), link);
    assert_eq!(ops(FieldType::Lookup), link);
    assert!(ops(FieldType::Button).is_empty());
    let t = table();
    assert_eq!(filter_ops_for(&t["fldFBool"]), vec![Is]);
    assert_eq!(filter_ops_for(&t["fldFDate"]), date);
    assert_eq!(filter_ops_for(&t["fldFText"]), text);
}

#[test]
fn text_operators() {
    use FilterOp::*;
    let cell = json!({"fldText": "Hello World"});
    assert!(
        m("fldText", Contains, json!("WORLD"), cell.clone()),
        "contains is case-insensitive"
    );
    assert!(!m("fldText", Contains, json!("planet"), cell.clone()));
    assert!(m("fldText", DoesNotContain, json!("planet"), cell.clone()));
    assert!(!m("fldText", DoesNotContain, json!("hello"), cell.clone()));
    assert!(
        m("fldText", DoesNotContain, json!("x"), json!({})),
        "empty cells don't contain"
    );
    assert!(!m("fldText", Contains, json!("x"), json!({})));
    assert!(m("fldText", StartsWith, json!("hello"), cell.clone()));
    assert!(!m("fldText", StartsWith, json!("world"), cell.clone()));
    assert!(m("fldText", EndsWith, json!("WORLD"), cell.clone()));
    assert!(m("fldText", Is, json!("Hello World"), cell.clone()));
    assert!(
        !m("fldText", Is, json!("hello world"), cell.clone()),
        "is is exact"
    );
    assert!(m("fldText", IsNot, json!("hello world"), cell.clone()));
    assert!(
        m("fldText", IsNot, json!("x"), json!({})),
        "is not matches empty"
    );
    assert!(!m("fldText", Is, json!("x"), json!({})));
    assert!(m("fldText", IsEmpty, Json::Null, json!({})));
    assert!(m("fldText", IsEmpty, Json::Null, json!({"fldText": ""})));
    assert!(!m("fldText", IsEmpty, Json::Null, cell.clone()));
    assert!(m("fldText", IsNotEmpty, json!("ignored"), cell.clone()));
    assert!(
        m(
            "fldText",
            Contains,
            json!(42),
            json!({"fldText": "order 42"})
        ),
        "numeric operand"
    );
    assert!(m(
        "fldLong",
        Contains,
        json!("second"),
        json!({"fldLong": "first\nsecond"})
    ));
    assert!(m(
        "fldEmail",
        EndsWith,
        json!("@example.com"),
        json!({"fldEmail": "ada@EXAMPLE.com"})
    ));
    assert!(
        m(
            "fldText",
            Contains,
            json!("ÉCOLE"),
            json!({"fldText": "une école"})
        ),
        "unicode case folding"
    );
}

#[test]
fn empty_operands_are_ignored() {
    use FilterOp::*;
    let any_row = json!({"fldText": "abc"});
    for (field, op, v) in [
        ("fldText", Contains, json!("")),
        ("fldText", Is, Json::Null),
        ("fldNum", Gt, json!("")),
        ("fldNum", Lt, Json::Null),
        ("fldSel", Is, json!("")),
        ("fldSel", IsAnyOf, json!([])),
        ("fldMulti", HasAnyOf, json!([])),
        ("fldMulti", HasAllOf, json!(["", " "])),
        ("fldDate", Is, Json::Null),
        ("fldDate", Is, json!({"mode": "exact_date", "date": ""})),
        ("fldDate", IsWithin, json!("")),
        ("fldCheck", Is, Json::Null),
        ("fldLink", Contains, json!("")),
        ("fldUsers", HasAnyOf, Json::Null),
    ] {
        let f = compile_filter(&cond(field, op, v.clone()), &table()).unwrap();
        assert!(f.is_trivial(), "{field} {op:?} {v}");
        assert!(matches(&f, &row("r", any_row.clone()), &qctx(), &names()));
        assert!(matches(&f, &row("r", json!({})), &qctx(), &names()));
    }
}

#[test]
fn ignored_condition_does_not_satisfy_an_or_group() {
    let filter = Filter {
        conjunction: Conjunction::Or,
        items: vec![
            FilterItem::Condition(Condition {
                field_id: "fldText".into(),
                op: FilterOp::Contains,
                value: json!(""),
            }),
            FilterItem::Condition(Condition {
                field_id: "fldNum".into(),
                op: FilterOp::Gt,
                value: json!(5),
            }),
        ],
    };
    let f = compile_filter(&filter, &table()).unwrap();
    assert!(!f.is_trivial());
    assert!(!matches(
        &f,
        &row("r", json!({"fldNum": 1})),
        &qctx(),
        &names()
    ));
    assert!(matches(
        &f,
        &row("r", json!({"fldNum": 6})),
        &qctx(),
        &names()
    ));
    assert_eq!(f.field_ids(), vec!["fldNum"]);
}

#[test]
fn number_operators() {
    use FilterOp::*;
    let c = |n: Json| json!({ "fldNum": n });
    assert!(m("fldNum", Is, json!(5), c(json!(5))));
    assert!(
        m("fldNum", Is, json!(0.3), c(json!(0.1 + 0.2))),
        "float tolerance"
    );
    assert!(!m("fldNum", Is, json!(5), c(json!(5.01))));
    assert!(m("fldNum", IsNot, json!(5), c(json!(6))));
    assert!(
        m("fldNum", IsNot, json!(5), json!({})),
        "is not matches empty"
    );
    assert!(!m("fldNum", Is, json!(0), json!({})), "empty is not zero");
    assert!(m("fldNum", Lt, json!(5), c(json!(4.99))));
    assert!(!m("fldNum", Lt, json!(5), c(json!(5))));
    assert!(m("fldNum", Lte, json!(5), c(json!(5))));
    assert!(m("fldNum", Gt, json!(-1), c(json!(0))));
    assert!(!m("fldNum", Gt, json!(5), c(json!(5))));
    assert!(m("fldNum", Gte, json!(5), c(json!(5))));
    for op in [Lt, Lte, Gt, Gte] {
        assert!(
            !m("fldNum", op, json!(0), json!({})),
            "{op:?} never matches empty"
        );
    }
    assert!(
        m("fldNum", Gt, json!("1,000"), c(json!(1500))),
        "numeric string operand"
    );
    assert!(m("fldNum", IsEmpty, Json::Null, json!({})));
    assert!(
        !m("fldNum", IsEmpty, Json::Null, c(json!(0))),
        "zero is not empty"
    );
    // Percent operands are fractions like the stored value.
    assert!(m("fldPct", Gte, json!(0.5), json!({"fldPct": 0.75})));
    assert!(m("fldDur", Gt, json!(3600), json!({"fldDur": 5400})));
    assert!(m("fldRating", Is, json!(3), json!({"fldRating": 3})));
    assert!(m("fldCount", Is, json!(2), json!({"fldCount": 2})));
    assert!(m("fldAuto", Lte, json!(10), json!({"fldAuto": 7})));
    assert!(m("fldFNum", Gt, json!(10), json!({"fldFNum": 84})));
    assert!(
        !m(
            "fldFNum",
            Gt,
            json!(10),
            json!({"fldFNum": {"error": "#ERROR"}})
        ),
        "errors never compare"
    );
    assert!(m(
        "fldFNum",
        IsNot,
        json!(10),
        json!({"fldFNum": {"error": "#ERROR"}})
    ));
    assert!(
        !m(
            "fldFNum",
            IsEmpty,
            Json::Null,
            json!({"fldFNum": {"error": "#ERROR"}})
        ),
        "errors are not empty"
    );
}

#[test]
fn checkbox_and_bool() {
    use FilterOp::*;
    assert!(m("fldCheck", Is, json!(true), json!({"fldCheck": true})));
    assert!(!m("fldCheck", Is, json!(true), json!({})));
    assert!(m("fldCheck", Is, json!(false), json!({})));
    assert!(!m("fldCheck", Is, json!(false), json!({"fldCheck": true})));
    assert!(m("fldCheck", Is, json!("true"), json!({"fldCheck": true})));
    assert!(m("fldFBool", Is, json!(true), json!({"fldFBool": true})));
    assert!(m("fldFBool", Is, json!(false), json!({"fldFBool": false})));
    assert!(m("fldFBool", Is, json!(false), json!({})));
    assert!(compile_err("fldCheck", Is, json!("yes")).contains("true or false"));
}

#[test]
fn single_select_operators() {
    use FilterOp::*;
    let red = json!({"fldSel": "selRed"});
    assert!(m("fldSel", Is, json!("selRed"), red.clone()));
    assert!(!m("fldSel", Is, json!("selBlue"), red.clone()));
    assert!(m("fldSel", IsNot, json!("selBlue"), red.clone()));
    assert!(
        m("fldSel", IsNot, json!("selBlue"), json!({})),
        "is not matches empty"
    );
    assert!(m(
        "fldSel",
        IsAnyOf,
        json!(["selBlue", "selRed"]),
        red.clone()
    ));
    assert!(!m("fldSel", IsAnyOf, json!(["selBlue"]), red.clone()));
    assert!(!m("fldSel", IsAnyOf, json!(["selBlue"]), json!({})));
    assert!(m("fldSel", IsNoneOf, json!(["selBlue"]), red.clone()));
    assert!(!m("fldSel", IsNoneOf, json!(["selRed"]), red.clone()));
    assert!(m("fldSel", IsNoneOf, json!(["selRed"]), json!({})));
    assert!(
        m("fldSel", Is, json!(["selRed"]), red.clone()),
        "one-element array accepted"
    );
    assert!(
        !m("fldSel", Is, json!("selDeleted"), red.clone()),
        "unknown ids compile but never match"
    );
    assert!(compile_err("fldSel", Is, json!(["selRed", "selBlue"])).contains("single value"));
    assert!(compile_err("fldSel", IsAnyOf, json!([1])).contains("list of ids"));
    assert!(compile_err("fldSel", Is, json!({"id": "selRed"})).contains("list of ids"));
}

#[test]
fn multi_valued_operators() {
    use FilterOp::*;
    let rb = json!({"fldMulti": ["selRed", "selBlue"]});
    assert!(m(
        "fldMulti",
        HasAnyOf,
        json!(["selBlue", "selGreen"]),
        rb.clone()
    ));
    assert!(!m("fldMulti", HasAnyOf, json!(["selGreen"]), rb.clone()));
    assert!(m(
        "fldMulti",
        HasAllOf,
        json!(["selBlue", "selRed"]),
        rb.clone()
    ));
    assert!(!m(
        "fldMulti",
        HasAllOf,
        json!(["selBlue", "selGreen"]),
        rb.clone()
    ));
    assert!(m("fldMulti", HasNoneOf, json!(["selGreen"]), rb.clone()));
    assert!(!m(
        "fldMulti",
        HasNoneOf,
        json!(["selGreen", "selRed"]),
        rb.clone()
    ));
    assert!(
        m("fldMulti", HasNoneOf, json!(["selGreen"]), json!({})),
        "empty matches has none of"
    );
    assert!(!m("fldMulti", HasAnyOf, json!(["selGreen"]), json!({})));
    assert!(
        m(
            "fldMulti",
            IsExactly,
            json!(["selBlue", "selRed"]),
            rb.clone()
        ),
        "order-insensitive"
    );
    assert!(!m("fldMulti", IsExactly, json!(["selBlue"]), rb.clone()));
    assert!(!m(
        "fldMulti",
        IsExactly,
        json!(["selBlue", "selRed", "selGreen"]),
        rb.clone()
    ));
    assert!(
        m("fldMulti", HasAnyOf, json!("selRed"), rb.clone()),
        "single string operand"
    );
    assert!(m("fldMulti", IsEmpty, Json::Null, json!({"fldMulti": []})));
    // Links by id.
    let links = json!({"fldLink": ["recA", "recB"]});
    assert!(m("fldLink", HasAnyOf, json!(["recB"]), links.clone()));
    assert!(m(
        "fldLink",
        HasAllOf,
        json!(["recA", "recB"]),
        links.clone()
    ));
    assert!(m("fldLink", HasNoneOf, json!(["recC"]), links.clone()));
    assert!(m(
        "fldLink",
        IsExactly,
        json!(["recB", "recA"]),
        links.clone()
    ));
    assert!(m("fldLink", IsNotEmpty, Json::Null, links.clone()));
}

#[test]
fn link_name_contains() {
    use FilterOp::*;
    let links = json!({"fldLink": ["recA", "recC"]});
    assert!(
        m("fldLink", Contains, json!("alp"), links.clone()),
        "names via resolver"
    );
    assert!(m("fldLink", Contains, json!("gamma, inc"), links.clone()));
    assert!(!m("fldLink", Contains, json!("beta"), links.clone()));
    assert!(m("fldLink", DoesNotContain, json!("beta"), links.clone()));
    assert!(!m("fldLink", DoesNotContain, json!("alpha"), links.clone()));
    assert!(m("fldLink", DoesNotContain, json!("alpha"), json!({})));
    assert!(
        m(
            "fldLink",
            Contains,
            json!("recq"),
            json!({"fldLink": ["recQ"]})
        ),
        "unknown names fall back to id"
    );
}

#[test]
fn attachment_filename_contains() {
    use FilterOp::*;
    let att = json!({"fldAtt": [{"id": "attA", "filename": "Invoice-2026.PDF", "mime": "application/pdf", "size": 1}]});
    assert!(m("fldAtt", Contains, json!("invoice"), att.clone()));
    assert!(m("fldAtt", Contains, json!(".pdf"), att.clone()));
    assert!(!m("fldAtt", Contains, json!("png"), att.clone()));
    assert!(m("fldAtt", DoesNotContain, json!("png"), att.clone()));
    assert!(m("fldAtt", IsEmpty, Json::Null, json!({"fldAtt": []})));
}

#[test]
fn user_operators_with_me() {
    use FilterOp::*;
    let mine = json!({"fldOwner": ["usr1"]});
    let theirs = json!({"fldOwner": ["usr2"]});
    assert!(m("fldOwner", Is, json!("me"), mine.clone()));
    assert!(!m("fldOwner", Is, json!("me"), theirs.clone()));
    assert!(m("fldOwner", IsNot, json!("me"), theirs.clone()));
    assert!(m("fldOwner", IsNot, json!("me"), json!({})));
    assert!(m("fldOwner", Is, json!("usr2"), theirs.clone()));
    assert!(m(
        "fldOwner",
        IsAnyOf,
        json!(["me", "usr2"]),
        theirs.clone()
    ));
    assert!(m("fldOwner", IsNoneOf, json!(["me"]), theirs.clone()));
    assert!(!m("fldOwner", IsNoneOf, json!(["me"]), mine.clone()));
    // Created by is stored as a plain string.
    assert!(m(
        "fldCreatedBy",
        Is,
        json!("me"),
        json!({"fldCreatedBy": "usr1"})
    ));
    assert!(!m(
        "fldCreatedBy",
        Is,
        json!("me"),
        json!({"fldCreatedBy": "usr2"})
    ));
    // Multi-user fields.
    let team = json!({"fldUsers": ["usr1", "usr2"]});
    assert!(m("fldUsers", HasAnyOf, json!(["me"]), team.clone()));
    assert!(m("fldUsers", HasAllOf, json!(["me", "usr2"]), team.clone()));
    assert!(m(
        "fldUsers",
        IsExactly,
        json!(["usr2", "me"]),
        team.clone()
    ));
    assert!(!m("fldUsers", HasNoneOf, json!(["me"]), team.clone()));
    assert!(m(
        "fldUsers",
        HasNoneOf,
        json!(["me"]),
        json!({"fldUsers": ["usr2"]})
    ));
}

#[test]
fn me_without_a_viewer_matches_nobody() {
    use FilterOp::*;
    let anon = crate::query::QueryCtx::new(crate::cell::tests::fixtures::now(), chrono_tz::Tz::UTC);
    let t = table();
    let eval = |field: &str, op, v: Json, cells: Json| {
        let f = compile_filter(&cond(field, op, v), &t).unwrap();
        matches(&f, &row("r", cells), &anon, &names())
    };
    assert!(!eval(
        "fldOwner",
        Is,
        json!("me"),
        json!({"fldOwner": ["usr1"]})
    ));
    assert!(eval(
        "fldOwner",
        IsNot,
        json!("me"),
        json!({"fldOwner": ["usr1"]})
    ));
    assert!(!eval(
        "fldUsers",
        HasAnyOf,
        json!(["me"]),
        json!({"fldUsers": ["usr1"]})
    ));
    assert!(!eval(
        "fldUsers",
        HasAllOf,
        json!(["me"]),
        json!({"fldUsers": ["usr1"]})
    ));
    assert!(eval(
        "fldUsers",
        HasNoneOf,
        json!(["me"]),
        json!({"fldUsers": ["usr1"]})
    ));
    assert!(eval("fldUsers", IsExactly, json!(["me"]), json!({})));
}

#[test]
fn computed_lists() {
    use FilterOp::*;
    let l = json!({"fldLookup": ["Alpha", "Beta"]});
    assert!(m("fldLookup", Contains, json!("bet"), l.clone()));
    assert!(m("fldLookup", DoesNotContain, json!("gam"), l.clone()));
    assert!(m("fldLookup", HasAnyOf, json!(["Beta"]), l.clone()));
    assert!(
        !m("fldLookup", HasAnyOf, json!(["beta"]), l.clone()),
        "element match is exact"
    );
    assert!(m(
        "fldLookup",
        HasAllOf,
        json!(["Alpha", "Beta"]),
        l.clone()
    ));
    assert!(m(
        "fldLookup",
        IsExactly,
        json!(["Beta", "Alpha"]),
        l.clone()
    ));
    assert!(m("fldLookup", HasNoneOf, json!(["Gamma"]), json!({})));
    assert!(m(
        "fldLookup",
        IsEmpty,
        Json::Null,
        json!({"fldLookup": []})
    ));
    assert!(m(
        "fldLookupNum",
        HasAnyOf,
        json!(["3"]),
        json!({"fldLookupNum": [1, 3]})
    ));
    assert!(m(
        "fldFText",
        StartsWith,
        json!("ab"),
        json!({"fldFText": "abc"})
    ));
}

#[test]
fn nested_groups_and_or() {
    // (text contains "a") AND ((num > 5) OR (select is Red))
    let filter = Filter {
        conjunction: Conjunction::And,
        items: vec![
            FilterItem::Condition(Condition {
                field_id: "fldText".into(),
                op: FilterOp::Contains,
                value: json!("a"),
            }),
            FilterItem::Group(Filter {
                conjunction: Conjunction::Or,
                items: vec![
                    FilterItem::Condition(Condition {
                        field_id: "fldNum".into(),
                        op: FilterOp::Gt,
                        value: json!(5),
                    }),
                    FilterItem::Condition(Condition {
                        field_id: "fldSel".into(),
                        op: FilterOp::Is,
                        value: json!("selRed"),
                    }),
                ],
            }),
        ],
    };
    let f = compile_filter(&filter, &table()).unwrap();
    let ev = |cells: Json| matches(&f, &row("r", cells), &qctx(), &names());
    assert!(ev(json!({"fldText": "cat", "fldNum": 9})));
    assert!(ev(json!({"fldText": "cat", "fldSel": "selRed"})));
    assert!(!ev(
        json!({"fldText": "cat", "fldNum": 1, "fldSel": "selBlue"})
    ));
    assert!(!ev(json!({"fldText": "dog", "fldNum": 9})));
    assert_eq!(f.field_ids(), vec!["fldNum", "fldSel", "fldText"]);
    // Top-level OR with an inner AND group.
    let or = Filter {
        conjunction: Conjunction::Or,
        items: vec![
            FilterItem::Condition(Condition {
                field_id: "fldCheck".into(),
                op: FilterOp::Is,
                value: json!(true),
            }),
            FilterItem::Group(Filter {
                conjunction: Conjunction::And,
                items: vec![
                    FilterItem::Condition(Condition {
                        field_id: "fldNum".into(),
                        op: FilterOp::Gte,
                        value: json!(1),
                    }),
                    FilterItem::Condition(Condition {
                        field_id: "fldNum".into(),
                        op: FilterOp::Lte,
                        value: json!(2),
                    }),
                ],
            }),
        ],
    };
    let f = compile_filter(&or, &table()).unwrap();
    let ev = |cells: Json| matches(&f, &row("r", cells), &qctx(), &names());
    assert!(ev(json!({"fldCheck": true, "fldNum": 10})));
    assert!(ev(json!({"fldNum": 1.5})));
    assert!(!ev(json!({"fldNum": 3})));
    assert!(!ev(json!({})));
}

#[test]
fn empty_filters_match_everything() {
    let t = table();
    for conj in [Conjunction::And, Conjunction::Or] {
        let f = compile_filter(
            &Filter {
                conjunction: conj,
                items: vec![],
            },
            &t,
        )
        .unwrap();
        assert!(f.is_trivial());
        assert!(matches(&f, &row("r", json!({})), &qctx(), &names()));
        // An empty nested group is dropped too.
        let nested = Filter {
            conjunction: conj,
            items: vec![FilterItem::Group(Filter {
                conjunction: Conjunction::Or,
                items: vec![],
            })],
        };
        let f = compile_filter(&nested, &t).unwrap();
        assert!(f.is_trivial());
        assert!(matches(&f, &row("r", json!({})), &qctx(), &names()));
    }
    assert!(CompiledFilter::match_all().is_trivial());
    assert!(matches(
        &CompiledFilter::match_all(),
        &row("r", json!({})),
        &qctx(),
        &names()
    ));
}

fn nest(depth: usize) -> Filter {
    let leaf = FilterItem::Condition(Condition {
        field_id: "fldNum".into(),
        op: FilterOp::Gt,
        value: json!(1),
    });
    let mut f = Filter {
        conjunction: Conjunction::And,
        items: vec![leaf],
    };
    for _ in 1..depth {
        f = Filter {
            conjunction: Conjunction::Or,
            items: vec![FilterItem::Group(f)],
        };
    }
    f
}

#[test]
fn depth_and_count_limits() {
    let t = table();
    assert!(compile_filter(&nest(MAX_FILTER_DEPTH), &t).is_ok());
    let e = compile_filter(&nest(MAX_FILTER_DEPTH + 1), &t).unwrap_err();
    assert!(e.contains("nested"), "{e}");
    let at_limit = Filter {
        conjunction: Conjunction::And,
        items: (0..MAX_FILTER_CONDITIONS)
            .map(|_| {
                FilterItem::Condition(Condition {
                    field_id: "fldText".into(),
                    op: FilterOp::Contains,
                    value: json!(""),
                })
            })
            .collect(),
    };
    assert!(compile_filter(&at_limit, &t).is_ok());
    let mut over = at_limit.clone();
    over.items
        .push(FilterItem::Group(cond("fldNum", FilterOp::Gt, json!(1))));
    let e = compile_filter(&over, &t).unwrap_err();
    assert!(e.contains("at most"), "{e}");
}

#[test]
fn validation_errors() {
    use FilterOp::*;
    let e = compile_filter(&cond("fldNope", Is, json!(1)), &table()).unwrap_err();
    assert!(e.contains("unknown field fldNope"), "{e}");
    assert!(compile_err("fldNum", Gt, json!("lots")).contains("needs a number"));
    assert!(compile_err("fldNum", Gt, json!([1])).contains("needs a number"));
    assert!(compile_err("fldText", Contains, json!(["a"])).contains("text value"));
    assert!(compile_err("fldText", Gt, json!(1)).contains("not available"));
    assert!(compile_err("fldNum", Contains, json!("1")).contains("not available"));
    assert!(compile_err("fldCheck", IsNot, json!(true)).contains("not available"));
    assert!(compile_err("fldMulti", Is, json!("selRed")).contains("not available"));
    assert!(compile_err("fldSel", HasAnyOf, json!(["selRed"])).contains("not available"));
    assert!(compile_err("fldButton", IsEmpty, Json::Null).contains("not available"));
    assert!(compile_err("fldDate", Contains, json!("x")).contains("not available"));
    assert!(compile_err("fldDate", Is, json!({"mode": "past_week"})).contains("single day"));
    assert!(compile_err("fldDate", IsWithin, json!({"mode": "today"})).contains("range"));
    assert!(compile_err("fldDate", Is, json!({"mode": "someday"})).contains("invalid date"));
    assert!(compile_err("fldDate", Is, json!("not a date")).contains("not a valid date"));
    assert!(
        compile_err(
            "fldDate",
            Is,
            json!({"mode": "exact_date", "date": "2026-02-30"})
        )
        .contains("not a valid date")
    );
    assert!(
        compile_err(
            "fldDate",
            Is,
            json!({"mode": "number_of_days_ago", "days": 4000000})
        )
        .contains("at most")
    );
    assert!(compile_err("fldDate", Is, json!(5)).contains("invalid date"));
}
