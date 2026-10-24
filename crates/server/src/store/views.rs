//! Views: create, update, delete, duplicate, and config validation.
//!
//! Permission rules (the caller passes the actor's effective base `role`):
//! - collaborative views: created, reordered, locked/unlocked and deleted by
//!   Creators; their name/config may be changed by Editors unless the view is
//!   locked (then Creators only);
//! - personal views: visible to and editable by their owner only (Editor+ to
//!   create or change, the owner may always delete);
//! - every table has its default grid (`View::is_default`, made with the table):
//!   it cannot be deleted, renamed, locked or moved, and keeps no filter, sort,
//!   grouping or colours (those are each person's own, sent as `transient`). Its
//!   field order, hidden fields, widths and the like are the layout of the
//!   table's records, changed by Editors. Every other view may be deleted.

use std::collections::{HashMap, HashSet};

use ob_core::api::schema::{CreateView, DuplicateView, UpdateView, View};
use ob_core::field::{COLORS, Field, FieldKind};
use ob_core::limits;
use ob_core::view::{
    Filter, FilterItem, FormConfig, FormField, GalleryConfig, ViewConfig, ViewType,
};
use rusqlite::{Transaction, params};

use crate::db::now_ms;
use crate::engine::query::is_date_like;
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

/// The gallery config a new gallery starts with: the table's first attachment field as its cover,
/// cropped to fill the card (a gallery with no cover is a wall of text cards). `None` when the table
/// has no attachment field.
pub fn default_gallery_config(fields: &[Field]) -> Option<GalleryConfig> {
    fields
        .iter()
        .find(|f| matches!(f.kind, FieldKind::Attachment(_)))
        .map(|f| GalleryConfig {
            cover_field_id: Some(f.id.clone()),
            cover_crop: true,
        })
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
    let mut config = match &input.config {
        Some(c) => c.clone(),
        None => {
            let mut c = ViewConfig::default();
            if input.view_type == ViewType::Form {
                c.form = default_form_config(&fields);
            }
            c
        }
    };
    // A gallery whose config says nothing about the gallery gets the cover a person would choose.
    if input.view_type == ViewType::Gallery
        && config.gallery == GalleryConfig::default()
        && let Some(gallery) = default_gallery_config(&fields)
    {
        config.gallery = gallery;
    }
    validate_config(&fields, &config)?;
    let view = View {
        id: new_id(ob_core::ids::VIEW),
        table_id: table.id.clone(),
        name,
        view_type: input.view_type,
        config,
        personal: input.personal,
        locked: false,
        is_default: false,
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

/// Put the views of a table, as the caller sees them, in a new order: the `listed` ones take the
/// places they held, in the given order; every other view keeps its place. Needs the Creator
/// role when any listed view is shared, the Editor role for a list of the caller's own personal
/// views only. The default grid has no place among the views and is refused. Returns whether the
/// order changed.
pub fn reorder(
    tx: &Transaction,
    table_id: &str,
    listed: &[String],
    user_id: &str,
    role: Role,
) -> AppResult<bool> {
    schema::check_reorder_list(listed)?;
    let visible: HashMap<String, ViewRow> = schema::visible_views(tx, table_id, user_id)?
        .into_iter()
        .map(|r| (r.view.id.clone(), r))
        .collect();
    let mut shared = false;
    for id in listed {
        let Some(row) = visible.get(id) else {
            return Err(AppError::not_found(format!("view '{id}'")));
        };
        if row.view.is_default {
            return Err(AppError::bad_request(format!(
                "'{id}' is the table's default grid, which has no place among the views and \
                 cannot be reordered"
            )));
        }
        shared |= row.owner_id.is_none();
    }
    if shared {
        need(role, Role::Creator, "reordering shared views")?;
    } else {
        need(role, Role::Editor, "reordering personal views")?;
    }
    schema::reorder_siblings(tx, PositionScope::ViewsIn(table_id), listed, |_| Ok(()))
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
    if row.view.is_default {
        check_default_patch(patch)?;
    }
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

/// What the default grid refuses: a new name, a lock, a place among the views,
/// and a saved filter, sort, grouping or colours (each person's own instead).
fn check_default_patch(patch: &UpdateView) -> AppResult<()> {
    if patch.name.is_some() {
        return Err(AppError::bad_request("the default grid cannot be renamed"));
    }
    if patch.locked.is_some() {
        return Err(AppError::bad_request("the default grid cannot be locked"));
    }
    if patch.position.is_some() {
        return Err(AppError::bad_request(
            "the default grid is not one of the views and has no position",
        ));
    }
    if let Some(c) = &patch.config {
        let filtered = c.filter.as_ref().is_some_and(|f| !f.items.is_empty());
        if filtered || !c.sorts.is_empty() || !c.groups.is_empty() || c.row_color.is_some() {
            return Err(AppError::bad_request(
                "the default grid keeps no filter, sort, grouping or colours: each person \
                 filters and sorts it for themselves (send them as `transient` with the query), \
                 or make a view for a filtered or sorted list everyone shares",
            ));
        }
    }
    Ok(())
}

/// Move a view to the trash, as deleted by `user_id`.
pub fn delete(tx: &Transaction, view_id: &str, user_id: &str, role: Role) -> AppResult<()> {
    let row = live_view(tx, view_id)?;
    ensure_visible(&row, user_id)?;
    if row.view.is_default {
        return Err(AppError::conflict(
            "a table's default grid cannot be deleted: it is always there",
        ));
    }
    if row.owner_id.is_none() {
        need(role, Role::Creator, "deleting a shared view")?;
    }
    tx.execute(
        "UPDATE views SET deleted_at = ?2, deleted_by = ?3 WHERE id = ?1",
        params![view_id, now_ms(), user_id],
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
        // A copy of the default grid is an ordinary view.
        is_default: false,
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
    // The range the web app's divider allows, so a saved width is always the one shown.
    if let Some(w) = config.timeline.label_width
        && !(80..=480).contains(&w)
    {
        return Err(AppError::bad_request(
            "timeline label_width must be between 80 and 480 pixels",
        ));
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
    check_slot_types(fields, config, stale)?;
    fields_engine::validate_view_config_semantics(fields, config, stale)
}

/// The fields a calendar, timeline or kanban reads must be of a type the view can draw: dates
/// for the calendar and timeline (the end differing from the start), a link to the same table
/// for timeline dependencies and a single select, single user or checkbox to stack a kanban by.
/// A reference the saved config already held in the same place is left alone (see [`Stale`]),
/// so a view whose field changed type can still be saved with its other changes.
fn check_slot_types(fields: &[Field], config: &ViewConfig, stale: &Stale) -> AppResult<()> {
    let find = |id: &Option<String>| {
        id.as_deref()
            .and_then(|id| fields.iter().find(|f| f.id == id))
    };
    let table_id = fields.first().map(|f| f.table_id.as_str());
    let describe = |f: &Field| format!("'{}' is a {} field", f.name, f.field_type().label());
    let dates = |what: &str, id: &Option<String>| -> AppResult<()> {
        match find(id) {
            Some(f) if !is_date_like(f) && !stale.field(what, &f.id) => {
                Err(AppError::bad_request(format!(
                    "{what} must be a date field (a date, created time, last modified time, or a formula or rollup that returns a date), but {}",
                    describe(f)
                )))
            }
            _ => Ok(()),
        }
    };
    let differ = |what: &str, start: &Option<String>, end: &Option<String>| -> AppResult<()> {
        match (find(start), find(end)) {
            (Some(s), Some(e)) if s.id == e.id && !stale.field(what, &e.id) => {
                Err(AppError::bad_request(format!(
                    "{what} must be a different field from the start: '{}' is both; leave the end empty for single-day items",
                    s.name
                )))
            }
            _ => Ok(()),
        }
    };
    dates("calendar date field", &config.calendar.date_field_id)?;
    dates("calendar end field", &config.calendar.end_field_id)?;
    differ(
        "calendar end field",
        &config.calendar.date_field_id,
        &config.calendar.end_field_id,
    )?;
    dates("timeline start field", &config.timeline.start_field_id)?;
    dates("timeline end field", &config.timeline.end_field_id)?;
    differ(
        "timeline end field",
        &config.timeline.start_field_id,
        &config.timeline.end_field_id,
    )?;
    if let Some(f) = find(&config.timeline.dependency_field_id) {
        let self_link =
            matches!(&f.kind, FieldKind::Link(l) if Some(l.linked_table_id.as_str()) == table_id);
        if !self_link && !stale.field("timeline dependency field", &f.id) {
            return Err(AppError::bad_request(format!(
                "timeline dependency field must be a link field to records of the same table, but {}",
                describe(f)
            )));
        }
    }
    if let Some(f) = find(&config.kanban.stack_field_id) {
        let stackable = match &f.kind {
            FieldKind::SingleSelect(_) | FieldKind::Checkbox(_) => true,
            FieldKind::User(o) => !o.multiple,
            _ => false,
        };
        if !stackable && !stale.field("kanban stack field", &f.id) {
            return Err(AppError::bad_request(format!(
                "kanban stack field must be a single select, a user field that holds one person, or a checkbox, but {}",
                describe(f)
            )));
        }
    }
    Ok(())
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
        // The public form never collects link or user fields, so a "required" there would be
        // enforced for signed-in editors only: it is refused (one the saved form already had stays).
        if f.required
            && !stale.field("form required", &f.field_id)
            && !crate::store::sharing::is_public_form_type(field)
        {
            return Err(AppError::bad_request(format!(
                "'{}' is a {} field, which public forms cannot collect, so it cannot be required in the form",
                field.name,
                field.field_type().label()
            )));
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
            field("a", FieldKind::Text(Default::default())),
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
        let mut f = fields();
        f.push(field("s", FieldKind::SingleSelect(Default::default())));
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
        c.kanban.stack_field_id = Some("s".into());
        assert!(validate_config(&f, &c).is_ok());
    }

    #[test]
    fn calendar_timeline_and_kanban_fields_must_have_the_right_type() {
        let mut f = fields();
        f.push(field("s", FieldKind::SingleSelect(Default::default())));
        f.push(field("d", FieldKind::Date(Default::default())));
        f.push(field("e", FieldKind::Date(Default::default())));
        f.push(field(
            "l",
            FieldKind::Link(ob_core::field::LinkOptions {
                linked_table_id: "tbl".into(),
                inverse_field_id: "l2".into(),
                single: false,
                picker_view_id: None,
            }),
        ));
        f.push(field(
            "lo",
            FieldKind::Link(ob_core::field::LinkOptions {
                linked_table_id: "other".into(),
                inverse_field_id: "lo2".into(),
                single: false,
                picker_view_id: None,
            }),
        ));
        f.push(field(
            "m",
            FieldKind::User(ob_core::field::UserOptions {
                multiple: true,
                notify: false,
            }),
        ));
        f.push(field("u", FieldKind::User(Default::default())));
        f.push(field("k", FieldKind::Checkbox(Default::default())));
        let err = |c: &ViewConfig| validate_config(&f, c).unwrap_err().to_string();

        let mut c = ViewConfig::default();
        c.timeline.start_field_id = Some("a".into());
        assert!(
            err(&c).contains("timeline start field must be a date field"),
            "{}",
            err(&c)
        );
        assert!(err(&c).contains("'a' is a Text field"));
        c.timeline.start_field_id = Some("d".into());
        c.timeline.end_field_id = Some("b".into());
        assert!(err(&c).contains("timeline end field must be a date field"));
        c.timeline.end_field_id = Some("d".into());
        assert!(err(&c).contains("different field"));
        c.timeline.end_field_id = Some("e".into());
        assert!(validate_config(&f, &c).is_ok());
        c.timeline.dependency_field_id = Some("a".into());
        assert!(err(&c).contains("link field to records of the same table"));
        c.timeline.dependency_field_id = Some("lo".into());
        assert!(err(&c).contains("same table"));
        c.timeline.dependency_field_id = Some("l".into());
        assert!(validate_config(&f, &c).is_ok());

        let mut c = ViewConfig::default();
        c.calendar.date_field_id = Some("b".into());
        assert!(err(&c).contains("calendar date field must be a date field"));
        c.calendar.date_field_id = Some("d".into());
        assert!(validate_config(&f, &c).is_ok());

        let mut c = ViewConfig::default();
        for bad in ["a", "m", "b"] {
            c.kanban.stack_field_id = Some(bad.into());
            assert!(err(&c).contains("kanban stack field must be"), "{bad}");
        }
        for ok in ["s", "u", "k"] {
            c.kanban.stack_field_id = Some(ok.into());
            assert!(validate_config(&f, &c).is_ok(), "{ok}");
        }

        // A reference the saved config held in the same place is forgiven.
        let mut old = ViewConfig::default();
        old.kanban.stack_field_id = Some("a".into());
        let stale = Stale::of(&old);
        assert!(validate_config_with(&f, &old, &stale).is_ok());
        let mut other = ViewConfig::default();
        other.kanban.stack_field_id = Some("b".into());
        assert!(validate_config_with(&f, &other, &stale).is_err());
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
            groups: (0..limits::MAX_GROUPS + 1)
                .map(|i| ob_core::view::Group {
                    field_id: sort(i).field_id,
                    direction: Direction::Desc,
                    granularity: None,
                })
                .collect(),
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
