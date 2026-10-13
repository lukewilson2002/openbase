//! Views: create, update, delete, duplicate, and config validation.
//!
//! Permission rules (the caller passes the actor's effective base `role`):
//! - collaborative views: created, reordered, locked/unlocked and deleted by
//!   Creators; their name/config may be changed by Editors unless the view is
//!   locked (then Creators only);
//! - personal views: visible to and editable by their owner only (Editor+ to
//!   create or change, the owner may always delete);
//! - a table always keeps at least one collaborative view.

use std::collections::{HashMap, HashSet};

use ob_core::api::schema::{CreateView, DuplicateView, UpdateView, View};
use ob_core::field::{COLORS, Field};
use ob_core::limits;
use ob_core::view::{Filter, FilterItem, FormConfig, FormField, ViewConfig};
use rusqlite::{Transaction, params};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::perm::Role;
use crate::store::fields_engine::{self, Stale};
use crate::store::schema::{self, PositionScope, ViewRow, live_table, live_view};

fn need(role: Role, min: Role, what: &str) -> AppResult<()> {
    if role < min {
        return Err(AppError::forbidden(format!(
            "{what} requires the {} role on this base",
            min.as_str()
        )));
    }
    Ok(())
}

/// Another user's personal view does not exist as far as the caller can tell.
fn ensure_visible(row: &ViewRow, user_id: &str) -> AppResult<()> {
    match &row.owner_id {
        Some(owner) if owner != user_id => Err(AppError::not_found("view")),
        _ => Ok(()),
    }
}

fn ensure_view_capacity(tx: &Transaction, table_id: &str) -> AppResult<()> {
    let n: i64 = tx.query_row(
        "SELECT count(*) FROM views WHERE table_id = ?1 AND deleted_at IS NULL",
        [table_id],
        |r| r.get(0),
    )?;
    if n as usize >= limits::MAX_VIEWS_PER_TABLE {
        return Err(AppError::bad_request(format!(
            "a table can have at most {} views",
            limits::MAX_VIEWS_PER_TABLE
        )));
    }
    Ok(())
}

/// The form config a new form view starts with: every editable field, in order.
pub fn default_form_config(fields: &[Field]) -> FormConfig {
    FormConfig {
        fields: fields
            .iter()
            .filter(|f| !f.field_type().is_computed())
            .map(|f| FormField {
                field_id: f.id.clone(),
                required: false,
                label: None,
                help: None,
            })
            .collect(),
        ..FormConfig::default()
    }
}

/// Create a view in `table_id`.
pub fn create(
    tx: &Transaction,
    table_id: &str,
    input: &CreateView,
    user_id: &str,
    role: Role,
) -> AppResult<View> {
    let table = live_table(tx, table_id)?;
    if input.personal {
        need(role, Role::Editor, "creating a personal view")?;
    } else {
        need(role, Role::Creator, "creating a shared view")?;
    }
    let name = schema::validate_name(&input.name, "view")?;
    ensure_view_capacity(tx, table_id)?;
    let fields = schema::table_fields(tx, table_id)?;
    let config = match &input.config {
        Some(c) => c.clone(),
        None => {
            let mut c = ViewConfig::default();
            if input.view_type == ob_core::view::ViewType::Form {
                c.form = default_form_config(&fields);
            }
            c
        }
    };
    validate_config(&fields, &config)?;
    let view = View {
        id: new_id(ob_core::ids::VIEW),
        table_id: table.id.clone(),
        name,
        view_type: input.view_type,
        config,
        personal: input.personal,
        locked: false,
    };
    let position = schema::next_position(tx, PositionScope::ViewsIn(table_id))?;
    let owner = input.personal.then_some(user_id);
    schema::insert_view(tx, &view, position, owner, Some(user_id), now_ms())?;
    Ok(view)
}

/// Whether `new` differs from `old` in something a public link exposes: the
/// shown fields and their order, the filter, or the form (fields, texts,
/// redirect). Widths, sorts, colours and the like are not.
fn changes_exposure(old: &ViewConfig, new: &ViewConfig) -> bool {
    let key =
        |c: &ViewConfig| serde_json::json!([c.hidden_fields, c.field_order, c.filter, c.form]);
    key(old) != key(new)
}

/// Whether the view has an enabled share link (read-only link or form).
fn has_enabled_share(conn: &rusqlite::Connection, view_id: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM share_links WHERE view_id = ?1 AND enabled = 1)",
        [view_id],
        |r| r.get(0),
    )?)
}

/// Update name / config / lock / position of a view.
pub fn update(
    tx: &Transaction,
    view_id: &str,
    patch: &UpdateView,
    user_id: &str,
    role: Role,
) -> AppResult<View> {
    let row = live_view(tx, view_id)?;
    ensure_visible(&row, user_id)?;
    let personal = row.owner_id.is_some();
    if personal {
        need(role, Role::Editor, "changing a personal view")?;
        if patch.locked.is_some() {
            return Err(AppError::bad_request("personal views cannot be locked"));
        }
    } else {
        let content = patch.name.is_some() || patch.config.is_some();
        let structural = patch.locked.is_some() || patch.position.is_some();
        if structural {
            need(role, Role::Creator, "reordering or locking a view")?;
        } else if row.view.locked && content {
            need(role, Role::Creator, "changing a locked view")?;
        } else if role < Role::Creator
            && patch
                .config
                .as_ref()
                .is_some_and(|c| changes_exposure(&row.view.config, c))
            && has_enabled_share(tx, view_id)?
        {
            // A public link follows the view's live config, and managing links
            // is a Creator permission: an Editor must not widen what it exposes.
            need(role, Role::Creator, "changing what a public link shows")?;
        } else {
            need(role, Role::Editor, "changing a view")?;
        }
    }

    if let Some(name) = &patch.name {
        let name = schema::validate_name(name, "view")?;
        tx.execute(
            "UPDATE views SET name = ?2 WHERE id = ?1",
            params![view_id, name],
        )?;
    }
    if let Some(config) = &patch.config {
        let fields = schema::table_fields(tx, &row.view.table_id)?;
        validate_config_with(&fields, config, &Stale::of(&row.view.config))?;
        tx.execute(
            "UPDATE views SET config = ?2 WHERE id = ?1",
            params![view_id, serde_json::to_string(config)?],
        )?;
    }
    if let Some(locked) = patch.locked {
        tx.execute(
            "UPDATE views SET locked = ?2 WHERE id = ?1",
            params![view_id, locked],
        )?;
    }
    if let Some(pos) = patch.position {
        let pos = schema::validate_position(pos)?;
        tx.execute(
            "UPDATE views SET position = ?2 WHERE id = ?1",
            params![view_id, pos],
        )?;
    }
    Ok(live_view(tx, view_id)?.view)
}

/// Move a view to the trash.
pub fn delete(tx: &Transaction, view_id: &str, user_id: &str, role: Role) -> AppResult<()> {
    let row = live_view(tx, view_id)?;
    ensure_visible(&row, user_id)?;
    if row.owner_id.is_none() {
        need(role, Role::Creator, "deleting a shared view")?;
        let shared: i64 = tx.query_row(
            "SELECT count(*) FROM views
             WHERE table_id = ?1 AND deleted_at IS NULL AND personal_owner_id IS NULL",
            [&row.view.table_id],
            |r| r.get(0),
        )?;
        if shared <= 1 {
            return Err(AppError::conflict(
                "a table must keep at least one shared view",
            ));
        }
    }
    tx.execute(
        "UPDATE views SET deleted_at = ?2 WHERE id = ?1",
        params![view_id, now_ms()],
    )?;
    Ok(())
}

/// Copy a view. The copy of a personal view is personal; `req.personal` makes
/// a personal copy of a shared view (Editors can do that, only Creators can
/// create shared views).
pub fn duplicate(
    tx: &Transaction,
    view_id: &str,
    req: &DuplicateView,
    user_id: &str,
    role: Role,
) -> AppResult<View> {
    let row = live_view(tx, view_id)?;
    ensure_visible(&row, user_id)?;
    let personal = row.owner_id.is_some() || req.personal;
    if personal {
        need(role, Role::Editor, "creating a personal view")?;
    } else {
        need(role, Role::Creator, "creating a shared view")?;
    }
    ensure_view_capacity(tx, &row.view.table_id)?;
    let name = match &req.name {
        Some(n) => schema::validate_name(n, "view")?,
        None => {
            let head: String = row
                .view
                .name
                .chars()
                .take(limits::MAX_NAME_LEN - " copy".len())
                .collect();
            format!("{head} copy")
        }
    };
    let view = View {
        id: new_id(ob_core::ids::VIEW),
        table_id: row.view.table_id.clone(),
        name,
        view_type: row.view.view_type,
        config: row.view.config.clone(),
        personal,
        locked: false,
    };
    let position = schema::next_position(tx, PositionScope::ViewsIn(&row.view.table_id))?;
    let owner = personal.then_some(user_id);
    schema::insert_view(tx, &view, position, owner, Some(user_id), now_ms())?;
    Ok(view)
}

// -------------------------------------------------------------- validation

/// Check a view config against the table's fields and the hard limits.
/// Operator-vs-type rules are delegated to
/// [`fields_engine::validate_view_config_semantics`].
pub fn validate_config(fields: &[Field], config: &ViewConfig) -> AppResult<()> {
    validate_config_with(fields, config, &Stale::none())
}

fn validate_config_with(fields: &[Field], config: &ViewConfig, stale: &Stale) -> AppResult<()> {
    let known: HashMap<&str, &Field> = fields.iter().map(|f| (f.id.as_str(), f)).collect();
    let check = |id: &str, what: &str| -> AppResult<()> {
        if known.contains_key(id) || stale.field(what, id) {
            Ok(())
        } else {
            Err(AppError::bad_request(format!(
                "{what} refers to an unknown field '{id}'"
            )))
        }
    };

    if config.sorts.len() > limits::MAX_SORTS {
        return Err(AppError::bad_request(format!(
            "a view can have at most {} sorts",
            limits::MAX_SORTS
        )));
    }
    if config.groups.len() > limits::MAX_GROUPS {
        return Err(AppError::bad_request(format!(
            "a view can group by at most {} fields",
            limits::MAX_GROUPS
        )));
    }
    for s in &config.sorts {
        check(&s.field_id, "sort")?;
    }
    for g in &config.groups {
        check(&g.field_id, "group")?;
    }
    if let Some(filter) = &config.filter {
        check_filter(filter, &check)?;
    }
    for id in &config.hidden_fields {
        check(id, "hidden fields")?;
    }
    for id in &config.field_order {
        check(id, "field order")?;
    }
    for (id, width) in &config.field_widths {
        check(id, "field widths")?;
        if *width > 10_000 {
            return Err(AppError::bad_request("field width is too large"));
        }
    }
    for id in config.summaries.keys() {
        check(id, "summaries")?;
    }
    match &config.row_color {
        Some(ob_core::view::RowColor::BySelect { field_id }) => check(field_id, "row color")?,
        Some(ob_core::view::RowColor::ByConditions { rules }) => {
            for rule in rules {
                if !COLORS.contains(&rule.color.as_str()) {
                    return Err(AppError::bad_request(format!(
                        "unknown row color '{}'",
                        rule.color
                    )));
                }
                check_filter(&rule.filter, &check)?;
            }
        }
        None => {}
    }
    for (what, id) in fields_engine::config_slots(config) {
        if let Some(id) = id {
            check(id, what)?;
        }
    }
    check_form(&config.form, &known, stale)?;
    fields_engine::validate_view_config_semantics(fields, config, stale)
}

fn check_filter(filter: &Filter, check: &dyn Fn(&str, &str) -> AppResult<()>) -> AppResult<()> {
    let mut conditions = 0;
    walk_filter(filter, 1, &mut conditions, check)
}

fn walk_filter(
    filter: &Filter,
    depth: usize,
    conditions: &mut usize,
    check: &dyn Fn(&str, &str) -> AppResult<()>,
) -> AppResult<()> {
    if depth > limits::MAX_FILTER_DEPTH {
        return Err(AppError::bad_request(format!(
            "filters can be nested at most {} levels deep",
            limits::MAX_FILTER_DEPTH
        )));
    }
    for item in &filter.items {
        match item {
            FilterItem::Condition(c) => {
                *conditions += 1;
                if *conditions > limits::MAX_FILTER_CONDITIONS {
                    return Err(AppError::bad_request(format!(
                        "a filter can have at most {} conditions",
                        limits::MAX_FILTER_CONDITIONS
                    )));
                }
                check(&c.field_id, "filter")?;
            }
            FilterItem::Group(g) => walk_filter(g, depth + 1, conditions, check)?,
        }
    }
    Ok(())
}

fn check_form(form: &FormConfig, known: &HashMap<&str, &Field>, stale: &Stale) -> AppResult<()> {
    if form.title.chars().count() > limits::MAX_NAME_LEN
        || form.submit_label.chars().count() > limits::MAX_NAME_LEN
        || form.description.chars().count() > limits::MAX_DESCRIPTION_LEN
        || form.success_message.chars().count() > limits::MAX_DESCRIPTION_LEN
    {
        return Err(AppError::bad_request("form text is too long"));
    }
    if let Some(url) = form.redirect_url.as_deref().filter(|u| !u.is_empty()) {
        let ok = url.len() <= 2048
            && url::Url::parse(url)
                .map(|u| matches!(u.scheme(), "http" | "https") && u.has_host())
                .unwrap_or(false);
        if !ok {
            return Err(AppError::bad_request(
                "form redirect_url must be an http or https URL",
            ));
        }
    }
    let mut seen = HashSet::new();
    for f in &form.fields {
        let forgiven = stale.field("form", &f.field_id);
        let Some(field) = known.get(f.field_id.as_str()) else {
            if forgiven {
                continue;
            }
            return Err(AppError::bad_request(format!(
                "form refers to an unknown field '{}'",
                f.field_id
            )));
        };
        if field.field_type().is_computed() && !forgiven {
            return Err(AppError::bad_request(format!(
                "computed field '{}' cannot be part of a form",
                field.name
            )));
        }
        if !seen.insert(f.field_id.as_str()) {
            return Err(AppError::bad_request("a form field is listed twice"));
        }
        for text in [&f.label, &f.help].into_iter().flatten() {
            if text.chars().count() > limits::MAX_DESCRIPTION_LEN {
                return Err(AppError::bad_request("form field text is too long"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ob_core::field::FieldKind;
    use ob_core::view::{Condition, Conjunction, Direction, FilterOp, Sort};

    fn field(id: &str, kind: FieldKind) -> Field {
        Field {
            id: id.into(),
            table_id: "tbl".into(),
            name: id.into(),
            description: None,
            kind,
        }
    }

    fn fields() -> Vec<Field> {
        vec![
            field("a", FieldKind::SingleLineText(Default::default())),
            field("b", FieldKind::Number(Default::default())),
            field("c", FieldKind::Autonumber(ob_core::field::Empty {})),
        ]
    }

    fn cond(id: &str) -> FilterItem {
        FilterItem::Condition(Condition {
            field_id: id.into(),
            op: FilterOp::IsNotEmpty,
            value: serde_json::Value::Null,
        })
    }

    fn nested(levels: usize) -> Filter {
        let mut f = Filter {
            conjunction: Conjunction::And,
            items: vec![cond("a")],
        };
        for _ in 1..levels {
            f = Filter {
                conjunction: Conjunction::Or,
                items: vec![cond("a"), FilterItem::Group(f)],
            };
        }
        f
    }

    #[test]
    fn unknown_fields_are_rejected_everywhere() {
        let f = fields();
        let mut c = ViewConfig::default();
        assert!(validate_config(&f, &c).is_ok());
        c.sorts = vec![Sort {
            field_id: "zzz".into(),
            direction: Direction::Asc,
        }];
        assert!(validate_config(&f, &c).is_err());
        c.sorts.clear();
        c.hidden_fields = vec!["zzz".into()];
        assert!(validate_config(&f, &c).is_err());
        c.hidden_fields.clear();
        c.kanban.stack_field_id = Some("zzz".into());
        assert!(validate_config(&f, &c).is_err());
        c.kanban.stack_field_id = Some("a".into());
        assert!(validate_config(&f, &c).is_ok());
    }

    #[test]
    fn limits_are_enforced() {
        let f = fields();
        let sort = |i: usize| Sort {
            field_id: if i % 2 == 0 { "a".into() } else { "b".into() },
            direction: Direction::Desc,
        };
        let c = ViewConfig {
            sorts: (0..limits::MAX_SORTS + 1).map(sort).collect(),
            ..Default::default()
        };
        assert!(validate_config(&f, &c).is_err());
        let c = ViewConfig {
            groups: (0..limits::MAX_GROUPS + 1).map(sort).collect(),
            ..Default::default()
        };
        assert!(validate_config(&f, &c).is_err());
        let ok = ViewConfig {
            filter: Some(nested(limits::MAX_FILTER_DEPTH)),
            ..Default::default()
        };
        assert!(validate_config(&f, &ok).is_ok());
        let deep = ViewConfig {
            filter: Some(nested(limits::MAX_FILTER_DEPTH + 1)),
            ..Default::default()
        };
        assert!(validate_config(&f, &deep).is_err());
        let many = ViewConfig {
            filter: Some(Filter {
                conjunction: Conjunction::And,
                items: (0..limits::MAX_FILTER_CONDITIONS + 1)
                    .map(|_| cond("a"))
                    .collect(),
            }),
            ..Default::default()
        };
        assert!(validate_config(&f, &many).is_err());
    }

    #[test]
    fn form_rules() {
        let f = fields();
        let mut c = ViewConfig {
            form: default_form_config(&f),
            ..Default::default()
        };
        assert_eq!(c.form.fields.len(), 2, "computed fields are left out");
        assert!(validate_config(&f, &c).is_ok());
        c.form.redirect_url = Some("javascript:alert(1)".into());
        assert!(validate_config(&f, &c).is_err());
        c.form.redirect_url = Some("ftp://example.com".into());
        assert!(validate_config(&f, &c).is_err());
        c.form.redirect_url = Some("https://example.com/thanks".into());
        assert!(validate_config(&f, &c).is_ok());
        c.form.fields.push(FormField {
            field_id: "c".into(),
            required: false,
            label: None,
            help: None,
        });
        assert!(validate_config(&f, &c).is_err(), "computed field in form");
    }
}
