//! Public forms: the definition endpoint, anonymous submission (validation,
//! provenance, events, automations hook), file uploads and abuse limits.

mod common;
mod query_support;
mod records_support;
mod schema_support;
mod share_support;

use openbase::engine::write;
use serde_json::{Value, json};
use share_support::*;

struct Form {
    p: People,
    notes: String,
    files: String,
    orders_link: String,
    assignee: String,
    extra: String,
    view: String,
    token: String,
    share_id: String,
}

impl Form {
    fn app(&self) -> &common::TestApp {
        &self.p.f.app
    }
    fn def(&self) -> String {
        format!("/api/public/forms/{}", self.token)
    }
    fn submit_path(&self) -> String {
        format!("/api/public/forms/{}/submit", self.token)
    }
    fn upload_path(&self) -> String {
        format!("/api/public/forms/{}/attachments", self.token)
    }
    async fn submit(&self, values: Value) -> common::Response {
        pub_post(self.app(), &self.submit_path(), json!({ "values": values })).await
    }
    fn count(&self) -> i64 {
        count(
            self.app(),
            "SELECT count(*) FROM records WHERE table_id = ?1",
            &self.p.f.table_id,
        )
    }
}

/// A form over Table 1: Name (required), Age, Status, Tags, Due, Done, Notes
/// (relabelled, with help), Files; Done is listed but hidden in the view, a
/// link and a user field are listed too, and `Extra` is not on the form.
async fn form() -> Form {
    form_with(|_| {}).await
}

async fn form_with(config: impl FnOnce(&mut openbase::config::Config)) -> Form {
    let p = people_with(config).await;
    let f = &p.f;
    let t = f.table_id.clone();
    let notes = f.notes_id.clone();
    let files = id_of(&f.attachment_field(&t, "Files").await);
    let orders = id_of(&f.add_table("Orders").await);
    let orders_link = id_of(&f.add_link(&t, "Orders", &orders).await);
    let assignee = id_of(
        &f.add_field(
            &t,
            json!({ "name": "Assignee", "type": "user", "options": {} }),
        )
        .await,
    );
    let extra = id_of(&f.number(&t, "Extra").await);
    let auto = id_of(
        &f.add_field(
            &t,
            json!({ "name": "Auto", "type": "autonumber", "options": {} }),
        )
        .await,
    );
    let _ = auto;
    let view = f
        .view_of(
            &t,
            "Contact us",
            "form",
            json!({
                "hidden_fields": [p.done],
                "form": {
                    "title": "Tell us more",
                    "description": "We read everything.",
                    "submit_label": "Send it",
                    "success_message": "Got it!",
                    "redirect_url": "https://example.com/thanks",
                    "show_submit_another": true,
                    "fields": [
                        { "field_id": p.name, "required": true },
                        { "field_id": p.age },
                        { "field_id": p.status, "required": false },
                        { "field_id": p.tags },
                        { "field_id": p.due },
                        { "field_id": p.done },
                        { "field_id": notes, "label": "Comments", "help": "Anything else?" },
                        { "field_id": files },
                        { "field_id": orders_link },
                        { "field_id": assignee },
                    ],
                },
            }),
        )
        .await;
    let share = f.share(&view, "form", None).await;
    Form {
        notes,
        files,
        orders_link,
        assignee,
        extra,
        view,
        token: share["token"].as_str().unwrap().to_string(),
        share_id: share["id"].as_str().unwrap().to_string(),
        p,
    }
}

// -------------------------------------------------------------- definition

#[tokio::test]
async fn form_definition_lists_only_collectable_visible_fields() {
    let fm = form().await;
    let r = pub_get(fm.app(), &fm.def()).await;
    r.assert_status(200);
    assert_eq!(r.body["title"], "Tell us more");
    assert_eq!(r.body["description"], "We read everything.");
    assert_eq!(r.body["submit_label"], "Send it");
    assert_eq!(r.body["success_message"], "Got it!");
    assert_eq!(r.body["redirect_url"], "https://example.com/thanks");
    assert_eq!(r.body["show_submit_another"], true);
    assert_eq!(r.body["base_name"], "CRM");
    assert_eq!(r.body["table_name"], "Table 1");
    let p = &fm.p;
    let ids: Vec<&str> = r.body["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    // Hidden (Done), link and user fields are not offered; neither is Extra.
    assert_eq!(
        ids,
        [
            p.name.as_str(),
            p.age.as_str(),
            p.status.as_str(),
            p.tags.as_str(),
            p.due.as_str(),
            fm.notes.as_str(),
            fm.files.as_str(),
        ]
    );
    let by_id = |id: &str| {
        r.body["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["id"] == id)
            .cloned()
            .unwrap()
    };
    let name = by_id(&p.name);
    assert_eq!(
        (name["required"].clone(), name["label"].clone()),
        (json!(true), json!("Name"))
    );
    assert_eq!(name["type"], "single_line_text");
    let notes = by_id(&fm.notes);
    assert_eq!(notes["label"], "Comments");
    assert_eq!(notes["help"], "Anything else?");
    assert_eq!(notes["required"], false);
    let status = by_id(&p.status);
    assert_eq!(status["type"], "single_select");
    let choices: Vec<&str> = status["options"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(choices, ["Todo", "Doing", "Done"]);
    assert_eq!(by_id(&fm.files)["type"], "attachment");
    let raw = r.body.to_string();
    for leak in [
        fm.orders_link.as_str(),
        fm.assignee.as_str(),
        fm.extra.as_str(),
        p.done.as_str(),
    ] {
        assert!(!raw.contains(leak), "{leak} is not on the form: {raw}");
    }
    assert!(r.headers[axum::http::header::CACHE_CONTROL] == "no-store");
}

#[tokio::test]
async fn form_text_has_sensible_defaults_and_unsafe_redirects_are_dropped() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    // A form view created without a config starts with every editable field.
    let created = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{t}/views"),
            json!({ "name": "Signup", "type": "form" }),
        )
        .await;
    created.assert_status(201);
    let view = id_of(&created.body);
    let token = f.share(&view, "form", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let r = pub_get(&f.app, &format!("/api/public/forms/{token}")).await;
    r.assert_status(200);
    assert_eq!(r.body["title"], "Signup");
    assert_eq!(r.body["submit_label"], "Submit");
    assert!(!r.body["success_message"].as_str().unwrap().is_empty());
    assert_eq!(r.body["redirect_url"], Value::Null);
    assert_eq!(r.body["fields"].as_array().unwrap().len(), 7);
    // Update the form: a non-http redirect cannot be configured at all.
    let bad = f
        .app
        .patch(
            &f.owner,
            &format!("/api/views/{view}"),
            json!({ "config": { "form": { "redirect_url": "javascript:alert(1)" } } }),
        )
        .await;
    bad.assert_status(400);
}

#[tokio::test]
async fn form_fields_deleted_after_the_form_was_built_disappear() {
    let fm = form().await;
    let f = &fm.p.f;
    f.app
        .delete(&f.owner, &format!("/api/fields/{}", fm.p.tags))
        .await
        .assert_status(200);
    let r = pub_get(fm.app(), &fm.def()).await;
    let ids: Vec<&str> = r.body["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["id"].as_str().unwrap())
        .collect();
    assert!(!ids.contains(&fm.p.tags.as_str()));
    let r = fm
        .submit(json!({ &fm.p.name: "x", &fm.p.tags: ["a"] }))
        .await;
    r.assert_status(400);
}

#[tokio::test]
async fn view_and_form_tokens_are_not_interchangeable() {
    let fm = form().await;
    let f = &fm.p.f;
    pub_get(fm.app(), &format!("/api/public/shares/{}", fm.token))
        .await
        .assert_status(404);
    pub_post(
        fm.app(),
        &format!("/api/public/shares/{}/query", fm.token),
        json!({}),
    )
    .await
    .assert_status(404);
    let view_token = f.share(&f.view_id, "view", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    pub_get(fm.app(), &format!("/api/public/forms/{view_token}"))
        .await
        .assert_status(404);
    pub_post(
        fm.app(),
        &format!("/api/public/forms/{view_token}/submit"),
        json!({ "values": { &fm.p.name: "sneaky" } }),
    )
    .await
    .assert_status(404);
    assert_eq!(fm.count(), 5);
}

// ------------------------------------------------------------------ submit

#[tokio::test]
async fn submit_creates_an_anonymous_record() {
    let fm = form().await;
    let p = &fm.p;
    let before = fm.count();
    let mut events = fm.app().state.events.subscribe(&p.f.base_id);
    write::start_recording(&p.f.base_id);
    let r = fm
        .submit(json!({
            &p.name: "Zed Visitor",
            &p.age: 33,
            &p.status: "Doing",
            &p.tags: ["a", "b"],
            &p.due: "2026-05-06",
            &fm.notes: "hello\nworld",
        }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body, json!({ "ok": true }));
    assert!(r.headers[axum::http::header::CACHE_CONTROL] == "no-store");
    assert_eq!(fm.count(), before + 1);

    // Read the record back with the owner's credentials.
    let all = p.f.query(json!({ "search": "Zed" })).await;
    assert_eq!(all["total"], 1);
    let rec = &all["records"][0];
    assert_eq!(rec["values"][&p.name], "Zed Visitor");
    assert_eq!(rec["values"][&p.age], 33);
    assert_eq!(rec["values"][&p.due], "2026-05-06");
    assert_eq!(rec["values"][&fm.notes], "hello\nworld");
    assert_eq!(rec["values"][&p.tags].as_array().unwrap().len(), 2);
    // Written anonymously: no creator, no editor.
    assert_eq!(rec["created_by"], Value::Null);
    assert_eq!(rec["updated_by"], Value::Null);
    let id = rec["id"].as_str().unwrap();
    let history = p.f.history(id);
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].0, "create");
    assert_eq!(history[0].2, None, "history row has no user");

    // The write published a change event (so the query cache and SSE clients refresh)...
    let env = events.try_recv().expect("an event was published");
    assert_eq!(env.base_id, p.f.base_id);
    assert_eq!(env.user_id, None);
    match &env.event {
        ob_core::api::events::BaseEvent::RecordsChanged {
            created, table_id, ..
        } => {
            assert_eq!(created, &vec![id.to_string()]);
            assert_eq!(table_id, &p.f.table_id);
        }
        other => panic!("{other:?}"),
    }
    // ...and the automations hook saw a form submission with no user.
    let calls = write::take_recorded(&p.f.base_id);
    write::stop_recording(&p.f.base_id);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].created, vec![id.to_string()]);
    assert_eq!(calls[0].form_view_id.as_deref(), Some(fm.view.as_str()));
    assert_eq!(calls[0].user_id, None);
}

#[tokio::test]
async fn submit_is_visible_in_cached_view_queries_immediately() {
    let fm = form().await;
    let before = fm.p.f.query(json!({})).await["total"].as_i64().unwrap();
    fm.submit(json!({ &fm.p.name: "Fresh" }))
        .await
        .assert_status(200);
    let after = fm.p.f.query(json!({})).await["total"].as_i64().unwrap();
    assert_eq!(after, before + 1);
}

#[tokio::test]
async fn submit_reads_values_leniently_like_a_browser_form() {
    let fm = form().await;
    let p = &fm.p;
    // Numbers and dates as typed text, select by name in any case.
    let r = fm
        .submit(json!({ &p.name: "Typed", &p.age: "41", &p.status: "todo", &p.due: "2026-06-07" }))
        .await;
    r.assert_status(200);
    let rec = &p.f.query(json!({ "search": "Typed" })).await["records"][0];
    assert_eq!(rec["values"][&p.age], 41);
    assert_eq!(rec["values"][&p.due], "2026-06-07");
    let todo = p.f.choice_id(&p.f.table_id, "Status", "Todo").await;
    assert_eq!(rec["values"][&p.status], todo);
}

#[tokio::test]
async fn required_fields_must_be_filled() {
    let fm = form().await;
    let p = &fm.p;
    let before = fm.count();
    for values in [
        json!({}),
        json!({ &p.age: 3 }),
        json!({ &p.name: "" }),
        json!({ &p.name: "   " }),
        json!({ &p.name: null, &p.age: 3 }),
    ] {
        let r = fm.submit(values.clone()).await;
        r.assert_status(400);
        assert_eq!(r.body["error"]["code"], "bad_request", "{values}");
    }
    let r = fm.submit(json!({ &p.age: 3 })).await;
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Name")
    );
    assert_eq!(fm.count(), before, "nothing was written");
}

#[tokio::test]
async fn a_required_checkbox_must_be_checked() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let view = f
        .view_of(
            &t,
            "Terms",
            "form",
            json!({ "form": { "fields": [
                { "field_id": p.name, "required": true },
                { "field_id": p.done, "required": true },
            ] } }),
        )
        .await;
    let token = f.share(&view, "form", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let path = format!("/api/public/forms/{token}/submit");
    for done in [json!(false), json!(null)] {
        let r = pub_post(
            &f.app,
            &path,
            json!({ "values": { &p.name: "A", &p.done: done } }),
        )
        .await;
        r.assert_status(400);
    }
    pub_post(
        &f.app,
        &path,
        json!({ "values": { &p.name: "A", &p.done: true } }),
    )
    .await
    .assert_status(200);
}

#[tokio::test]
async fn fields_outside_the_form_are_rejected() {
    let fm = form().await;
    let p = &fm.p;
    let before = fm.count();
    // Not on the form, hidden in the view, link, user, system and unknown ids.
    for key in [
        fm.extra.as_str(),
        p.done.as_str(),
        fm.orders_link.as_str(),
        fm.assignee.as_str(),
        "created_by",
        "fldDOESNOTEXIST",
        "Name",
    ] {
        let r = fm.submit(json!({ &p.name: "x", key: 1 })).await;
        r.assert_status(400);
        assert!(
            r.body["error"]["message"].as_str().unwrap().contains(key),
            "{key}: {}",
            r.body
        );
    }
    // A computed field of the table cannot be written through the form either.
    let auto = fm.p.f.field(&fm.p.f.table_id, "Auto").await;
    fm.submit(json!({ &p.name: "x", auto["id"].as_str().unwrap(): 99 }))
        .await
        .assert_status(400);
    assert_eq!(fm.count(), before);
}

#[tokio::test]
async fn invalid_values_are_rejected_and_never_create_choices() {
    let fm = form().await;
    let p = &fm.p;
    let before = fm.count();
    let r = fm
        .submit(json!({ &p.name: "x", &p.status: "Brand new" }))
        .await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Brand new")
    );
    let r = fm
        .submit(json!({ &p.name: "x", &p.tags: ["a", "zzz"] }))
        .await;
    r.assert_status(400);
    for (field, bad) in [
        (&p.age, json!("abc")),
        (&p.due, json!("not a date")),
        (&p.age, json!({"a": 1})),
    ] {
        fm.submit(json!({ &p.name: "x", field: bad }))
            .await
            .assert_status(400);
    }
    let r = fm.submit(json!({ &p.name: "x".repeat(200_000) })).await;
    assert!(r.status == 400 || r.status == 413, "{}", r.status);
    // The choices of the select fields are unchanged.
    let status = fm.p.f.field(&fm.p.f.table_id, "Status").await;
    assert_eq!(status["options"]["choices"].as_array().unwrap().len(), 3);
    assert_eq!(fm.count(), before);
    // Malformed bodies are enveloped errors.
    let r = pub_post(fm.app(), &fm.submit_path(), json!({ "nope": 1 })).await;
    r.assert_status(400);
    assert_eq!(r.body["error"]["code"], "bad_request");
}

#[tokio::test]
async fn an_empty_submission_is_rejected() {
    let p = people().await;
    let f = &p.f;
    // A form where nothing is required.
    let view = f
        .view_of(
            &f.table_id,
            "Opt",
            "form",
            json!({ "form": { "fields": [ { "field_id": p.age } ] } }),
        )
        .await;
    let token = f.share(&view, "form", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let path = format!("/api/public/forms/{token}/submit");
    let r = pub_post(&f.app, &path, json!({ "values": {} })).await;
    r.assert_status(400);
    let r = pub_post(&f.app, &path, json!({ "values": { &p.age: null } })).await;
    r.assert_status(400);
    pub_post(&f.app, &path, json!({ "values": { &p.age: 5 } }))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn a_form_with_no_collectable_fields_rejects_submissions() {
    let p = people().await;
    let f = &p.f;
    let view = f
        .view_of(
            &f.table_id,
            "Empty",
            "form",
            json!({ "form": { "fields": [] } }),
        )
        .await;
    let token = f.share(&view, "form", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let def = pub_get(&f.app, &format!("/api/public/forms/{token}")).await;
    assert_eq!(def.body["fields"], json!([]));
    pub_post(
        &f.app,
        &format!("/api/public/forms/{token}/submit"),
        json!({ "values": {} }),
    )
    .await
    .assert_status(400);
}

#[tokio::test]
async fn disabled_deleted_and_protected_forms() {
    let fm = form().await;
    let f = &fm.p.f;
    let id = fm.share_id.clone();
    f.app
        .patch(
            &f.owner,
            &format!("/api/shares/{id}"),
            json!({ "enabled": false }),
        )
        .await
        .assert_status(200);
    pub_get(fm.app(), &fm.def()).await.assert_status(404);
    fm.submit(json!({ &fm.p.name: "x" }))
        .await
        .assert_status(404);
    pub_post(fm.app(), &fm.upload_path(), json!({}))
        .await
        .assert_status(404);
    f.app
        .patch(
            &f.owner,
            &format!("/api/shares/{id}"),
            json!({ "enabled": true, "password": "form-pass" }),
        )
        .await
        .assert_status(200);
    // Protected: nothing is revealed or written without the password.
    let r = pub_get(fm.app(), &fm.def()).await;
    assert_eq!(r.body["error"]["code"], "share_password_required");
    let before = fm.count();
    let r = fm.submit(json!({ &fm.p.name: "x" })).await;
    r.assert_status(401);
    assert_eq!(r.body["error"]["code"], "share_password_required");
    let r = pub_post_pw(
        fm.app(),
        &fm.submit_path(),
        json!({ "values": { &fm.p.name: "x" } }),
        "wrong",
    )
    .await;
    assert_eq!(r.body["error"]["code"], "share_password_invalid");
    assert_eq!(fm.count(), before);
    pub_get_pw(fm.app(), &fm.def(), "form-pass")
        .await
        .assert_status(200);
    pub_post_pw(
        fm.app(),
        &fm.submit_path(),
        json!({ "values": { &fm.p.name: "with password" } }),
        "form-pass",
    )
    .await
    .assert_status(200);
    assert_eq!(fm.count(), before + 1);
    // Deleting the form view closes the link.
    f.app
        .delete(&f.owner, &format!("/api/views/{}", fm.view))
        .await
        .assert_status(200);
    fm.submit(json!({ &fm.p.name: "x" }))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn submissions_respect_the_table_record_limit() {
    // Fill the table to its cap directly in the database, then submit.
    let fm = form().await;
    let t = fm.p.f.table_id.clone();
    schema_support::sql(fm.app(), |tx| {
        tx.execute(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
             INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at)
             SELECT 'recfill' || i, ?1, '{}', 1000 + i, 1000 + i, 1, 1 FROM n",
            [&t],
        )
    });
    let r = fm.submit(json!({ &fm.p.name: "one too many" })).await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("at most")
    );
}

#[tokio::test]
async fn submissions_are_rate_limited_per_client_and_form() {
    let fm = form().await;
    let limit = openbase::api::sharing::SUBMIT_LIMIT as usize;
    let body = json!({ "values": { &fm.p.name: "spam" } });
    for i in 0..limit {
        let r = anon(
            fm.app(),
            "POST",
            &fm.submit_path(),
            Some(body.clone()),
            &[],
            "192.0.2.9",
        )
        .await;
        assert_eq!(r.status, 200, "submission {i}");
    }
    let r = anon(
        fm.app(),
        "POST",
        &fm.submit_path(),
        Some(body.clone()),
        &[],
        "192.0.2.9",
    )
    .await;
    r.assert_status(429);
    assert_eq!(r.body["error"]["code"], "too_many_requests");
    // Another visitor can still submit; reading the form is not limited by it.
    anon(
        fm.app(),
        "POST",
        &fm.submit_path(),
        Some(body),
        &[],
        "192.0.2.10",
    )
    .await
    .assert_status(200);
    anon(fm.app(), "GET", &fm.def(), None, &[], "192.0.2.9")
        .await
        .assert_status(200);
}

// ------------------------------------------------------------ attachments

#[tokio::test]
async fn upload_then_submit_attaches_the_file() {
    let fm = form().await;
    let p = &fm.p;
    let up = post_multipart(
        fm.app(),
        &fm.app().anon(),
        &fm.upload_path(),
        &[("file", Some("cv.png"), &png(8, 8))],
        &[],
    )
    .await;
    up.assert_status(200);
    assert!(up.body["id"].as_str().unwrap().starts_with("att"));
    assert_eq!(up.body["filename"], "cv.png");
    assert_eq!(up.body["mime"], "image/png");
    assert!(up.headers[axum::http::header::CACHE_CONTROL] == "no-store");
    // The row belongs to the base and has no uploader.
    let aid = up.body["id"].as_str().unwrap().to_string();
    let (base, by): (String, Option<String>) = schema_support::sql(fm.app(), |tx| {
        tx.query_row(
            "SELECT base_id, created_by FROM attachments WHERE id = ?1",
            [&aid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    });
    assert_eq!((base, by), (p.f.base_id.clone(), None));

    let r = fm
        .submit(json!({ &p.name: "With file", &fm.files: [up.body.clone()] }))
        .await;
    r.assert_status(200);
    let rec = &p.f.query(json!({ "search": "With file" })).await["records"][0];
    assert_eq!(rec["values"][&fm.files][0]["id"], aid);
    assert_eq!(rec["values"][&fm.files][0]["filename"], "cv.png");
    // The owner can download it through the normal route.
    let dl =
        p.f.app
            .get(&p.f.owner, &format!("/api/attachments/{aid}/cv.png"))
            .await;
    dl.assert_status(200);
}

#[tokio::test]
async fn submitted_attachment_references_are_rebuilt_from_the_database() {
    let fm = form().await;
    let p = &fm.p;
    let up = post_multipart(
        fm.app(),
        &fm.app().anon(),
        &fm.upload_path(),
        &[("file", Some("a.txt"), b"data")],
        &[],
    )
    .await;
    let mut forged = up.body.clone();
    forged["filename"] = json!("forged.exe");
    forged["size"] = json!(1);
    fm.submit(json!({ &p.name: "Forger", &fm.files: [forged] }))
        .await
        .assert_status(200);
    let rec = &p.f.query(json!({ "search": "Forger" })).await["records"][0];
    assert_eq!(rec["values"][&fm.files][0]["filename"], "a.txt");
    assert_eq!(rec["values"][&fm.files][0]["size"], 4);
    // An attachment id from another base (or invented) is refused.
    let other = base(fm.app(), &p.f.owner, &p.f.ws, "Other").await;
    let foreign = post_multipart(
        fm.app(),
        &p.f.owner,
        &format!("/api/bases/{}/attachments", other["id"].as_str().unwrap()),
        &[("file", Some("x.txt"), b"x")],
        &[],
    )
    .await;
    fm.submit(json!({ &p.name: "F", &fm.files: [foreign.body.clone()] }))
        .await
        .assert_status(400);
    fm.submit(json!({ &p.name: "F", &fm.files: [{ "id": "attNOPE" }] }))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn uploads_need_a_file_field_on_the_form_and_respect_limits() {
    let fm = form().await;
    // Not multipart / no file part.
    let r = pub_post(fm.app(), &fm.upload_path(), json!({ "a": 1 })).await;
    r.assert_status(400);
    let r = post_multipart(
        fm.app(),
        &fm.app().anon(),
        &fm.upload_path(),
        &[("other", None, b"x")],
        &[],
    )
    .await;
    r.assert_status(400);
    // Too big: the test config allows 5 MB.
    let big = vec![b'x'; 6 * 1024 * 1024];
    let r = post_multipart(
        fm.app(),
        &fm.app().anon(),
        &fm.upload_path(),
        &[("file", Some("big.bin"), &big)],
        &[],
    )
    .await;
    r.assert_status(413);
    assert_eq!(r.body["error"]["code"], "payload_too_large");
    // A form without an attachment field accepts no uploads at all.
    let p = &fm.p;
    let plain =
        p.f.view_of(
            &p.f.table_id,
            "Plain",
            "form",
            json!({ "form": { "fields": [ { "field_id": p.name } ] } }),
        )
        .await;
    let token = p.f.share(&plain, "form", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let r = post_multipart(
        fm.app(),
        &fm.app().anon(),
        &format!("/api/public/forms/{token}/attachments"),
        &[("file", Some("a.txt"), b"x")],
        &[],
    )
    .await;
    r.assert_status(400);
    // View links cannot be used to upload.
    let view_token = p.f.share(&p.f.view_id, "view", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let r = post_multipart(
        fm.app(),
        &fm.app().anon(),
        &format!("/api/public/forms/{view_token}/attachments"),
        &[("file", Some("a.txt"), b"x")],
        &[],
    )
    .await;
    r.assert_status(404);
    // Nothing was stored by any of the failures.
    assert_eq!(
        count(
            fm.app(),
            "SELECT count(*) FROM attachments WHERE base_id = ?1",
            &p.f.base_id
        ),
        0
    );
}

#[tokio::test]
async fn the_public_upload_cap_is_lower_than_the_configured_limit() {
    // With a generous server limit the public form still stops at 25 MB.
    let p = { Fixture::with_config(|c| c.max_upload_mb = 100).await };
    let t = p.table_id.clone();
    let files = id_of(&p.attachment_field(&t, "Files").await);
    let view = p
        .view_of(
            &t,
            "F",
            "form",
            json!({ "form": { "fields": [ { "field_id": files } ] } }),
        )
        .await;
    let token = p.share(&view, "form", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let big = vec![b'x'; 26 * 1024 * 1024];
    let r = post_multipart(
        &p.app,
        &p.app.anon(),
        &format!("/api/public/forms/{token}/attachments"),
        &[("file", Some("big.bin"), &big)],
        &[],
    )
    .await;
    r.assert_status(413);
    let ok = vec![b'x'; 2 * 1024 * 1024];
    post_multipart(
        &p.app,
        &p.app.anon(),
        &format!("/api/public/forms/{token}/attachments"),
        &[("file", Some("ok.bin"), &ok)],
        &[],
    )
    .await
    .assert_status(200);
}

#[tokio::test]
async fn uploads_are_rate_limited_and_protected_by_the_password() {
    let fm = form().await;
    let limit = openbase::api::sharing::UPLOAD_LIMIT as usize;
    for i in 0..limit {
        let r = post_multipart(
            fm.app(),
            &fm.app().anon(),
            &fm.upload_path(),
            &[("file", Some("a.txt"), b"x")],
            &[],
        )
        .await;
        assert_eq!(r.status, 200, "upload {i}");
    }
    let r = post_multipart(
        fm.app(),
        &fm.app().anon(),
        &fm.upload_path(),
        &[("file", Some("a.txt"), b"x")],
        &[],
    )
    .await;
    r.assert_status(429);

    // Password-protected forms refuse uploads without the password.
    let fm = form().await;
    fm.p.f
        .app
        .patch(
            &fm.p.f.owner,
            &format!("/api/shares/{}", fm.share_id),
            json!({ "password": "up-pass" }),
        )
        .await
        .assert_status(200);
    let r = post_multipart(
        fm.app(),
        &fm.app().anon(),
        &fm.upload_path(),
        &[("file", Some("a.txt"), b"x")],
        &[],
    )
    .await;
    r.assert_status(401);
    post_multipart(
        fm.app(),
        &fm.app().anon(),
        &fm.upload_path(),
        &[("file", Some("a.txt"), b"x")],
        &[("x-share-password", "up-pass")],
    )
    .await
    .assert_status(200);
}

// ----------------------------------------------- upload byte budgets (B2)

/// Upload a tiny file from client address `ip` while claiming the request is
/// `claimed_mb` MB long (what a browser's Content-Length would say).
async fn upload_claiming(fm: &Form, ip: &str, claimed_mb: u64) -> common::Response {
    use axum::body::Body;
    use axum::http::{Request, header};
    let body = multipart_body(&[("file", Some("x.txt"), b"x")]);
    let mut req = Request::builder()
        .method("POST")
        .uri(fm.upload_path())
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .header(
            header::CONTENT_LENGTH,
            (claimed_mb * 1024 * 1024).to_string(),
        )
        .body(Body::from(body))
        .unwrap();
    let peer: std::net::SocketAddr = format!("{ip}:4000").parse().unwrap();
    req.extensions_mut()
        .insert(axum::extract::ConnectInfo(peer));
    fm.app().send(req).await
}

#[tokio::test]
async fn anonymous_uploads_have_a_byte_budget_per_ip() {
    let fm = form_with(|c| c.max_upload_mb = 25).await;
    // 10 x 20 MB is the whole 200 MB hourly budget of one address.
    for _ in 0..10 {
        upload_claiming(&fm, "10.1.1.1", 20)
            .await
            .assert_status(200);
    }
    upload_claiming(&fm, "10.1.1.1", 20)
        .await
        .assert_status(429);
    // Even a small file: the budget, not the count, is spent.
    upload_claiming(&fm, "10.1.1.1", 1).await.assert_status(429);
    // Another address is unaffected.
    upload_claiming(&fm, "10.1.1.2", 20)
        .await
        .assert_status(200);
}

#[tokio::test]
async fn anonymous_uploads_have_a_byte_budget_per_base() {
    let fm = form_with(|c| c.max_upload_mb = 25).await;
    // Three addresses use 10 x 20 MB, 10 x 20 MB, 5 x 20 MB = the base's 500 MB.
    for (ip, n) in [("10.2.0.1", 10), ("10.2.0.2", 10), ("10.2.0.3", 5)] {
        for _ in 0..n {
            upload_claiming(&fm, ip, 20).await.assert_status(200);
        }
    }
    upload_claiming(&fm, "10.2.0.3", 20)
        .await
        .assert_status(429);
    upload_claiming(&fm, "10.2.0.4", 20)
        .await
        .assert_status(429);
    // Files the owner uploads are not anonymous and not counted.
    fm.p.f.upload("mine.txt", b"mine").await;
}
