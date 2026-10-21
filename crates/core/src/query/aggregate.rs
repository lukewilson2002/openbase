//! Summary-bar aggregations.

use std::collections::HashSet;

use chrono::NaiveDate;
use chrono_tz::Tz;
use serde_json::Value as Json;

use super::dates::cell_day;
use super::{Kind, is_cell_empty, kind_of};
use crate::cell::{NoNames, num_json, to_value};
use crate::field::Field;
use crate::value::Value;
use crate::view::Aggregation;

/// Aggregations offered for a field: counts for every filterable type,
/// unique counts (not attachments), numeric statistics for numbers, date
/// statistics for dates, checked counts for checkboxes. Always starts with
/// `None`.
pub fn aggregations_for(field: &Field) -> Vec<Aggregation> {
    use Aggregation::*;
    let kind = kind_of(field);
    let mut out = vec![None];
    match kind {
        Kind::Inert => return out,
        Kind::Bool => {
            out.extend([Checked, Unchecked, PercentChecked, PercentUnchecked]);
            return out;
        }
        _ => {}
    }
    out.extend([Empty, Filled, PercentEmpty, PercentFilled]);
    if kind != Kind::Attachment {
        out.extend([Unique, PercentUnique]);
    }
    match kind {
        Kind::Number => out.extend([Sum, Average, Median, Min, Max, Range, StdDev]),
        Kind::Date => out.extend([EarliestDate, LatestDate, DateRangeDays]),
        _ => {}
    }
    out
}

fn ratio(part: usize, total: usize) -> Json {
    if total == 0 {
        num_json(0.0)
    } else {
        num_json(part as f64 / total as f64)
    }
}

fn number_or_null(v: Option<f64>) -> Json {
    v.filter(|n| n.is_finite()).map_or(Json::Null, num_json)
}

/// Compute one aggregation over a column of stored cells. Counts are
/// integers, percentages are fractions in 0..=1 (0 for no rows), statistics
/// over no numbers are `null` (sum is 0), standard deviation is the sample
/// standard deviation (0 for one value), earliest/latest dates are returned
/// as stored-style strings and `date_range_days` is the number of calendar
/// days between them. Aggregations not offered for the field give `null`.
pub fn aggregate(agg: Aggregation, field: &Field, values: &[Option<&Json>], tz: Tz) -> Json {
    if agg == Aggregation::None || !aggregations_for(field).contains(&agg) {
        return Json::Null;
    }
    let n = values.len();
    let empty = || values.iter().filter(|v| is_cell_empty(field, **v)).count();
    let unique = || {
        let keys: HashSet<String> = values
            .iter()
            .filter(|v| !is_cell_empty(field, **v))
            .map(|v| super::group_key(field, *v, &NoNames, tz, None).key)
            .collect();
        keys.len()
    };
    let checked = || {
        values
            .iter()
            .filter(|v| to_value(field, **v, &NoNames).truthy())
            .count()
    };
    match agg {
        Aggregation::None => Json::Null,
        Aggregation::Empty => Json::from(empty()),
        Aggregation::Filled => Json::from(n - empty()),
        Aggregation::PercentEmpty => ratio(empty(), n),
        Aggregation::PercentFilled => ratio(n - empty(), n),
        Aggregation::Unique => Json::from(unique()),
        Aggregation::PercentUnique => ratio(unique(), n),
        Aggregation::Checked => Json::from(checked()),
        Aggregation::Unchecked => Json::from(n - checked()),
        Aggregation::PercentChecked => ratio(checked(), n),
        Aggregation::PercentUnchecked => ratio(n - checked(), n),
        Aggregation::Sum
        | Aggregation::Average
        | Aggregation::Median
        | Aggregation::Min
        | Aggregation::Max
        | Aggregation::Range
        | Aggregation::StdDev => numeric(agg, &numbers(field, values)),
        Aggregation::EarliestDate | Aggregation::LatestDate | Aggregation::DateRangeDays => {
            dates(agg, field, values, tz)
        }
    }
}

fn numbers(field: &Field, values: &[Option<&Json>]) -> Vec<f64> {
    values
        .iter()
        .filter_map(|v| match to_value(field, *v, &NoNames) {
            Value::Number(n) if n.is_finite() => Some(n),
            _ => None,
        })
        .collect()
}

fn numeric(agg: Aggregation, nums: &[f64]) -> Json {
    if nums.is_empty() {
        return if agg == Aggregation::Sum {
            num_json(0.0)
        } else {
            Json::Null
        };
    }
    let count = nums.len() as f64;
    let sum: f64 = nums.iter().sum();
    let min = nums.iter().copied().fold(f64::INFINITY, f64::min);
    let max = nums.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mean = sum / count;
    let v = match agg {
        Aggregation::Sum => sum,
        Aggregation::Average => mean,
        Aggregation::Min => min,
        Aggregation::Max => max,
        Aggregation::Range => max - min,
        Aggregation::Median => {
            let mut sorted = nums.to_vec();
            sorted.sort_by(f64::total_cmp);
            let mid = sorted.len() / 2;
            if sorted.len() % 2 == 0 {
                (sorted[mid - 1] + sorted[mid]) / 2.0
            } else {
                sorted[mid]
            }
        }
        Aggregation::StdDev => {
            if nums.len() < 2 {
                0.0
            } else {
                let var = nums.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (count - 1.0);
                var.sqrt()
            }
        }
        _ => return Json::Null,
    };
    number_or_null(Some(v))
}

fn dates(agg: Aggregation, field: &Field, values: &[Option<&Json>], tz: Tz) -> Json {
    // (sort instant, value) for every date cell.
    let mut found: Vec<(i64, Value, NaiveDate)> = Vec::new();
    for v in values {
        let value = to_value(field, *v, &NoNames);
        let instant = match &value {
            Value::Date(d) => d
                .and_hms_opt(0, 0, 0)
                .map(|t| t.and_utc().timestamp_millis()),
            Value::DateTime(i) => Some(i.timestamp_millis()),
            _ => None,
        };
        if let (Some(instant), Some(day)) = (instant, cell_day(field, *v, tz)) {
            found.push((instant, value, day));
        }
    }
    let earliest = found.iter().min_by_key(|(i, _, _)| *i);
    let latest = found.iter().max_by_key(|(i, _, _)| *i);
    match agg {
        Aggregation::EarliestDate => earliest.map_or(Json::Null, |(_, v, _)| v.to_json()),
        Aggregation::LatestDate => latest.map_or(Json::Null, |(_, v, _)| v.to_json()),
        Aggregation::DateRangeDays => match (earliest, latest) {
            (Some((_, _, a)), Some((_, _, b))) => Json::from((*b - *a).num_days()),
            _ => Json::Null,
        },
        _ => Json::Null,
    }
}
