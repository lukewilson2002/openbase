//! Forms beyond a flat list of questions: show-if conditions, headings and text blocks, field
//! defaults and descriptions, and telling people about responses.

mod common;
mod query_support;
mod records_support;
mod schema_support;
mod share_support;

use openbase::perm::Role;
use serde_json::{Value, json};
use share_support::*;

struct Logic {
    p: People,
    doing: String,
    notes: String,
    view: String,
    token: String,
}

impl Logic {
    fn f(&self) -> &Fixture {
        &self.p.f
    }
    fn view_url(&self) -> String {
        format!("/api/views/{}", self.view)
    }
    fn def(&self) -> String {
        format!("/api/public/forms/{}", self.token)
    }
    async fn submit(&self, values: Value) -> common::Response {
        pub_post(
            &self.f().app,
            &format!("/api/public/forms/{}/submit", self.token),
            json!({ "values": values }),
        )
        .await
    }
    /// The records of the table, newest last, with their stored data.
    async fn records(&self) -> Vec<Value> {
        let body = self
            .f()
            .query_view(&self.f().view_id, json!({ "limit": 100 }))
            .await;
        body["records"].as_array().cloned().unwrap_or_default()
    }
    /// Save the form with `show_if` on its `index`th entry.
    async fn save_show_if(&self, index: usize, show_if: Value) -> common::Response {
        let mut c = self.config().await;
        c["form"]["fields"][index]["show_if"] = show_if;
        self.f()
            .app
            .patch(&self.f().owner, &self.view_url(), json!({ "config": c }))
            .await
    }
    async fn config(&self) -> Value {
        let t = self.f().table(&self.f().table_id).await;
        t["views"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == json!(self.view))
            .unwrap()["config"]
            .clone()
    }
}

/// A form: Name (required), Status, then Age (required) shown only while Status is Doing, a
/// heading, and Notes (whose description is "Anything we should know?").
async fn logic_with(config: impl FnOnce(&mut openbase::config::Config)) -> Logic {
    let p = people_with(config).await;
    let f = &p.f;
    let t = f.table_id.clone();
    let schema = f.table(&t).await;
    let choices = schema["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == json!(p.status))
        .unwrap()["options"]["choices"]
        .clone();
    let doing = choices
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "Doing")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let notes = f.notes_id.clone();
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{notes}"),
            json!({ "description": "Anything we should know?" }),
        )
        .await
        .assert_status(200);
    let view = f
        .view_of(
            &t,
            "Intake",
            "form",
            json!({
                "form": {
                    "title": "Intake",
                    "fields": [
                        { "field_id": p.name, "required": true },
                        { "field_id": p.status },
                        { "block": "heading", "label": "About the work" },
                        { "field_id": p.age, "required": true,
                          "show_if": { "conjunction": "and", "items": [
                              { "field_id": p.status, "op": "is", "value": doing } ] } },
                        { "block": "text", "help": "Tell us **more** below.",
                          "show_if": { "conjunction": "and", "items": [
                              { "field_id": p.status, "op": "is", "value": doing } ] } },
                        { "field_id": notes },
                    ],
                },
            }),
        )
        .await;
    let share = f.share(&view, "form", None).await;
    Logic {
        doing,
        notes,
        view,
        token: share["token"].as_str().unwrap().to_string(),
        p,
    }
}

async fn logic() -> Logic {
    logic_with(|_| {}).await
}

fn stored(rec: &Value, field: &str) -> Value {
    rec["values"][field].clone()
}

// ------------------------------------------------------------------- show-if

#[tokio::test]
async fn a_hidden_question_is_ignored_and_not_required() {
    let l = logic().await;
    let before = l.records().await.len();
    // Status is not Doing: Age is hidden, so not required and not stored even when sent.
    l.submit(json!({ &l.p.name: "Zed", &l.p.status: "Todo" }))
        .await
        .assert_status(200);
    l.submit(json!({ &l.p.name: "Yan", &l.p.status: "Todo", &l.p.age: 50 }))
        .await
        .assert_status(200);
    let recs = l.records().await;
    assert_eq!(recs.len(), before + 2);
    let yan = recs.iter().find(|r| stored(r, &l.p.name) == "Yan").unwrap();
    assert!(stored(yan, &l.p.age).is_null(), "{yan}");
    // Shown: Age is required again, and kept.
    let r = l
        .submit(json!({ &l.p.name: "Xi", &l.p.status: "Doing" }))
        .await;
    r.assert_status(400);
    assert!(r.body["error"]["message"].as_str().unwrap().contains("Age"));
    l.submit(json!({ &l.p.name: "Xi", &l.p.status: "Doing", &l.p.age: 7 }))
        .await
        .assert_status(200);
    let recs = l.records().await;
    let xi = recs.iter().find(|r| stored(r, &l.p.name) == "Xi").unwrap();
    assert_eq!(stored(xi, &l.p.age), json!(7));
}

#[tokio::test]
async fn a_hidden_answer_is_not_even_checked() {
    let l = logic().await;
    // A value the field could not hold, in a question that is hidden, does no harm.
    l.submit(json!({ &l.p.name: "Wu", &l.p.status: "Todo", &l.p.age: "not a number" }))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn a_condition_reads_only_the_questions_shown_above_it() {
    let l = logic().await;
    let f = l.f();
    // Notes appears only when Age is filled in; Age itself depends on Status.
    let mut c = l.config().await;
    let notes_entry = c["form"]["fields"].as_array().unwrap().len() - 1;
    c["form"]["fields"][notes_entry]["show_if"] = json!({ "conjunction": "and", "items": [
        { "field_id": l.p.age, "op": "is_not_empty" } ] });
    f.app
        .patch(&f.owner, &l.view_url(), json!({ "config": c }))
        .await
        .assert_status(200);
    // Status Todo: Age hidden, so unanswered, so Notes stays hidden although it was sent.
    l.submit(json!({ &l.p.name: "Vi", &l.p.status: "Todo", &l.p.age: 4, &l.notes: "hello" }))
        .await
        .assert_status(200);
    let recs = l.records().await;
    let vi = recs.iter().find(|r| stored(r, &l.p.name) == "Vi").unwrap();
    assert!(stored(vi, &l.notes).is_null(), "{vi}");
    l.submit(json!({ &l.p.name: "Ty", &l.p.status: "Doing", &l.p.age: 4, &l.notes: "hello" }))
        .await
        .assert_status(200);
    let recs = l.records().await;
    let ty = recs.iter().find(|r| stored(r, &l.p.name) == "Ty").unwrap();
    assert_eq!(stored(ty, &l.notes), json!("hello"));
}

#[tokio::test]
async fn the_definition_carries_the_conditions() {
    let l = logic().await;
    let r = pub_get(&l.f().app, &l.def()).await;
    r.assert_status(200);
    let fields = r.body["fields"].as_array().unwrap();
    let age = fields.iter().find(|f| f["id"] == json!(l.p.age)).unwrap();
    assert_eq!(age["show_if"]["items"][0]["field_id"], json!(l.p.status));
    assert_eq!(age["show_if"]["items"][0]["value"], json!(l.doing));
    let name = fields.iter().find(|f| f["id"] == json!(l.p.name)).unwrap();
    assert!(name["show_if"].is_null());
}

#[tokio::test]
async fn show_if_conditions_are_checked_when_the_form_is_saved() {
    let l = logic().await;
    let cond = |field: &str, op: &str, value: Value| json!({ "conjunction": "and", "items": [{ "field_id": field, "op": op, "value": value }] });
    // Age (index 3) may not read Notes, which comes after it.
    let r = l
        .save_show_if(3, cond(&l.notes, "is_not_empty", Value::Null))
        .await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("above")
    );
    // A date question cannot be tested.
    l.save_show_if(5, cond(&l.p.due, "is_empty", Value::Null))
        .await
        .assert_status(400);
    // An operator that does not suit the question.
    l.save_show_if(3, cond(&l.p.status, "contains", json!("x")))
        .await
        .assert_status(400);
    // An unknown field.
    l.save_show_if(3, cond("fldNope", "is_empty", Value::Null))
        .await
        .assert_status(400);
    // A condition that is fine.
    l.save_show_if(5, cond(&l.p.age, "gt", json!(3)))
        .await
        .assert_status(200);
}

// ------------------------------------------------------------------- blocks

#[tokio::test]
async fn headings_and_text_come_with_the_form_in_order() {
    let l = logic().await;
    let r = pub_get(&l.f().app, &l.def()).await;
    r.assert_status(200);
    let fields = r.body["fields"].as_array().unwrap();
    let kinds: Vec<Value> = fields.iter().map(|f| f["block"].clone()).collect();
    assert_eq!(
        kinds,
        [
            Value::Null,
            Value::Null,
            json!("heading"),
            Value::Null,
            json!("text"),
            Value::Null
        ]
    );
    assert_eq!(fields[2]["label"], "About the work");
    assert_eq!(fields[4]["help"], "Tell us **more** below.");
    let id = fields[2]["id"].as_str().unwrap();
    assert!(id.starts_with("blk"), "{id}");
    // The saved form keeps the made-up id.
    let c = l.config().await;
    assert_eq!(c["form"]["fields"][2]["field_id"], json!(id));
    // Nothing is submitted for a block.
    l.submit(json!({ &l.p.name: "Q", id: "x" }))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn a_block_with_no_text_is_not_shown() {
    let l = logic().await;
    let f = l.f();
    let mut c = l.config().await;
    c["form"]["fields"][2]["label"] = json!("  ");
    f.app
        .patch(&f.owner, &l.view_url(), json!({ "config": c }))
        .await
        .assert_status(200);
    let r = pub_get(&f.app, &l.def()).await;
    let kinds: Vec<Value> = r.body["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["block"].clone())
        .collect();
    assert_eq!(kinds.iter().filter(|k| *k == "heading").count(), 0);
    assert_eq!(kinds.iter().filter(|k| *k == "text").count(), 1);
}

// ------------------------------------------------- defaults and descriptions

#[tokio::test]
async fn defaults_and_descriptions_show_and_a_cleared_default_stays_cleared() {
    let l = logic().await;
    let f = l.f();
    // Memo is a text field with the default "x" and a description; the form asks for it last.
    let memo = id_of(
        &f.add_field(
            &f.table_id,
            json!({ "name": "Memo", "type": "text", "description": "Anything we should know?",
                    "options": { "default": "x" } }),
        )
        .await,
    );
    let mut c = l.config().await;
    c["form"]["fields"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "field_id": memo }));
    f.app
        .patch(&f.owner, &l.view_url(), json!({ "config": c }))
        .await
        .assert_status(200);
    let def = || async {
        let r = pub_get(&f.app, &l.def()).await;
        r.body["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == json!(memo))
            .unwrap()
            .clone()
    };
    let shown = def().await;
    assert_eq!(shown["default"], "x");
    assert_eq!(shown["help"], "Anything we should know?");
    // The form's own help wins over the description.
    let mut c = l.config().await;
    let last = c["form"]["fields"].as_array().unwrap().len() - 1;
    c["form"]["fields"][last]["help"] = json!("Our help");
    f.app
        .patch(&f.owner, &l.view_url(), json!({ "config": c }))
        .await
        .assert_status(200);
    assert_eq!(def().await["help"], "Our help");
    // Left blank on the form: the visitor saw the default and cleared it, so it stays empty.
    l.submit(json!({ &l.p.name: "Cleared", &l.p.status: "Todo" }))
        .await
        .assert_status(200);
    // Sent as it was: stored.
    l.submit(json!({ &l.p.name: "Kept", &l.p.status: "Todo", &memo: "x" }))
        .await
        .assert_status(200);
    let recs = l.records().await;
    let cleared = recs
        .iter()
        .find(|r| stored(r, &l.p.name) == "Cleared")
        .unwrap();
    assert!(stored(cleared, &memo).is_null(), "{cleared}");
    let kept = recs
        .iter()
        .find(|r| stored(r, &l.p.name) == "Kept")
        .unwrap();
    assert_eq!(stored(kept, &memo), json!("x"));
    // A field the form does not ask for still gets its default.
    let mut c = l.config().await;
    c["form"]["fields"].as_array_mut().unwrap().pop();
    f.app
        .patch(&f.owner, &l.view_url(), json!({ "config": c }))
        .await
        .assert_status(200);
    l.submit(json!({ &l.p.name: "Unasked", &l.p.status: "Todo" }))
        .await
        .assert_status(200);
    let recs = l.records().await;
    let unasked = recs
        .iter()
        .find(|r| stored(r, &l.p.name) == "Unasked")
        .unwrap();
    assert_eq!(stored(unasked, &memo), json!("x"));
}

// ------------------------------------------------------------------- notify

async fn notifications(l: &Logic, who: &common::Client) -> Vec<Value> {
    let r = l.f().app.get(who, "/api/notifications").await;
    r.assert_status(200);
    r.body["notifications"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

#[tokio::test]
async fn people_the_form_notifies_hear_about_each_response() {
    let l = logic_with(|c| c.smtp_host = Some("smtp.example.com".into())).await;
    let f = l.f();
    let editor = f.member("ed@x.io", Role::Editor);
    let outsider = f.app.user("out@x.io", "Out");
    let editor_id = editor.user_id.clone().unwrap();
    // Not a member of the project: refused.
    let mut c = l.config().await;
    c["form"]["notify_user_ids"] = json!([outsider.user_id.clone().unwrap()]);
    f.app
        .patch(&f.owner, &l.view_url(), json!({ "config": c.clone() }))
        .await
        .assert_status(400);
    c["form"]["notify_user_ids"] = json!([editor_id, editor_id]);
    let r = f
        .app
        .patch(&f.owner, &l.view_url(), json!({ "config": c }))
        .await;
    r.assert_status(200);
    assert_eq!(
        r.body["config"]["form"]["notify_user_ids"],
        json!([editor_id])
    );
    // The public definition does not name them.
    let def = pub_get(&f.app, &l.def()).await;
    assert!(!def.body.to_string().contains(&editor_id));
    // A response notifies them: in the app and by email.
    l.submit(json!({ &l.p.name: "N1", &l.p.status: "Todo" }))
        .await
        .assert_status(200);
    let got = notifications(&l, &editor).await;
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(got[0]["kind"], "form_response");
    assert_eq!(got[0]["payload"]["form_name"], "Intake");
    assert_eq!(got[0]["payload"]["base_id"], json!(f.base_id));
    assert!(got[0]["payload"]["record_id"].is_string());
    let sent = f.app.mailer.wait_for(1).await;
    assert_eq!(sent[0].to, "ed@x.io");
    // The owner is not on the list and hears nothing.
    assert!(notifications(&l, &f.owner).await.is_empty());
    // A refused submission notifies nobody.
    l.submit(json!({ &l.p.status: "Todo" }))
        .await
        .assert_status(400);
    assert_eq!(notifications(&l, &editor).await.len(), 1);
}

#[tokio::test]
async fn an_editor_may_change_who_is_notified_while_the_link_is_on() {
    let l = logic().await;
    let f = l.f();
    let editor = f.member("ed2@x.io", Role::Editor);
    let mut c = l.config().await;
    c["form"]["notify_user_ids"] = json!([editor.user_id.clone().unwrap()]);
    f.app
        .patch(&editor, &l.view_url(), json!({ "config": c.clone() }))
        .await
        .assert_status(200);
    // Anything else about the form still needs a creator.
    c["form"]["title"] = json!("Changed");
    f.app
        .patch(&editor, &l.view_url(), json!({ "config": c }))
        .await
        .assert_status(403);
}
