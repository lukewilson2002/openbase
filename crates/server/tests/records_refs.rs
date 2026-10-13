//! Record writes that refer to other data: user fields (collaborators,
//! assignment notifications), attachments, and the automations hook.

mod common;
mod records_support;
mod schema_support;

use opengrid::engine::write::{self, CreateOpts, WriteCtx, WriteSource};
use opengrid::perm::Role;
use records_support::*;
use serde_json::{Value, json};

fn notifications_of(f: &Fixture, user: &common::Client) -> Vec<(String, Value)> {
    let uid = user.user_id.clone().unwrap();
    sql(&f.app, move |tx| {
        let mut stmt = tx.prepare(
            "SELECT kind, payload FROM notifications WHERE user_id = ?1 ORDER BY created_at, id",
        )?;
        let rows = stmt
            .query_map([&uid], |r| {
                let p: String = r.get(1)?;
                Ok((r.get(0)?, serde_json::from_str(&p).unwrap()))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

struct People {
    f: Fixture,
    single: Value,
    multi: Value,
    quiet: Value,
    alice: common::Client,
    bob: common::Client,
}

async fn people() -> People {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let single = f
        .add_field(&t, json!({ "name": "Owner", "type": "user", "options": { "multiple": false, "notify": true } }))
        .await;
    let multi = f
        .add_field(&t, json!({ "name": "Team", "type": "user", "options": { "multiple": true, "notify": true } }))
        .await;
    let quiet = f
        .add_field(&t, json!({ "name": "Quiet", "type": "user", "options": { "multiple": true, "notify": false } }))
        .await;
    let alice = f.member("alice@example.com", Role::Editor);
    let bob = f.base_guest("bob@example.com", Role::Viewer);
    People {
        f,
        single,
        multi,
        quiet,
        alice,
        bob,
    }
}

#[tokio::test]
async fn user_fields_accept_collaborators_only() {
    let p = people().await;
    let (f, t) = (&p.f, p.f.table_id.clone());
    let (alice, bob) = (
        p.alice.user_id.clone().unwrap(),
        p.bob.user_id.clone().unwrap(),
    );
    let stranger = f.app.user("stranger@example.com", "Stranger");
    let sid_ = sid(&p.single["id"]);

    // workspace members, base guests and the owner are collaborators
    let rec = f.create(&t, json!({ sid_: alice })).await;
    assert_eq!(
        rec["values"][sid_],
        json!([alice]),
        "user cells are arrays of ids"
    );
    let r = f
        .create(
            &t,
            json!({ sid(&p.multi["id"]): [alice, bob, f.owner.user_id.clone().unwrap()] }),
        )
        .await;
    assert_eq!(
        r["values"][sid(&p.multi["id"])].as_array().unwrap().len(),
        3
    );

    // outsiders and made-up ids are not
    let r = f
        .create_as(
            &f.owner,
            &t,
            json!({ sid_: stranger.user_id.clone().unwrap() }),
        )
        .await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Owner")
    );
    f.create_as(&f.owner, &t, json!({ sid_: "usrNOPE" }))
        .await
        .assert_status(400);
    // a single-user field holds one user
    f.create_as(&f.owner, &t, json!({ sid_: [alice, bob] }))
        .await
        .assert_status(400);
    // deactivated users are not collaborators either
    let carol = f.member("carol@example.com", Role::Editor);
    let cid = carol.user_id.clone().unwrap();
    sql(&f.app, {
        let cid = cid.clone();
        move |tx| tx.execute("UPDATE users SET is_active = 0 WHERE id = ?1", [&cid])
    });
    f.create_as(&f.owner, &t, json!({ sid_: cid }))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn users_already_in_a_cell_stay_acceptable_after_they_lose_access() {
    let p = people().await;
    let (f, t) = (&p.f, p.f.table_id.clone());
    let team = sid(&p.multi["id"]);
    let alice = p.alice.user_id.clone().unwrap();
    let rec = f.create(&t, json!({ team: [alice] })).await;
    let rid = sid(&rec["id"]).to_string();
    sql(&f.app, {
        let alice = alice.clone();
        let ws = f.ws.clone();
        move |tx| {
            tx.execute(
                "DELETE FROM workspace_members WHERE user_id = ?1 AND workspace_id = ?2",
                [&alice, &ws],
            )
        }
    });
    // resending the same cell, or editing other fields, still works
    f.set(&t, &rid, json!({ team: [alice], &f.primary_id: "x" }))
        .await;
    // but adding her anew somewhere else does not
    f.patch_as(&f.owner, &t, &rid, json!({ sid(&p.quiet["id"]): [alice] }))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn newly_assigned_users_are_notified_when_the_field_asks_for_it() {
    let p = people().await;
    let (f, t) = (&p.f, p.f.table_id.clone());
    let (alice, bob) = (
        p.alice.user_id.clone().unwrap(),
        p.bob.user_id.clone().unwrap(),
    );
    let rec = f
        .create(
            &t,
            json!({ &f.primary_id: "Launch", sid(&p.single["id"]): [alice] }),
        )
        .await;
    let rid = sid(&rec["id"]).to_string();

    let n = notifications_of(f, &p.alice);
    assert_eq!(n.len(), 1);
    assert_eq!(n[0].0, "assigned");
    let payload = &n[0].1;
    assert_eq!(payload["base_id"], f.base_id);
    assert_eq!(payload["base_name"], "CRM");
    assert_eq!(payload["table_id"], t);
    assert_eq!(payload["table_name"], "Table 1");
    assert_eq!(payload["record_id"], rid);
    assert_eq!(payload["record_name"], "Launch");
    assert_eq!(payload["field_id"], p.single["id"]);
    assert_eq!(payload["field_name"], "Owner");
    assert_eq!(payload["assigned_by"], f.owner.user_id.clone().unwrap());
    assert!(notifications_of(f, &p.bob).is_empty());

    // adding Bob to a multi-user field notifies only him; Alice re-saved: nothing
    let team = sid(&p.multi["id"]);
    f.set(&t, &rid, json!({ team: [alice] })).await;
    assert_eq!(notifications_of(f, &p.alice).len(), 2);
    f.set(&t, &rid, json!({ team: [alice, bob] })).await;
    assert_eq!(
        notifications_of(f, &p.alice).len(),
        2,
        "already in the cell"
    );
    assert_eq!(notifications_of(f, &p.bob).len(), 1);
    // removing and re-adding notifies again
    f.set(&t, &rid, json!({ team: [alice] })).await;
    f.set(&t, &rid, json!({ team: [alice, bob] })).await;
    assert_eq!(notifications_of(f, &p.bob).len(), 2);

    // fields with notify off stay quiet; assigning yourself is not worth a notification
    f.set(&t, &rid, json!({ sid(&p.quiet["id"]): [bob] })).await;
    assert_eq!(notifications_of(f, &p.bob).len(), 2);
    let owner = f.owner.user_id.clone().unwrap();
    f.set(&t, &rid, json!({ team: [alice, bob, owner] })).await;
    assert!(notifications_of(f, &f.owner).is_empty());
    // a failed write creates none
    let before = notifications_of(f, &p.alice).len();
    f.create_as(
        &f.owner,
        &t,
        json!({ sid(&p.single["id"]): [alice], "fldNOPE": 1 }),
    )
    .await
    .assert_status(400);
    assert_eq!(notifications_of(f, &p.alice).len(), before);
}

// ------------------------------------------------------------ attachments

fn add_attachment(f: &Fixture, base_id: &str, id: &str, filename: &str, size: i64) {
    let (id, base, filename) = (id.to_string(), base_id.to_string(), filename.to_string());
    sql(&f.app, move |tx| {
        tx.execute(
            "INSERT INTO attachments (id, sha256, filename, mime, size, width, height, base_id, created_at)
             VALUES (?1, 'abc', ?2, 'application/pdf', ?3, 10, 20, ?4, 1)",
            rusqlite::params![id, filename, size, base],
        )
    });
}

#[tokio::test]
async fn attachments_must_be_uploads_of_this_base_and_are_stored_from_the_database_row() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let files = f
        .add_field(
            &t,
            json!({ "name": "Files", "type": "attachment", "options": {} }),
        )
        .await;
    let fid = sid(&files["id"]).to_string();
    add_attachment(&f, &f.base_id, "attGood1", "contract.pdf", 1234);
    add_attachment(&f, &f.base_id, "attGood2", "other.pdf", 99);
    // an upload that belongs to another base
    let other_ws = workspace(&f.app, &f.owner, "Other").await;
    let other_base = base(&f.app, &f.owner, &other_ws, "Other base").await;
    add_attachment(
        &f,
        other_base["id"].as_str().unwrap(),
        "attForeign",
        "secret.pdf",
        5,
    );

    // the client's copy of filename/size/mime is ignored
    let forged = json!({ "id": "attGood1", "filename": "evil.exe", "mime": "application/x-msdownload", "size": 1 });
    let rec = f.create(&t, json!({ &fid: [forged.clone()] })).await;
    let stored = &rec["values"][&fid][0];
    assert_eq!(stored["id"], "attGood1");
    assert_eq!(stored["filename"], "contract.pdf");
    assert_eq!(stored["mime"], "application/pdf");
    assert_eq!(stored["size"], 1234);
    assert_eq!(stored["width"], 10);
    assert_eq!(
        f.stored(sid(&rec["id"]), &fid)[0]["filename"],
        "contract.pdf"
    );

    // several files, duplicates dropped, order kept
    let two = json!([
        { "id": "attGood2", "filename": "x", "mime": "x/x", "size": 1 },
        forged.clone(),
        forged.clone(),
    ]);
    let rec2 = f.set(&t, sid(&rec["id"]), json!({ &fid: two })).await;
    let ids: Vec<&str> = rec2["values"][&fid]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["attGood2", "attGood1"]);

    // unknown, foreign-base and malformed attachments are rejected
    for bad in [
        json!([{ "id": "attNOPE", "filename": "a", "mime": "a/b", "size": 1 }]),
        json!([{ "id": "attForeign", "filename": "a", "mime": "a/b", "size": 1 }]),
        json!("a string"),
        json!([{ "id": "attGood1" }]),
    ] {
        let r = f
            .patch_as(&f.owner, &t, sid(&rec["id"]), json!({ &fid: bad }))
            .await;
        r.assert_status(400);
    }
    // clearing works
    let cleared = f.set(&t, sid(&rec["id"]), json!({ &fid: [] })).await;
    assert!(cleared["values"].get(&fid).is_none());
}

// ------------------------------------------------------- automations hook

#[tokio::test]
async fn the_automations_hook_receives_created_and_edited_records() {
    let l = linked().await;
    let f = &l.f;
    let t2p = sid(&f.table(&l.t2).await["primary_field_id"]).to_string();
    write::start_recording(&f.base_id);
    let lid = sid(&l.link["id"]).to_string();
    let iid = sid(&l.inverse["id"]).to_string();
    let user = f.owner.user_id.clone().unwrap();

    let o = f.create(&l.t2, json!({ &t2p: "O" })).await;
    let oid = sid(&o["id"]).to_string();
    let rec = write::take_recorded(&f.base_id);
    assert_eq!(rec.len(), 1);
    assert_eq!(rec[0].table_id, l.t2);
    assert_eq!(rec[0].created, std::slice::from_ref(&oid));
    assert!(rec[0].updated.is_empty());
    assert_eq!(rec[0].user_id.as_deref(), Some(user.as_str()));
    assert_eq!(rec[0].form_view_id, None);

    // an edit lists the editable fields that changed; a no-op edit calls nothing
    f.set(&l.t2, &oid, json!({ &t2p: "O2", sid(&l.price["id"]): 5 }))
        .await;
    let rec = write::take_recorded(&f.base_id);
    assert_eq!(rec.len(), 1);
    assert!(rec[0].created.is_empty());
    assert_eq!(rec[0].updated.len(), 1);
    assert_eq!(rec[0].updated[0].0, oid);
    let mut fields = rec[0].updated[0].1.clone();
    fields.sort();
    let mut expected = vec![t2p.clone(), sid(&l.price["id"]).to_string()];
    expected.sort();
    assert_eq!(fields, expected);
    f.set(&l.t2, &oid, json!({ &t2p: "O2" })).await;
    assert!(write::take_recorded(&f.base_id).is_empty());

    // linking edits the other side too: one call per table
    let c = f.create(&l.t1, json!({ &lid: [oid] })).await;
    let mut calls = write::take_recorded(&f.base_id);
    calls.sort_by(|a, b| a.table_id.cmp(&b.table_id));
    assert_eq!(calls.len(), 2);
    let on_customers = calls.iter().find(|c| c.table_id == l.t1).unwrap();
    assert_eq!(on_customers.created, [sid(&c["id"]).to_string()]);
    let on_orders = calls.iter().find(|c| c.table_id == l.t2).unwrap();
    assert!(on_orders.created.is_empty());
    assert_eq!(on_orders.updated, [(oid.clone(), vec![iid.clone()])]);

    // computed-only changes and deletes do not call the hook
    let total = f
        .rollup(&l.t1, "Total", &l.link, &l.price, "SUM(values)")
        .await;
    let _ = total;
    write::take_recorded(&f.base_id);
    f.delete_records(&l.t2, &[&oid]).await.assert_status(200);
    assert!(write::take_recorded(&f.base_id).is_empty());
    f.restore_records(&l.t2, &[&oid]).await.assert_status(200);
    assert!(write::take_recorded(&f.base_id).is_empty());
    // a failed write calls nothing (and a rolled back one leaves no recording)
    f.create_as(&f.owner, &l.t1, json!({ "fldNOPE": 1 }))
        .await
        .assert_status(400);
    assert!(write::take_recorded(&f.base_id).is_empty());
    write::stop_recording(&f.base_id);
    f.create(&l.t2, json!({})).await;
    assert!(
        write::take_recorded(&f.base_id).is_empty(),
        "recording is opt-in"
    );
}

#[tokio::test]
async fn cascaded_recomputes_are_reported_as_updated_but_not_as_edits() {
    let l = linked().await;
    let f = &l.f;
    let total = f
        .rollup(&l.t1, "Total", &l.link, &l.price, "SUM(values)")
        .await;
    let o = f.create(&l.t2, json!({ sid(&l.price["id"]): 1 })).await;
    let c = f
        .create(&l.t1, json!({ sid(&l.link["id"]): [o["id"]] }))
        .await;
    let _ = total;
    let owner = f.owner.user_id.clone().unwrap();
    let (t2, oid, pid) = (
        l.t2.clone(),
        sid(&o["id"]).to_string(),
        sid(&l.price["id"]).to_string(),
    );
    let outcome = f
        .app
        .state
        .db
        .write_sync(move |tx| {
            let ctx = WriteCtx::new(Some(&owner), WriteSource::Api);
            write::update_records(
                tx,
                &ctx,
                &t2,
                vec![og_core::api::records::RecordPatch {
                    id: oid,
                    values: [(pid, json!(2))].into_iter().collect(),
                }],
            )
        })
        .unwrap();
    let customers = outcome
        .table(&l.t1)
        .expect("the customers table is in the outcome");
    assert_eq!(customers.updated.to_vec(), [sid(&c["id"]).to_string()]);
    assert!(
        customers.edited.is_empty(),
        "no editable field of the customer changed"
    );
    assert_eq!(outcome.target().edited.len(), 1);
    assert_eq!(outcome.all_updated().len(), 2);
}

#[tokio::test]
async fn anonymous_form_style_writes_have_no_actor() {
    let f = Fixture::new().await;
    write::start_recording(&f.base_id);
    let (t, pid) = (f.table_id.clone(), f.primary_id.clone());
    let outcome = f
        .app
        .state
        .db
        .write_sync(move |tx| {
            let ctx = WriteCtx::new(
                None,
                WriteSource::Form {
                    view_id: "viwForm".into(),
                },
            );
            write::create_records(
                tx,
                &ctx,
                &t,
                vec![og_core::api::records::NewRecord {
                    values: [(pid, json!("from a form"))].into_iter().collect(),
                }],
                &CreateOpts::default(),
            )
        })
        .unwrap();
    let rid = outcome.target().created[0].clone();
    let (_, _, _, updated_by, _) = f.columns(&rid);
    assert_eq!(updated_by, None);
    let h = f.history(&rid);
    assert_eq!(h[0].2, None, "history records no user");
    let calls = write::take_recorded(&f.base_id);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].form_view_id.as_deref(), Some("viwForm"));
    assert_eq!(calls[0].user_id, None);
    write::stop_recording(&f.base_id);
    // events from the outcome: one RecordsChanged
    let events = outcome.events();
    assert_eq!(events.len(), 1);
}

#[tokio::test]
async fn engine_functions_can_be_called_directly_and_roll_back_with_their_transaction() {
    let f = Fixture::new().await;
    let (t, pid) = (f.table_id.clone(), f.primary_id.clone());
    let owner = f.owner.user_id.clone().unwrap();
    let res: Result<(), opengrid::error::AppError> = f.app.state.db.write_sync(move |tx| {
        let ctx = WriteCtx::new(Some(&owner), WriteSource::Import).typecast(true);
        write::create_records(
            tx,
            &ctx,
            &t,
            vec![og_core::api::records::NewRecord {
                values: [(pid, json!("never lands"))].into_iter().collect(),
            }],
            &CreateOpts::default(),
        )?;
        Err(opengrid::error::AppError::bad_request(
            "caller changed its mind",
        ))
    });
    assert!(res.is_err());
    assert_eq!(f.order(&f.table_id).len(), 0);
    assert_eq!(
        f.app.query_i64("SELECT count(*) FROM record_history", &[]),
        0,
        "history rolls back too"
    );
}
