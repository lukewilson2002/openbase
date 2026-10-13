//! Property tests: no cell function panics on arbitrary input, and every
//! successful result is canonical (normalizing it again is the identity).

use proptest::prelude::*;
use serde_json::{Map, Value as Json};

use super::fixtures::*;
use crate::cell::{convert, display_text, missing_choices, normalize, parse_text, to_value};
use crate::field::{DateFormat, FieldType};

fn arb_key() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("id".to_string()),
        Just("filename".to_string()),
        Just("mime".to_string()),
        Just("size".to_string()),
        Just("text".to_string()),
        Just("error".to_string()),
        ".{0,8}",
    ]
}

fn arb_json() -> impl Strategy<Value = Json> {
    let interesting = prop_oneof![
        Just("recA"),
        Just("usr1"),
        Just("attA1"),
        Just("Red"),
        Just("selBlue"),
        Just("2026-10-12"),
        Just("10/12/2026 2:30pm"),
        Just("2026-03-08T02:30"),
        Just("1:30"),
        Just("50%"),
        Just("$1,234.50"),
        Just("yes"),
        Just("★★★"),
        Just("https://example.com"),
        Just("javascript:alert(1)"),
        Just("a@b.co"),
        Just("Red, Blue"),
        Just("image/png"),
    ]
    .prop_map(|s| Json::String(s.to_string()));
    let leaf = prop_oneof![
        Just(Json::Null),
        any::<bool>().prop_map(Json::Bool),
        any::<i64>().prop_map(Json::from),
        any::<u64>().prop_map(Json::from),
        any::<f64>().prop_map(|f| serde_json::Number::from_f64(f).map_or(Json::Null, Json::Number)),
        ".{0,40}".prop_map(Json::String),
        interesting,
    ];
    leaf.prop_recursive(3, 24, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6).prop_map(Json::Array),
            prop::collection::vec((arb_key(), inner), 0..5)
                .prop_map(|kv| Json::Object(kv.into_iter().collect::<Map<_, _>>())),
        ]
    })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, ..ProptestConfig::default() })]

    #[test]
    fn normalize_never_panics_and_is_idempotent(input in arb_json(), typecast in any::<bool>()) {
        let c = ctx().with_typecast(typecast);
        let mut fields: Vec<_> = FieldType::ALL.into_iter().map(sample_field).collect();
        fields.push(date_field(true, DateFormat::European, Some("America/New_York")));
        fields.push(link_field(true));
        fields.push(user_field(false));
        for f in &fields {
            if let Ok(Some(out)) = normalize(f, &input, &c) {
                prop_assert_eq!(normalize(f, &out, &ctx()), Ok(Some(out.clone())), "{:?}", f.kind);
            }
            let _ = missing_choices(f, &input);
        }
    }

    #[test]
    fn parse_text_never_panics(text in ".{0,60}") {
        for t in FieldType::ALL {
            let f = sample_field(t);
            if let Ok(Some(out)) = parse_text(&f, &text, &ctx()) {
                prop_assert_eq!(normalize(&f, &out, &ctx()), Ok(Some(out.clone())), "{:?}", t);
            }
        }
    }

    #[test]
    fn reading_arbitrary_stored_json_never_panics(stored in arb_json()) {
        for t in FieldType::ALL {
            let f = sample_field(t);
            let _ = to_value(&f, Some(&stored), &Names);
            let _ = display_text(&f, Some(&stored), &Names, chrono_tz::Tz::Asia__Kolkata);
        }
    }

    #[test]
    fn convert_arbitrary_stored_json_never_panics(
        stored in arb_json(),
        from_i in 0usize..28,
        to_i in 0usize..28,
    ) {
        let from = sample_field(FieldType::ALL[from_i]);
        let to = sample_field(FieldType::ALL[to_i]);
        if let Some(out) = convert(&from, &to, Some(&stored), &ctx(), &Names) {
            prop_assert_eq!(normalize(&to, &out, &ctx()), Ok(Some(out.clone())));
        }
    }
}
