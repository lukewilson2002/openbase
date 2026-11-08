//! The v15 fixture: a database as OpenBase 0.8 (schema version 15) leaves it, built by running
//! migrations 0001 to 0015 on a fresh file and then seeding it with SQL, never through the
//! application code. The seed therefore stays what a real v15 install looked like however the
//! store changes later; the migration tests (`migration_v16.rs`) upgrade it, and the golden test
//! (`v1_golden.rs`) reads it through the Airtable-compatible API.
//!
//! What it holds, by the case it exists for (the UX overhaul spec, BE-1 and decisions 1 and 2):
//!
//! - Workspace "Acme" (owner Olive, Ann is an editor, Bob a viewer limited to one project) with a
//!   trashed project at the lowest position, two live projects at the same position (the tie
//!   goes to the earlier creation time), a project of wide tables and an operations project.
//! - Workspace "Beta": three live projects tied on position and on creation time, so the lowest id
//!   decides, plus a later one.
//! - Carol's workspaces: "Empty" (only a trashed project), "Fresh" (no project at all), and two
//!   trashed workspaces, one with a live project and one without.
//! - Tables with zero, one and two rich text fields, name collisions with "Page", "Page 2" and a
//!   lower-case "page", a trashed rich text field, a table at the 500-field limit and one just
//!   below it, trashed tables, and date and checkbox fields named for the Home presets (and
//!   decoys of the wrong type).
//! - Records of every field type with values, a table of 120 records (a second page in the v1
//!   API), views (default grids, a board, a form, a personal view, a trashed view), comments,
//!   history, inbox drafts and an attachment.
//!
//! Ids are readable and fixed (`id::field("tasks", "due")` is `fldtasksdue`), and so are all
//! timestamps, so responses and checksums are the same on every run.
#![allow(dead_code)]

use std::path::Path;

use rusqlite::{Connection, params};
use serde_json::{Map, Value, json};

/// Migrations 0001 to 0015, frozen here so that the fixture stays a v15 database when the
/// server's own list grows.
const MIGRATIONS_V15: [&str; 15] = [
    include_str!("../../migrations/0001_init.sql"),
    include_str!("../../migrations/0002_icons.sql"),
    include_str!("../../migrations/0003_oauth.sql"),
    include_str!("../../migrations/0004_passkeys.sql"),
    include_str!("../../migrations/0005_workspace_base_access.sql"),
    include_str!("../../migrations/0006_workspace_color_deleted_by.sql"),
    include_str!("../../migrations/0007_invite_may_raise_roles.sql"),
    include_str!("../../migrations/0008_view_description_field.sql"),
    include_str!("../../migrations/0009_inbox.sql"),
    include_str!("../../migrations/0010_comments_created.sql"),
    include_str!("../../migrations/0011_default_views.sql"),
    include_str!("../../migrations/0012_workspace_order.sql"),
    include_str!("../../migrations/0013_rich_comments.sql"),
    include_str!("../../migrations/0014_text_types.sql"),
    include_str!("../../migrations/0015_user_accent.sql"),
];

/// API tokens (plaintext; the database holds their hashes).
pub const OLIVE_TOKEN: &str = "pat_v15_olive";
pub const BOB_TOKEN: &str = "pat_v15_bob";
pub const CAROL_TOKEN: &str = "pat_v15_carol";

/// Fixed ids. Names are the short keys used in the seed below.
pub mod id {
    pub fn user(key: &str) -> String {
        format!("usr{key}")
    }
    pub fn workspace(key: &str) -> String {
        format!("wsp{key}")
    }
    pub fn base(key: &str) -> String {
        format!("app{key}")
    }
    pub fn table(key: &str) -> String {
        format!("tbl{key}")
    }
    /// A field of table `table`: `fld` + both keys, letters and digits only (formulas refer to
    /// fields as `{fldXXXX}`).
    pub fn field(table: &str, key: &str) -> String {
        format!("fld{table}{key}")
    }
    /// Record number `n` (from 1) of table `table`.
    pub fn record(table: &str, n: usize) -> String {
        format!("rec{table}{n}")
    }
    pub fn view(key: &str) -> String {
        format!("viw{key}")
    }
    pub fn default_view(table: &str) -> String {
        format!("viwdef{table}")
    }
    pub fn choice(table: &str, field: &str, name: &str) -> String {
        format!("sel{table}{field}{name}")
    }
}

// ------------------------------------------------------------------ the builder

struct Fld {
    key: &'static str,
    name: String,
    ty: &'static str,
    options: Value,
    deleted: bool,
}

fn fld(key: &'static str, name: &str, ty: &'static str, options: Value) -> Fld {
    Fld {
        key,
        name: name.to_string(),
        ty,
        options,
        deleted: false,
    }
}

fn text(key: &'static str, name: &str) -> Fld {
    fld(key, name, "text", json!({"multiline": false}))
}
fn long(key: &'static str, name: &str) -> Fld {
    fld(key, name, "text", json!({"multiline": true}))
}
fn rich(key: &'static str, name: &str) -> Fld {
    fld(key, name, "rich_text", json!({}))
}
fn number(key: &'static str, name: &str) -> Fld {
    fld(
        key,
        name,
        "number",
        json!({"precision": 1, "allow_negative": true}),
    )
}
fn check(key: &'static str, name: &str) -> Fld {
    fld(
        key,
        name,
        "checkbox",
        json!({"icon": "check", "color": "green"}),
    )
}
fn date(key: &'static str, name: &str) -> Fld {
    fld(
        key,
        name,
        "date",
        json!({"include_time": false, "date_format": "iso", "time_format": "h12"}),
    )
}
fn date_time(key: &'static str, name: &str, zone: Option<&str>) -> Fld {
    let mut o = json!({"include_time": true, "date_format": "iso", "time_format": "h24"});
    if let Some(z) = zone {
        o["timezone"] = json!(z);
    }
    fld(key, name, "date", o)
}
fn select(table: &str, key: &'static str, name: &str, choices: &[&str], multi: bool) -> Fld {
    let colors = ["blue", "red", "green", "orange"];
    let choices: Vec<Value> = choices
        .iter()
        .enumerate()
        .map(|(i, c)| json!({"id": id::choice(table, key, c), "name": c, "color": colors[i % 4]}))
        .collect();
    fld(
        key,
        name,
        if multi {
            "multiple_select"
        } else {
            "single_select"
        },
        json!({ "choices": choices }),
    )
}
fn trashed(mut f: Fld) -> Fld {
    f.deleted = true;
    f
}

struct Rec {
    created_at: i64,
    cells: Vec<(&'static str, Value)>,
}

/// A record with `cells` (field key, stored value); created on 2026-01-NN so listings are stable.
fn rec(day: i64, cells: Vec<(&'static str, Value)>) -> Rec {
    Rec {
        created_at: 1_767_225_600_000 + day * 86_400_000,
        cells,
    }
}

struct Vw {
    key: &'static str,
    name: &'static str,
    ty: &'static str,
    config: Value,
    personal_owner: Option<&'static str>,
    deleted: bool,
}

struct Tbl {
    key: &'static str,
    base: &'static str,
    name: &'static str,
    position: f64,
    deleted: bool,
    fields: Vec<Fld>,
    records: Vec<Rec>,
    views: Vec<Vw>,
    /// The default grid's stored config, as a v15 server could have written it: `{}` or the full
    /// serialisation of an empty config.
    default_config: Value,
}

fn tbl(
    key: &'static str,
    base: &'static str,
    name: &'static str,
    position: f64,
    fields: Vec<Fld>,
    records: Vec<Rec>,
) -> Tbl {
    Tbl {
        key,
        base,
        name,
        position,
        deleted: false,
        fields,
        records,
        views: Vec::new(),
        default_config: json!({}),
    }
}

/// The config an empty `ViewConfig` serialises to (what the server wrote for default grids).
fn full_default_config() -> Value {
    json!({
        "filter": null, "sorts": [], "groups": [], "hidden_fields": [], "field_order": [],
        "field_widths": {}, "frozen_columns": 0, "row_height": "short", "row_color": null,
        "summaries": {}, "wrap_headers": false, "description_field_id": null
    })
}

// ------------------------------------------------------------------ the tables

fn tables() -> Vec<Tbl> {
    let mut out = Vec::new();

    // Sales/Tasks: no rich text field. Start comes before Due in table order, and checkbox Complete
    // before Done, to show that the presets go by name, in the order the spec lists them.
    {
        let t = "tasks";
        let mut tasks = tbl(
            t,
            "sales",
            "Tasks",
            1.0,
            vec![
                text("title", "Title"),
                long("notes", "Notes"),
                check("complete", "Complete"),
                check("done", "Done"),
                date("start", "Start"),
                date("due", "Due"),
                select(t, "prio", "Priority", &["High", "Medium", "Low"], false),
                number("hours", "Hours"),
                select(t, "tags", "Tags", &["home", "work"], true),
                fld(
                    "everything",
                    "Everything",
                    "link",
                    json!({"linked_table_id": id::table("everything"),
                           "inverse_field_id": id::field("everything", "links"),
                           "single": false}),
                ),
            ],
            vec![
                rec(
                    1,
                    vec![
                        ("title", json!("Write the spec")),
                        ("notes", json!("Two pages\nwith a break")),
                        ("done", json!(true)),
                        ("start", json!("2026-11-01")),
                        ("due", json!("2026-11-05")),
                        ("prio", json!(id::choice(t, "prio", "High"))),
                        ("hours", json!(6.5)),
                        ("tags", json!([id::choice(t, "tags", "work")])),
                        ("everything", json!([id::record("everything", 1)])),
                    ],
                ),
                rec(
                    2,
                    vec![
                        ("title", json!("Book the venue")),
                        ("start", json!("2026-11-03")),
                        ("due", json!("2026-11-14")),
                        ("prio", json!(id::choice(t, "prio", "Medium"))),
                        ("hours", json!(2)),
                        (
                            "tags",
                            json!([id::choice(t, "tags", "work"), id::choice(t, "tags", "home")]),
                        ),
                        (
                            "everything",
                            json!([id::record("everything", 1), id::record("everything", 2)]),
                        ),
                    ],
                ),
                rec(
                    3,
                    vec![
                        ("title", json!("Water the plants")),
                        ("complete", json!(true)),
                        ("due", json!("2026-11-09")),
                        ("hours", json!(0.5)),
                        ("tags", json!([id::choice(t, "tags", "home")])),
                    ],
                ),
                rec(4, vec![("title", json!("Empty-ish task"))]),
                rec(
                    5,
                    vec![
                        ("title", json!("Emoji and \"quotes\" \u{1F680}")),
                        ("prio", json!(id::choice(t, "prio", "Low"))),
                        ("notes", json!("line one\nline two\nline three")),
                    ],
                ),
            ],
        );
        tasks.default_config = full_default_config();
        tasks.views = vec![
            Vw {
                key: "tasksboard",
                name: "Board",
                ty: "kanban",
                config: json!({"hidden_fields": [id::field(t, "notes")]}),
                personal_owner: None,
                deleted: false,
            },
            Vw {
                key: "tasksann",
                name: "Ann's tasks",
                ty: "grid",
                config: json!({}),
                personal_owner: Some("ann"),
                deleted: false,
            },
            Vw {
                key: "tasksold",
                name: "Old filter",
                ty: "grid",
                config: json!({}),
                personal_owner: None,
                deleted: true,
            },
        ];
        out.push(tasks);
    }

    // Sales/Clients: exactly one rich text field, so it becomes the page. Names in other cases.
    {
        let t = "clients";
        let mut clients = tbl(
            t,
            "sales",
            "Clients",
            2.0,
            vec![
                text("name", "Name"),
                fld("email", "Email", "email", json!({})),
                fld("phone", "Phone", "phone", json!({})),
                fld("site", "Site", "url", json!({})),
                fld(
                    "rating",
                    "Rating",
                    "rating",
                    json!({"max": 5, "icon": "star", "color": "yellow"}),
                ),
                rich("brief", "Brief"),
                date("deadline", "DEADLINE"),
                check("completed", "Completed"),
                fld(
                    "owner",
                    "Owner",
                    "user",
                    json!({"multiple": false, "notify": false}),
                ),
                fld("logo", "Logo", "attachment", json!({})),
            ],
            vec![
                rec(
                    1,
                    vec![
                        ("name", json!("Initech")),
                        ("email", json!("hello@initech.example")),
                        ("phone", json!("+1 555 0100")),
                        ("site", json!("https://initech.example")),
                        ("rating", json!(4)),
                        (
                            "brief",
                            json!("# Brief\n\nBuilds **TPS reports**.\n\n- one\n- two\n"),
                        ),
                        ("deadline", json!("2026-12-01")),
                        ("owner", json!([id::user("ann")])),
                        (
                            "logo",
                            json!([{"id": "attlogo", "filename": "logo.png", "mime": "image/png",
                                      "size": 4096, "width": 64, "height": 64}]),
                        ),
                    ],
                ),
                rec(
                    2,
                    vec![
                        ("name", json!("Globex")),
                        ("email", json!("info@globex.example")),
                        ("brief", json!("Plain paragraph with `code`.")),
                        ("completed", json!(true)),
                    ],
                ),
                rec(3, vec![("name", json!("Umbrella"))]),
            ],
        );
        clients.views = vec![Vw {
            key: "clientsform",
            name: "New client form",
            ty: "form",
            config: json!({}),
            personal_owner: None,
            deleted: false,
        }];
        out.push(clients);
    }

    // Sales/Meetings: two rich text fields (a new page is needed); When beats Start by name.
    {
        let mut m = tbl(
            "meetings",
            "sales",
            "Meetings",
            3.0,
            vec![
                text("topic", "Topic"),
                date_time("start", "Start", None),
                date_time("when", "When", Some("Europe/Paris")),
                rich("agenda", "Agenda"),
                rich("minutes", "Minutes"),
                check("attended", "Attended"),
            ],
            vec![
                rec(
                    1,
                    vec![
                        ("topic", json!("Kickoff")),
                        ("start", json!("2026-11-10T09:00:00.000Z")),
                        ("when", json!("2026-11-10T14:30:00.000Z")),
                        ("agenda", json!("1. Intro\n2. Plan")),
                        ("minutes", json!("Agreed on **everything**.")),
                        ("attended", json!(true)),
                    ],
                ),
                rec(
                    2,
                    vec![
                        ("topic", json!("Retro")),
                        ("when", json!("2026-11-20T10:00:00.000Z")),
                    ],
                ),
            ],
        );
        m.views = vec![Vw {
            key: "meetingsagenda",
            name: "Agenda only",
            ty: "grid",
            config: json!({"hidden_fields": [id::field("meetings", "minutes")]}),
            personal_owner: None,
            deleted: false,
        }];
        out.push(m);
    }

    // Name collisions with the new page property.
    out.push(tbl(
        "pagea",
        "sales",
        "Collision A",
        4.0,
        vec![text("name", "Name"), text("page", "Page")],
        vec![rec(
            1,
            vec![("name", json!("a1")), ("page", json!("not a page"))],
        )],
    ));
    out.push(tbl(
        "pageb",
        "sales",
        "Collision B",
        5.0,
        vec![
            text("name", "Name"),
            text("pagelo", "page"),
            number("page2", "Page 2"),
        ],
        vec![rec(
            1,
            vec![
                ("name", json!("b1")),
                ("pagelo", json!("lower")),
                ("page2", json!(2)),
            ],
        )],
    ));
    out.push(tbl(
        "pagec",
        "sales",
        "Collision C",
        6.0,
        vec![
            text("name", "Name"),
            rich("body", "Body"),
            trashed(rich("draft", "Draft")),
        ],
        vec![rec(
            1,
            vec![
                ("name", json!("c1")),
                ("body", json!("the live one")),
                ("draft", json!("in the trash")),
            ],
        )],
    ));
    out.push(tbl(
        "paged",
        "sales",
        "Collision D",
        7.0,
        vec![
            text("name", "Name"),
            rich("pg", "Page"),
            rich("extra", "Extra"),
        ],
        vec![rec(
            1,
            vec![
                ("name", json!("d1")),
                ("pg", json!("page one")),
                ("extra", json!("extra")),
            ],
        )],
    ));

    // Wrong-typed decoys: a text "Due" and a text "Done" must not be picked.
    out.push(tbl(
        "habits",
        "sales",
        "Habits",
        8.0,
        vec![
            text("name", "Name"),
            text("duetext", "Due"),
            date("date", "Date"),
            text("donetext", "Done"),
            check("complete", "complete"),
        ],
        vec![
            rec(
                1,
                vec![
                    ("name", json!("Stretch")),
                    ("duetext", json!("tomorrow")),
                    ("date", json!("2026-11-11")),
                    ("donetext", json!("yes")),
                    ("complete", json!(true)),
                ],
            ),
            rec(2, vec![("name", json!("Read"))]),
        ],
    ));

    // Trashed tables: none gets a page, even the one with exactly one rich text field.
    {
        let mut old = tbl(
            "oldnotes",
            "sales",
            "Old notes",
            9.0,
            vec![
                text("name", "Name"),
                date("due", "Due"),
                check("done", "Done"),
            ],
            vec![rec(
                1,
                vec![("name", json!("gone")), ("due", json!("2026-01-01"))],
            )],
        );
        old.deleted = true;
        out.push(old);
        let mut docs = tbl(
            "olddocs",
            "sales",
            "Old docs",
            10.0,
            vec![text("name", "Name"), rich("doc", "Doc")],
            vec![rec(
                1,
                vec![("name", json!("gone doc")), ("doc", json!("old text"))],
            )],
        );
        docs.deleted = true;
        out.push(docs);
    }

    out.push(everything());

    // Sales copy: a project tied with Sales on position, created later.
    out.push(tbl(
        "copyitems",
        "sales2",
        "Items",
        1.0,
        vec![text("name", "Name"), number("qty", "Qty")],
        vec![rec(1, vec![("name", json!("bolt")), ("qty", json!(10))])],
    ));
    out.push(tbl(
        "archived",
        "archive",
        "Archived things",
        1.0,
        vec![text("name", "Name"), rich("memo", "Memo")],
        vec![rec(
            1,
            vec![("name", json!("kept")), ("memo", json!("still here"))],
        )],
    ));

    // Operations: 120 records, so the v1 list has a second page.
    {
        let t = "inventory";
        let records = (1..=120)
            .map(|n| {
                let mut cells = vec![
                    ("sku", json!(format!("SKU-{n:04}"))),
                    ("qty", json!(n * 3 % 17)),
                    ("price", json!(f64::from(n) * 1.25)),
                ];
                if n % 3 == 0 {
                    cells.push(("instock", json!(true)));
                }
                if n % 5 == 0 {
                    cells.push(("received", json!(format!("2026-10-{:02}", n % 28 + 1))));
                }
                if n % 7 == 0 {
                    cells.push(("kind", json!(id::choice(t, "kind", "Part"))));
                }
                rec((n % 60) as i64, cells)
            })
            .collect();
        out.push(tbl(
            t,
            "ops",
            "Inventory",
            1.0,
            vec![
                text("sku", "SKU"),
                number("qty", "Qty"),
                fld(
                    "price",
                    "Price",
                    "currency",
                    json!({"precision": 2, "symbol": "$", "allow_negative": true}),
                ),
                check("instock", "In stock"),
                date("received", "Received"),
                select(t, "kind", "Kind", &["Part", "Tool"], false),
            ],
            records,
        ));
    }
    out.push(tbl(
        "scratch",
        "ops",
        "Scratch",
        2.0,
        vec![text("name", "Name")],
        Vec::new(),
    ));

    // Wide tables: 500 live fields (at the limit, so no page) and 499 (room for exactly one).
    for (key, n) in [("wide500", 500usize), ("wide499", 499)] {
        let fields = (1..=n)
            .map(|i| {
                // Letters and digits only, and unique per table; fields cannot be `&'static`.
                let k: &'static str = Box::leak(format!("f{i}").into_boxed_str());
                text(k, &format!("F{i}"))
            })
            .collect();
        let last: &'static str = Box::leak(format!("f{n}").into_boxed_str());
        out.push(tbl(
            key,
            "wide",
            if n == 500 {
                "At the limit"
            } else {
                "One below"
            },
            if n == 500 { 1.0 } else { 2.0 },
            fields,
            vec![
                rec(
                    1,
                    vec![
                        ("f1", json!("first")),
                        ("f2", json!("second")),
                        (last, json!("last")),
                    ],
                ),
                rec(2, vec![("f1", json!("again"))]),
            ],
        ));
    }

    // Beta: one table each in the winning project and in one of the losers.
    out.push(tbl(
        "goals",
        "betaz",
        "Goals",
        1.0,
        vec![
            text("name", "Name"),
            check("done", "Done"),
            date("deadline", "Deadline"),
        ],
        vec![
            rec(
                1,
                vec![
                    ("name", json!("Ship it")),
                    ("deadline", json!("2026-12-24")),
                ],
            ),
            rec(2, vec![("name", json!("Rest")), ("done", json!(true))]),
        ],
    ));
    out.push(tbl(
        "reading",
        "betax",
        "Reading",
        1.0,
        vec![text("name", "Name"), rich("review", "Review")],
        vec![rec(
            1,
            vec![("name", json!("A book")), ("review", json!("Good."))],
        )],
    ));

    // Carol's trashed workspace with a live project.
    out.push(tbl(
        "gonething",
        "gonebase",
        "Thing",
        1.0,
        vec![text("name", "Name")],
        vec![rec(1, vec![("name", json!("x"))])],
    ));

    out
}

/// One field of every type, a filled record and two more.
fn everything() -> Tbl {
    let t = "everything";
    let f = |k: &str| id::field(t, k);
    let tf = |k: &str| id::field("tasks", k);
    let fields = vec![
        text("title", "Title"),
        long("long", "Long"),
        rich("rich", "Rich"),
        fld(
            "num",
            "Num",
            "number",
            json!({"precision": 2, "allow_negative": true}),
        ),
        fld(
            "cur",
            "Cur",
            "currency",
            json!({"precision": 2, "symbol": "EUR", "allow_negative": true}),
        ),
        fld(
            "pct",
            "Pct",
            "percent",
            json!({"precision": 1, "allow_negative": true}),
        ),
        fld("dur", "Dur", "duration", json!({"format": "h_mm_ss"})),
        fld(
            "rate",
            "Rate",
            "rating",
            json!({"max": 5, "icon": "star", "color": "yellow"}),
        ),
        check("check", "Check"),
        select(t, "sel", "Sel", &["Red", "Green"], false),
        select(t, "multi", "Multi", &["x", "y", "z"], true),
        date("day", "Day"),
        date_time("moment", "Moment", Some("Europe/Paris")),
        fld("email", "Email", "email", json!({})),
        fld("url", "Url", "url", json!({})),
        fld("phone", "Phone", "phone", json!({})),
        fld("files", "Files", "attachment", json!({})),
        fld(
            "owner",
            "Owner",
            "user",
            json!({"multiple": false, "notify": false}),
        ),
        fld(
            "team",
            "Team",
            "user",
            json!({"multiple": true, "notify": false}),
        ),
        fld("code", "Code", "barcode", json!({})),
        fld(
            "links",
            "Links",
            "link",
            json!({"linked_table_id": id::table("tasks"), "inverse_field_id": tf("everything"),
                   "single": false}),
        ),
        fld(
            "calc",
            "Calc",
            "formula",
            json!({"expression": format!("{{{}}} * 2", f("num")), "result_type": "number"}),
        ),
        fld(
            "names",
            "Names",
            "lookup",
            json!({"link_field_id": f("links"), "target_field_id": tf("title"),
                   "result_type": {"array": "text"}}),
        ),
        fld(
            "hoursum",
            "HourSum",
            "rollup",
            json!({"link_field_id": f("links"), "target_field_id": tf("hours"),
                   "expression": "SUM(values)", "result_type": "number"}),
        ),
        fld("cnt", "Cnt", "count", json!({"link_field_id": f("links")})),
        fld(
            "created",
            "Created",
            "created_time",
            json!({"include_time": true, "date_format": "iso", "time_format": "h24"}),
        ),
        fld(
            "modified",
            "Modified",
            "last_modified_time",
            json!({"fields": [], "date": {"include_time": true, "date_format": "iso", "time_format": "h24"}}),
        ),
        fld("createdby", "CreatedBy", "created_by", json!({})),
        fld(
            "modifiedby",
            "ModifiedBy",
            "last_modified_by",
            json!({"fields": [], "date": {}}),
        ),
        fld("auto", "Auto", "autonumber", json!({})),
        fld(
            "btn",
            "Btn",
            "button",
            json!({"label": "Open", "url_formula": "\"https://example.com/\""}),
        ),
    ];
    let records = vec![
        rec(
            1,
            vec![
                ("title", json!("Everything one")),
                ("long", json!("first line\nsecond line")),
                (
                    "rich",
                    json!("## Heading\n\nSome *rich* text with a [link](https://example.com)."),
                ),
                ("num", json!(12.5)),
                ("cur", json!(99.99)),
                ("pct", json!(0.256)),
                ("dur", json!(3725)),
                ("rate", json!(3)),
                ("check", json!(true)),
                ("sel", json!(id::choice(t, "sel", "Red"))),
                (
                    "multi",
                    json!([id::choice(t, "multi", "x"), id::choice(t, "multi", "z")]),
                ),
                ("day", json!("2026-11-07")),
                ("moment", json!("2026-11-07T13:45:00.000Z")),
                ("email", json!("someone@example.com")),
                ("url", json!("https://example.com/path?q=1")),
                ("phone", json!("+44 20 7946 0958")),
                (
                    "files",
                    json!([{"id": "attspec", "filename": "spec.pdf", "mime": "application/pdf", "size": 1234}]),
                ),
                ("owner", json!([id::user("ann")])),
                ("team", json!([id::user("olive"), id::user("ann")])),
                ("code", json!("4006381333931")),
                (
                    "links",
                    json!([id::record("tasks", 1), id::record("tasks", 2)]),
                ),
                ("calc", json!(25)),
                ("names", json!(["Write the spec", "Book the venue"])),
                ("hoursum", json!(8.5)),
                ("cnt", json!(2)),
            ],
        ),
        rec(
            2,
            vec![
                ("title", json!("Everything two")),
                ("num", json!(-3)),
                ("links", json!([id::record("tasks", 2)])),
                ("calc", json!(-6)),
                ("names", json!(["Book the venue"])),
                ("hoursum", json!(2)),
                ("cnt", json!(1)),
            ],
        ),
        rec(
            3,
            vec![("title", json!("Everything three, otherwise empty"))],
        ),
    ];
    tbl(t, "sales", "Everything", 11.0, fields, records)
}

// ------------------------------------------------------------------ seeding

fn rows(conn: &Connection, sql: &str, args: impl rusqlite::Params) {
    conn.execute(sql, args)
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

struct Wsp {
    key: &'static str,
    name: &'static str,
    color: &'static str,
    created_by: &'static str,
    created_at: i64,
    deleted: bool,
}

struct Bse {
    key: &'static str,
    workspace: &'static str,
    name: &'static str,
    position: f64,
    created_at: i64,
    deleted: bool,
}

fn workspaces() -> Vec<Wsp> {
    let w = |key, name, color, created_by, created_at, deleted| Wsp {
        key,
        name,
        color,
        created_by,
        created_at,
        deleted,
    };
    vec![
        w("acme", "Acme", "green", "olive", 1_000, false),
        w("beta", "Beta", "blue", "olive", 2_000, false),
        w("empty", "Empty", "purple", "carol", 3_000, false),
        w("fresh", "Fresh", "orange", "carol", 4_000, false),
        w("gone", "Gone", "gray", "carol", 5_000, true),
        w("gone2", "Gone too", "teal", "carol", 6_000, true),
    ]
}

fn bases() -> Vec<Bse> {
    let b = |key, workspace, name, position, created_at, deleted| Bse {
        key,
        workspace,
        name,
        position,
        created_at,
        deleted,
    };
    vec![
        b("archive", "acme", "Archive", 0.0, 100, true),
        b("sales", "acme", "Sales", 1.0, 200, false),
        b("sales2", "acme", "Sales copy", 1.0, 300, false),
        b("ops", "acme", "Operations", 2.0, 150, false),
        b("wide", "acme", "Wide", 3.0, 400, false),
        b("betax", "beta", "Reading", 1.0, 200, false),
        b("betay", "beta", "Yearly", 1.0, 100, false),
        b("betaz", "beta", "Goals", 1.0, 100, false),
        b("betaq", "beta", "Later", 2.0, 1, false),
        b("emptyold", "empty", "Old stuff", 1.0, 10, true),
        b("gonebase", "gone", "Gone base", 1.0, 20, false),
    ]
}

/// Create the v15 database at `path` (which must not exist) and seed it.
pub fn build(path: &Path) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    for (i, sql) in MIGRATIONS_V15.iter().enumerate() {
        conn.execute_batch(sql)
            .unwrap_or_else(|e| panic!("migration {}: {e}", i + 1));
    }
    conn.execute_batch("PRAGMA user_version = 15").unwrap();
    seed(&conn);
}

fn seed(conn: &Connection) {
    seed_users(conn);
    for w in workspaces() {
        rows(
            conn,
            "INSERT INTO workspaces (id, name, created_by, created_at, deleted_at, color, deleted_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id::workspace(w.key),
                w.name,
                id::user(w.created_by),
                w.created_at,
                w.deleted.then_some(9_000_000_i64),
                w.color,
                w.deleted.then(|| id::user(w.created_by)),
            ],
        );
    }
    for b in bases() {
        rows(
            conn,
            "INSERT INTO bases (id, workspace_id, name, color, position, created_by, created_at, deleted_at)
             VALUES (?1, ?2, ?3, 'blue', ?4, ?5, ?6, ?7)",
            params![
                id::base(b.key),
                id::workspace(b.workspace),
                b.name,
                b.position,
                id::user("olive"),
                b.created_at,
                b.deleted.then_some(9_000_000_i64),
            ],
        );
    }
    seed_memberships(conn);
    for t in tables() {
        seed_table(conn, &t);
    }
    seed_extras(conn);
}

fn seed_users(conn: &Connection) {
    for (key, name, email) in [
        ("olive", "Olive Owner", "olive@example.com"),
        ("ann", "Ann Editor", "ann@example.com"),
        ("bob", "Bob Viewer", "bob@example.com"),
        ("carol", "Carol Other", "carol@example.com"),
    ] {
        rows(
            conn,
            "INSERT INTO users (id, email, name, password_hash, created_at, updated_at, intro_seen, accent)
             VALUES (?1, ?2, ?3, 'not-a-real-hash', 500, 500, 1, ?4)",
            params![id::user(key), email, name, (key == "ann").then_some("purple")],
        );
    }
}

fn seed_memberships(conn: &Connection) {
    let member = |ws: &str, user: &str, role: &str, all_bases: bool| {
        rows(
            conn,
            "INSERT INTO workspace_members (workspace_id, user_id, role, all_bases, created_at)
             VALUES (?1, ?2, ?3, ?4, 600)",
            params![id::workspace(ws), id::user(user), role, all_bases],
        );
    };
    member("acme", "olive", "owner", true);
    member("acme", "ann", "editor", true);
    member("acme", "bob", "viewer", false);
    rows(
        conn,
        "INSERT INTO workspace_member_bases (workspace_id, user_id, base_id) VALUES (?1, ?2, ?3)",
        params![id::workspace("acme"), id::user("bob"), id::base("sales")],
    );
    member("beta", "olive", "owner", true);
    for ws in ["empty", "fresh", "gone", "gone2"] {
        member(ws, "carol", "owner", true);
    }
    for (name, user, token) in [
        ("olive", "olive", OLIVE_TOKEN),
        ("bob", "bob", BOB_TOKEN),
        ("carol", "carol", CAROL_TOKEN),
    ] {
        rows(
            conn,
            "INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 700)",
            params![
                format!("pat{name}"),
                id::user(user),
                name,
                openbase::ids::hash_token(token),
                json!({"write": true, "base_ids": null}).to_string(),
            ],
        );
    }
}

fn seed_table(conn: &Connection, t: &Tbl) {
    let table_id = id::table(t.key);
    let primary = id::field(t.key, t.fields[0].key);
    rows(
        conn,
        "INSERT INTO tables (id, base_id, name, description, position, primary_field_id,
                             next_autonumber, created_at, deleted_at, deleted_by, icon)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 800, ?8, ?9, ?10)",
        params![
            table_id,
            id::base(t.base),
            t.name,
            (t.key == "tasks").then_some("What needs doing"),
            t.position,
            primary,
            t.records.len() as i64 + 1,
            t.deleted.then_some(9_000_000_i64),
            t.deleted.then(|| id::user("olive")),
            (t.key == "clients").then_some("briefcase"),
        ],
    );
    for (i, f) in t.fields.iter().enumerate() {
        rows(
            conn,
            "INSERT INTO fields (id, table_id, name, type, options, position, created_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 810, ?7)",
            params![
                id::field(t.key, f.key),
                table_id,
                f.name,
                f.ty,
                f.options.to_string(),
                (i + 1) as f64,
                f.deleted.then_some(9_000_000_i64),
            ],
        );
    }
    rows(
        conn,
        "INSERT INTO views (id, table_id, name, type, config, position, locked, created_at, is_default)
         VALUES (?1, ?2, 'Default grid', 'grid', ?3, 0, 0, 820, 1)",
        params![id::default_view(t.key), table_id, t.default_config.to_string()],
    );
    for (i, v) in t.views.iter().enumerate() {
        rows(
            conn,
            "INSERT INTO views (id, table_id, name, type, config, position, personal_owner_id,
                                locked, created_by, created_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, 830, ?9)",
            params![
                id::view(v.key),
                table_id,
                v.name,
                v.ty,
                v.config.to_string(),
                (i + 1) as f64,
                v.personal_owner.map(id::user),
                id::user("olive"),
                v.deleted.then_some(9_000_000_i64),
            ],
        );
    }
    for (n, r) in t.records.iter().enumerate() {
        let mut data = Map::new();
        for (key, value) in &r.cells {
            data.insert(id::field(t.key, key), value.clone());
        }
        rows(
            conn,
            "INSERT INTO records (id, table_id, data, position, autonumber, created_at, created_by,
                                  updated_at, updated_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id::record(t.key, n + 1),
                table_id,
                Value::Object(data).to_string(),
                (n + 1) as f64,
                (n + 1) as i64,
                r.created_at,
                id::user("olive"),
                r.created_at + 3_600_000,
                id::user("ann"),
            ],
        );
    }
}

/// Everything that is not a cell: an attachment, comments, history, inbox drafts, a trashed
/// record, a notification. None of it may change in an upgrade.
fn seed_extras(conn: &Connection) {
    for (att, name, mime, base) in [
        ("attlogo", "logo.png", "image/png", "sales"),
        ("attspec", "spec.pdf", "application/pdf", "sales"),
    ] {
        rows(
            conn,
            "INSERT INTO attachments (id, sha256, filename, mime, size, base_id, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, 1234, ?5, ?6, 900)",
            params![att, openbase::ids::hash_token(att), name, mime, id::base(base), id::user("olive")],
        );
    }
    rows(
        conn,
        "UPDATE records SET deleted_at = 9000000, deleted_by = ?2 WHERE id = ?1",
        params![id::record("tasks", 4), id::user("olive")],
    );
    rows(
        conn,
        "INSERT INTO comments (id, record_id, user_id, body, created_at, updated_at)
         VALUES ('comone', ?1, ?2, 'Looks **good** to me', 1000, 1000)",
        params![id::record("tasks", 1), id::user("ann")],
    );
    rows(
        conn,
        "INSERT INTO record_history (record_id, table_id, user_id, kind, changes, created_at)
         VALUES (?1, ?2, ?3, 'update', ?4, 1100)",
        params![
            id::record("tasks", 1),
            id::table("tasks"),
            id::user("ann"),
            json!({ id::field("tasks", "title"): {"old": "Write spec", "new": "Write the spec"} })
                .to_string(),
        ],
    );
    rows(
        conn,
        "INSERT INTO inbox_items (id, user_id, title, body, attachments, created_at, updated_at)
         VALUES ('inbdraft', ?1, 'Call the bank', 'before Friday', '[]', 1200, 1200)",
        params![id::user("olive")],
    );
    rows(
        conn,
        "INSERT INTO notifications (id, user_id, kind, payload, created_at)
         VALUES ('ntfone', ?1, 'mention', '{}', 1300)",
        params![id::user("ann")],
    );
    rows(
        conn,
        "INSERT INTO settings (key, value) VALUES ('instance_name', 'fixture')",
        [],
    );
}

// ------------------------------------------------------------------ checksums

/// A digest of every cell of every record (live and trashed): record id, field id and the value's
/// JSON, in a fixed order. This is the DONE-7 checksum; the upgrade must not change it. Also
/// returns the number of cells, so a test can see that it covers something.
pub fn cell_checksum(conn: &Connection) -> (String, usize) {
    use sha2::{Digest, Sha256};
    let mut stmt = conn
        .prepare("SELECT id, table_id, data FROM records ORDER BY id")
        .unwrap();
    let mut hasher = Sha256::new();
    let mut cells = 0;
    let mut rows = stmt.query([]).unwrap();
    while let Some(r) = rows.next().unwrap() {
        let (id, table, data): (String, String, String) =
            (r.get(0).unwrap(), r.get(1).unwrap(), r.get(2).unwrap());
        let data: Map<String, Value> = serde_json::from_str(&data).unwrap();
        let sorted: std::collections::BTreeMap<_, _> = data.iter().collect();
        for (field, value) in sorted {
            hasher.update(format!("{table}\u{1}{id}\u{1}{field}\u{1}{value}\u{2}"));
            cells += 1;
        }
    }
    (hex::encode(hasher.finalize()), cells)
}

/// Number of live records per table id (trashed records included under their table).
pub fn record_counts(conn: &Connection) -> std::collections::BTreeMap<String, (i64, i64)> {
    let mut stmt = conn
        .prepare(
            "SELECT table_id, count(*), count(deleted_at) FROM records GROUP BY table_id ORDER BY table_id",
        )
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}
