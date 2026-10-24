//! Record order through MCP: a position for new records, `move_records`, `duplicate_records`, and
//! who can restore a deleted record.

mod common;
mod mcp_support;

use mcp_support::*;
use serde_json::{Value, json};

/// The Name of every record of the table in manual order.
async fn order(r: &Rig, table: &str) -> Vec<String> {
    let out = r
        .agent
        .call(
            "list_records",
            json!({"project_id": r.base, "table": table, "max_records": 200}),
        )
        .await;
    out["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["fields"]["Name"].as_str().unwrap().to_string())
        .collect()
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn id_of(created: &Value, i: usize) -> String {
    created[i]["id"].as_str().unwrap().to_string()
}

async fn tasks(r: &Rig) -> Vec<String> {
    r.table("Tasks").await;
    let created = r
        .records(
            "Tasks",
            json!([
                {"fields": {"Name": "A"}}, {"fields": {"Name": "B"}},
                {"fields": {"Name": "C"}}, {"fields": {"Name": "D"}}
            ]),
        )
        .await;
    (0..4).map(|i| id_of(&created, i)).collect()
}

fn new_rec(name: &str) -> Value {
    json!({"fields": {"Name": name}})
}

#[tokio::test]
async fn create_records_takes_a_position() {
    let r = Rig::new().await;
    let ids = tasks(&r).await;
    let b = r.base.as_str();
    let create = |extra: Value, names: &[&str]| {
        let mut args = json!({"project_id": b, "table": "Tasks",
            "records": names.iter().map(|n| new_rec(n)).collect::<Vec<_>>()});
        for (k, v) in extra.as_object().unwrap() {
            args[k] = v.clone();
        }
        args
    };
    let a = &r.agent;

    a.call(
        "create_records",
        create(json!({"position": "top"}), &["T1", "T2"]),
    )
    .await;
    assert_eq!(
        order(&r, "Tasks").await,
        strings(&["T1", "T2", "A", "B", "C", "D"]),
        "several records keep their order at the top"
    );
    a.call(
        "create_records",
        create(json!({"position": "bottom"}), &["Z"]),
    )
    .await;
    a.call(
        "create_records",
        create(json!({"after_record_id": ids[1]}), &["AfterB"]),
    )
    .await;
    a.call(
        "create_records",
        create(
            json!({"before_record_id": ids[2]}),
            &["BeforeC", "BeforeC2"],
        ),
    )
    .await;
    assert_eq!(
        order(&r, "Tasks").await,
        strings(&[
            "T1", "T2", "A", "B", "AfterB", "BeforeC", "BeforeC2", "C", "D", "Z"
        ])
    );
    // No position: the end, as before.
    a.call("create_records", create(json!({}), &["End"])).await;
    assert_eq!(order(&r, "Tasks").await.last().unwrap(), "End");

    let e = a
        .fails(
            "create_records",
            create(
                json!({"position": "top", "after_record_id": ids[0]}),
                &["X"],
            ),
        )
        .await;
    assert!(e.contains("only one of position"), "{e}");
    let e = a
        .fails(
            "create_records",
            create(json!({"position": "middle"}), &["X"]),
        )
        .await;
    assert!(e.contains("\"top\" or \"bottom\""), "{e}");
    let e = a
        .fails(
            "create_records",
            create(json!({"after_record_id": "recNope"}), &["X"]),
        )
        .await;
    assert!(e.contains("recNope"), "{e}");
}

#[tokio::test]
async fn move_records_to_the_top_bottom_or_next_to_a_record() {
    let r = Rig::new().await;
    let ids = tasks(&r).await;
    let b = r.base.as_str();
    let a = &r.agent;
    let mv = |record_ids: &[&String], extra: Value| {
        let mut args = json!({"project_id": b, "table": "Tasks", "record_ids": record_ids});
        for (k, v) in extra.as_object().unwrap() {
            args[k] = v.clone();
        }
        args
    };

    let out = a
        .call("move_records", mv(&[&ids[3]], json!({"position": "top"})))
        .await;
    assert_eq!(out["count"], 1);
    assert_eq!(order(&r, "Tasks").await, strings(&["D", "A", "B", "C"]));
    a.call(
        "move_records",
        mv(&[&ids[0]], json!({"position": "bottom"})),
    )
    .await;
    assert_eq!(order(&r, "Tasks").await, strings(&["D", "B", "C", "A"]));
    a.call(
        "move_records",
        mv(&[&ids[2], &ids[1]], json!({"after_record_id": ids[0]})),
    )
    .await;
    assert_eq!(
        order(&r, "Tasks").await,
        strings(&["D", "A", "C", "B"]),
        "the moved records keep the order given"
    );
    a.call(
        "move_records",
        mv(&[&ids[0]], json!({"before_record_id": ids[3]})),
    )
    .await;
    assert_eq!(order(&r, "Tasks").await, strings(&["A", "D", "C", "B"]));
    // The first record to the top again: nothing to do, still fine.
    a.call("move_records", mv(&[&ids[0]], json!({"position": "top"})))
        .await;
    assert_eq!(order(&r, "Tasks").await, strings(&["A", "D", "C", "B"]));
    // Several to the top, none of them the current first.
    a.call(
        "move_records",
        mv(&[&ids[1], &ids[2]], json!({"position": "top"})),
    )
    .await;
    assert_eq!(order(&r, "Tasks").await, strings(&["B", "C", "A", "D"]));

    let e = a.fails("move_records", mv(&[&ids[0]], json!({}))).await;
    assert!(e.contains("Say where to put them"), "{e}");
    let e = a
        .fails(
            "move_records",
            mv(
                &[&ids[0]],
                json!({"position": "top", "before_record_id": ids[1]}),
            ),
        )
        .await;
    assert!(e.contains("only one of"), "{e}");
    let e = a
        .fails(
            "move_records",
            mv(&[&ids[0]], json!({"after_record_id": ids[0]})),
        )
        .await;
    assert!(e.contains("cannot be one of the moved records"), "{e}");
    let e = a
        .fails(
            "move_records",
            json!({"project_id": b, "table": "Tasks", "record_ids": [], "position": "top"}),
        )
        .await;
    assert!(e.contains("at least one record"), "{e}");
    let e = a
        .fails(
            "move_records",
            mv(&[&"recNope".to_string()], json!({"position": "top"})),
        )
        .await;
    assert!(e.contains("recNope"), "{e}");

    // A viewer token cannot move.
    let read = r.agent_with(json!({"write": false})).await;
    assert!(
        !read
            .tool_names()
            .await
            .contains(&"move_records".to_string())
    );
}

#[tokio::test]
async fn duplicate_records_copies_next_to_the_original() {
    let r = Rig::new().await;
    r.table("Items").await;
    r.field("Items", "Qty", "number", json!({})).await;
    r.field(
        "Items",
        "Double",
        "formula",
        json!({"expression": "{Qty}*2"}),
    )
    .await;
    r.field(
        "Items",
        "Kind",
        "single_select",
        json!({"choices": ["Big", "Small"]}),
    )
    .await;
    let created = r
        .records(
            "Items",
            json!([
                {"fields": {"Name": "First", "Qty": 2, "Kind": "Big"}},
                {"fields": {"Name": "Second", "Qty": 5}}
            ]),
        )
        .await;
    let (first, second) = (id_of(&created, 0), id_of(&created, 1));
    let a = &r.agent;
    let out = a
        .call(
            "duplicate_records",
            json!({"project_id": r.base, "table": "Items", "record_ids": [second, first]}),
        )
        .await;
    assert_eq!(out["count"], 2);
    assert_eq!(out["duplicated"][0]["original_id"], second.as_str());
    assert_eq!(out["duplicated"][1]["original_id"], first.as_str());
    assert_eq!(
        order(&r, "Items").await,
        strings(&["First", "First", "Second", "Second"])
    );
    let copy_of_first = out["duplicated"][1]["id"].as_str().unwrap();
    let copy = a
        .call(
            "get_record",
            json!({"project_id": r.base, "table": "Items", "record_id": copy_of_first}),
        )
        .await;
    assert_eq!(copy["fields"]["Qty"], 2);
    assert_eq!(copy["fields"]["Kind"], "Big");
    assert_eq!(
        copy["fields"]["Double"], 4.0,
        "computed fields are worked out again"
    );
    let list = a
        .call(
            "list_records",
            json!({"project_id": r.base, "table": "Items"}),
        )
        .await;
    assert_eq!(
        list["records"][1]["id"], copy_of_first,
        "right after the original"
    );

    let e = a
        .fails(
            "duplicate_records",
            json!({"project_id": r.base, "table": "Items", "record_ids": ["recNope"]}),
        )
        .await;
    assert!(e.contains("recNope"), "{e}");
    let e = a
        .fails(
            "duplicate_records",
            json!({"project_id": r.base, "table": "Items", "record_ids": []}),
        )
        .await;
    assert!(e.contains("at least one"), "{e}");
    assert_eq!(
        order(&r, "Items").await.len(),
        4,
        "a failed call copies nothing"
    );
}

#[tokio::test]
async fn an_editor_agent_restores_the_records_it_deleted_itself() {
    let r = Rig::new().await;
    r.table("Tasks").await;
    let created = r
        .records("Tasks", json!([new_rec("Mine"), new_rec("Theirs")]))
        .await;
    let (mine, theirs) = (id_of(&created, 0), id_of(&created, 1));
    let (_user, editor) = r
        .teammate("ed@example.com", "editor", json!({"write": true}))
        .await;
    // The administrator deletes one, the editor the other.
    r.agent
        .call(
            "delete_records",
            json!({"project_id": r.base, "table": "Tasks", "record_ids": [theirs]}),
        )
        .await;
    editor
        .call(
            "delete_records",
            json!({"project_id": r.base, "table": "Tasks", "record_ids": [mine]}),
        )
        .await;

    let listed = editor
        .call("list_trash", json!({"project_id": r.base}))
        .await;
    let items = listed["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{listed}");
    assert_eq!(items[0]["id"], mine.as_str());
    let all = r
        .agent
        .call("list_trash", json!({"project_id": r.base}))
        .await;
    assert_eq!(all["items"].as_array().unwrap().len(), 2);

    let e = editor
        .fails(
            "restore_from_trash",
            json!({"kind": "record", "id": theirs}),
        )
        .await;
    assert!(
        e.contains("only the records they deleted themselves"),
        "{e}"
    );
    editor
        .call("restore_from_trash", json!({"kind": "record", "id": mine}))
        .await;
    assert_eq!(order(&r, "Tasks").await, strings(&["Mine"]));
    r.agent
        .call(
            "restore_from_trash",
            json!({"kind": "record", "id": theirs}),
        )
        .await;
    assert_eq!(order(&r, "Tasks").await, strings(&["Mine", "Theirs"]));
}
