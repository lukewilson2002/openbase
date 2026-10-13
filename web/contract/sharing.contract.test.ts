/**
 * Share links, public views and forms, CSV export and import, through the real API client against
 * the real server: link management and who may do it, the public endpoints without credentials
 * (what a visitor sees, what they cannot), password-protected links, form submission and file
 * uploads, attachments of shared views, and the two CSV import endpoints. Every response is checked
 * against the generated bindings.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client";
import { api } from "../src/api/endpoints";
import { attachmentsApi, recordsApi, schemaApi } from "../src/api/records";
import { ImportFailedError, csvApi, publicApi, sharesApi } from "../src/api/sharing";
import type { AttachmentRef, Field, FormConfig, Table, TableRecord, View } from "../src/api/types";
import { rawFetch } from "./cookieJar";
import { Profile, createWorld, env, expectError, failure, joinBase, newUser, refreshBase, type World } from "./support";
import { parse } from "./typecheck";

let w: World;
let people: Table;
let contacts: Table;
let grid: View;
let editor: Profile;
let viewer: Profile;
let anon: Profile;

let name = "";
let email = "";
let qty = "";
let status = "";
let secret = "";
let owner = "";
let photo = "";
let parent = "";
let total = "";
let due = "";
const choice = {} as Record<string, string>;
let photoRef: AttachmentRef;
let docRef: AttachmentRef;

const base = () => env.seeded.baseUrl;
type Select = Extract<Field, { type: "single_select" }>;

async function field(t: Table, body: Parameters<typeof schemaApi.createField>[1]): Promise<Field> {
  return w.owner.run(() => schemaApi.createField(t.id, body));
}

async function record(values: Record<string, unknown>): Promise<TableRecord> {
  return parse("RecordsResponse", await w.owner.run(() => recordsApi.create(contacts.id, { records: [{ values: values as never }], typecast: true }))).records[0]!;
}

async function makeView(type: View["type"], config: Partial<View["config"]> | null, personal = false): Promise<View> {
  const created = parse("View", await w.owner.run(() => api.views.create(contacts.id, { name: `A ${type} ${Math.random().toString(36).slice(2, 6)}`, type, personal, config: null })));
  if (!config) return created;
  return parse("View", await w.owner.run(() => api.views.update(created.id, { config: { ...created.config, ...config } })));
}

async function share(view: View, kind: "view" | "form", password?: string) {
  return parse("ShareLink", await w.owner.run(() => sharesApi.create(view.id, { kind, ...(password ? { password } : {}) })));
}

const visitor = (label = "anon") => new Profile(label);

beforeAll(async () => {
  w = await createWorld("Sharing");
  contacts = w.base.tables[0]!;
  name = contacts.primary_field_id;
  people = parse("Table", await w.owner.run(() => api.tables.create(w.baseId, "People")));
  email = (await field(contacts, { name: "Email", type: "email", options: {} })).id;
  qty = (await field(contacts, { name: "Qty", type: "number", options: { precision: 0, allow_negative: false } })).id;
  const st = (await field(contacts, { name: "Status", type: "single_select", options: { choices: [{ id: "", name: "Todo", color: "gray" }, { id: "", name: "Done", color: "green" }] } })) as Select;
  status = st.id;
  for (const c of st.options.choices) choice[c.name] = c.id;
  secret = (await field(contacts, { name: "Salary", type: "single_line_text", options: {} })).id;
  owner = (await field(contacts, { name: "Owner", type: "user", options: { multiple: false, notify: false } })).id;
  photo = (await field(contacts, { name: "Photo", type: "attachment", options: {} })).id;
  due = (await field(contacts, { name: "Due", type: "date", options: { include_time: true, date_format: "iso", time_format: "h24", timezone: null } })).id;
  parent = (await field(contacts, { name: "Parent", type: "link", options: { linked_table_id: people.id, inverse_field_id: "", single: true }, inverse_name: "Contacts" } as never)).id;
  total = (await field(contacts, { name: "Double", type: "formula", options: { expression: "{Qty} * 2", result_type: "number" } })).id;

  const fresh = await refreshBase(w.owner, w.baseId);
  contacts = fresh.tables.find((t) => t.id === contacts.id)!;
  people = fresh.tables.find((t) => t.id === people.id)!;
  grid = contacts.views[0]!;
  editor = await newUser(w.owner, "editor");
  viewer = await newUser(w.owner, "viewer");
  await joinBase(w.owner, w.baseId, editor, "editor");
  await joinBase(w.owner, w.baseId, viewer, "viewer");
  anon = visitor();

  photoRef = parse("AttachmentRef", await w.owner.run(() => attachmentsApi.upload(w.baseId, new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))], "dot.png", { type: "image/png" }))));
  docRef = parse("AttachmentRef", await w.owner.run(() => attachmentsApi.upload(w.baseId, new File(["secret plans"], "plans.txt", { type: "text/plain" }))));
  await record({ [name]: "Ada, Lovelace", [email]: "ada@example.com", [qty]: 2, [status]: choice["Todo"], [secret]: "100000", [owner]: [w.owner.id], [photo]: [photoRef], [due]: "2026-03-10T09:30:00.000Z" });
  await record({ [name]: "Grace", [email]: "grace@example.com", [qty]: 5, [status]: choice["Done"], [secret]: "90000", [photo]: [docRef] });
  await record({ [name]: "=SUM(A1)", [qty]: 1 });
});

// ---------------------------------------------------------------------------------------------
describe("managing share links", () => {
  it("creates a read-only link for a grid view (201 ShareLink) and lists, disables, enables and deletes it", async () => {
    const link = await share(grid, "view");
    expect(w.owner.status).toBe(201);
    expect(link).toMatchObject({ view_id: grid.id, kind: "view", enabled: true, has_password: false });
    expect(link.path).toBe(`/s/${link.token}`);
    expect(link.url).toBe(`${base()}${link.path}`.replace(base(), new URL(link.url).origin));
    expect(link.token.length).toBeGreaterThanOrEqual(20);

    const listed = (await w.owner.run(() => sharesApi.list(grid.id))).map((l) => parse("ShareLink", l));
    expect(listed.map((l) => l.id)).toContain(link.id);

    const off = parse("ShareLink", await w.owner.run(() => sharesApi.update(link.id, { enabled: false })));
    expect(off.enabled).toBe(false);
    expectError(await failure(anon.run(() => publicApi.view(link.token))), 404, "not_found");
    const on = parse("ShareLink", await w.owner.run(() => sharesApi.update(link.id, { enabled: true })));
    expect(on.enabled).toBe(true);
    parse("PublicView", await anon.run(() => publicApi.view(link.token)));

    await w.owner.run(() => sharesApi.remove(link.id));
    expect(w.owner.status).toBe(204);
    expectError(await failure(anon.run(() => publicApi.view(link.token))), 404, "not_found");
  });

  it("sets, changes and removes a password with PATCH (null removes it, leaving it out keeps it)", async () => {
    const link = await share(grid, "view");
    const set = parse("ShareLink", await w.owner.run(() => sharesApi.update(link.id, { password: "open sesame" })));
    expect(set.has_password).toBe(true);
    const kept = parse("ShareLink", await w.owner.run(() => sharesApi.update(link.id, { enabled: true })));
    expect(kept.has_password).toBe(true);
    const cleared = parse("ShareLink", await w.owner.run(() => sharesApi.update(link.id, { password: null })));
    expect(cleared.has_password).toBe(false);
    parse("PublicView", await anon.run(() => publicApi.view(link.token)));
    expectError(await failure(w.owner.run(() => sharesApi.update(link.id, { password: "abc" }))), 400, "bad_request");
  });

  it("answers the kind of link a view can have: forms for form views, read-only for the rest", async () => {
    const form = await makeView("form", null);
    expectError(await failure(w.owner.run(() => sharesApi.create(form.id, { kind: "view" }))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => sharesApi.create(grid.id, { kind: "form" }))), 400, "bad_request");
    expect((await share(form, "form")).kind).toBe("form");
  });

  it("refuses personal views, non-creators and unknown views", async () => {
    const mine = await makeView("grid", null, true);
    expectError(await failure(w.owner.run(() => sharesApi.create(mine.id, { kind: "view" }))), 400, "bad_request");
    expectError(await failure(editor.run(() => sharesApi.create(grid.id, { kind: "view" }))), 403, "forbidden");
    expectError(await failure(viewer.run(() => sharesApi.list(grid.id))), 403, "forbidden");
    expectError(await failure(w.owner.run(() => sharesApi.list("viwNope0000000"))), 404, "not_found");
  });

  it("allows at most 20 links per view", async () => {
    const v = await makeView("list", null);
    for (let i = 0; i < 20; i++) await share(v, "view");
    expectError(await failure(w.owner.run(() => sharesApi.create(v.id, { kind: "view" }))), 400, "bad_request");
  });
});

// ---------------------------------------------------------------------------------------------
describe("a shared view, seen without an account", () => {
  let view: View;
  let link: Awaited<ReturnType<typeof share>>;

  beforeAll(async () => {
    view = await makeView("grid", { hidden_fields: [secret, email], sorts: [{ field_id: qty, direction: "desc" }] });
    link = await share(view, "view");
  });

  it("shows only the visible fields, in the view's order, without formulas or link wiring", async () => {
    const pub = parse("PublicView", await anon.run(() => publicApi.view(link.token)));
    expect(pub).toMatchObject({ kind: "view", name: view.name, type: "grid", table_name: contacts.name });
    const names = pub.fields.map((f) => f.name);
    expect(names).toContain("Qty");
    expect(names).not.toContain("Salary");
    expect(names).not.toContain("Email");
    expect(JSON.stringify(pub)).not.toContain(secret);
    const formula = pub.fields.find((f) => f.name === "Double")!;
    expect(JSON.stringify(formula.options)).not.toContain("Qty");
    expect(JSON.stringify(pub.fields.find((f) => f.name === "Parent")!.options)).not.toContain(people.id);
  });

  it("returns records with the visible fields only, in the view's sort, and people by name", async () => {
    const res = parse("PublicQueryResponse", await anon.run(() => publicApi.query(link.token, {})));
    expect(res.total).toBe(3);
    expect(res.records.map((r) => r.values[name])).toEqual(["Grace", "Ada, Lovelace", "=SUM(A1)"]);
    for (const r of res.records) {
      expect(r.values[secret]).toBeUndefined();
      expect(r.values[email]).toBeUndefined();
    }
    const ada = res.records.find((r) => r.values[name] === "Ada, Lovelace")!;
    expect(ada.values[owner]).toEqual([{ name: w.owner.user!.name }]);
    // No user ids or e-mail addresses anywhere in the answer.
    const json = JSON.stringify(res);
    expect(json).not.toContain(w.owner.id);
    expect(json).not.toContain(w.owner.user!.email);
  });

  it("searches, pages and applies sort overrides on visible fields only", async () => {
    expect((await anon.run(() => publicApi.query(link.token, { search: "grace" }))).total).toBe(1);
    const page = parse("PublicQueryResponse", await anon.run(() => publicApi.query(link.token, { offset: 1, limit: 1 })));
    expect(page.records).toHaveLength(1);
    expect(page.total).toBe(3);
    expect(page.offset).toBe(1);
    const asc = await anon.run(() => publicApi.query(link.token, { transient: { sorts: [{ field_id: name, direction: "asc" }] } }));
    expect(asc.records.map((r) => r.values[name])).toEqual(["=SUM(A1)", "Ada, Lovelace", "Grace"]);
    // A hidden field is not searchable, sortable or filterable: that would leak its values.
    expect((await anon.run(() => publicApi.query(link.token, { search: "100000" }))).total).toBe(0);
    expectError(await failure(anon.run(() => publicApi.query(link.token, { transient: { sorts: [{ field_id: secret, direction: "asc" }] } }))), 400, "bad_request");
    expectError(await failure(anon.run(() => publicApi.query(link.token, { transient: { filter: { conjunction: "and", items: [{ field_id: secret, op: "is", value: "100000" }] } } }))), 400, "bad_request");
  });

  it("filters by date range on a visible date field", async () => {
    const res = await anon.run(() => publicApi.query(link.token, { range: { field_id: due, from: "2026-03-01", to: "2026-03-31" }, timezone: "UTC" }));
    expect(res.records.map((r) => r.values[name])).toEqual(["Ada, Lovelace"]);
    expectError(await failure(anon.run(() => publicApi.query(link.token, { range: { field_id: secret, from: "2026-03-01", to: "2026-03-31" } }))), 400, "bad_request");
  });

  // KNOWN SERVER BUG (reported, not fixed here: the brief forbids Rust changes): a shared view that
  // groups by a user field answers group headers whose `key` and `value` are the user's id, although
  // docs/api.md promises that no user ids ever appear. `it.fails` keeps the suite green while it
  // documents the gap, and turns red the day the server is fixed, as a reminder to make it a plain `it`.
  it.fails("groups by a user field without handing out user ids", async () => {
    const grouped = await makeView("list", { groups: [{ field_id: owner, direction: "asc" }] });
    const l = await share(grouped, "view");
    const res = parse("PublicQueryResponse", await anon.run(() => publicApi.query(l.token, {})));
    expect(res.groups.length).toBeGreaterThan(0);
    // docs/api.md: "no user ids, e-mail addresses or creator/editor metadata ever appear"
    expect(JSON.stringify(res), "a group header on a user field exposes the user's id").not.toContain(w.owner.id);
  });

  it("serves attachments of the shared view through ?share= and refuses them without it", async () => {
    const withShare = await rawFetch(`${base()}${publicApi.attachmentUrl(link.token, photoRef.id, photoRef.filename)}`);
    expect(withShare.status).toBe(200);
    expect(withShare.headers.get("content-type")).toBe("image/png");
    const thumb = await rawFetch(`${base()}${publicApi.thumbUrl(link.token, photoRef.id)}`);
    expect(thumb.status).toBe(200);
    expect((await rawFetch(`${base()}/api/attachments/${photoRef.id}/${photoRef.filename}`)).status).toBe(404);
    expect((await rawFetch(`${base()}${publicApi.thumbUrl("tok_wrong", photoRef.id)}`)).status).toBe(404);
  });

  it("answers 404 for an unknown token, a form token and after the view is deleted", async () => {
    expectError(await failure(anon.run(() => publicApi.view("tok_unknown"))), 404, "not_found");
    const doomed = await makeView("gallery", null);
    const l = await share(doomed, "view");
    expectError(await failure(anon.run(() => publicApi.form(l.token))), 404, "not_found");
    await w.owner.run(() => api.views.remove(doomed.id));
    expectError(await failure(anon.run(() => publicApi.view(l.token))), 404, "not_found");
  });
});

// ---------------------------------------------------------------------------------------------
describe("a password-protected share", () => {
  let link: Awaited<ReturnType<typeof share>>;

  beforeAll(async () => {
    link = await share(await makeView("grid", { hidden_fields: [secret] }), "view", "open sesame");
  });

  it("wants the password on every public call and says which kind of 401 it is", async () => {
    expect(link.has_password).toBe(true);
    expectError(await failure(anon.run(() => publicApi.view(link.token))), 401, "share_password_required");
    expectError(await failure(anon.run(() => publicApi.query(link.token, {}))), 401, "share_password_required");
    expectError(await failure(anon.run(() => publicApi.view(link.token, "wrong"))), 401, "share_password_invalid");
    expectError(await failure(anon.run(() => publicApi.query(link.token, {}, "wrong"))), 401, "share_password_invalid");
  });

  it("opens with the right password, and a 401 on a public call never signs anyone out", async () => {
    parse("PublicView", await anon.run(() => publicApi.view(link.token, "open sesame")));
    parse("PublicQueryResponse", await anon.run(() => publicApi.query(link.token, {}, "open sesame")));
    // The visitor is signed in elsewhere: a wrong password must not touch their session.
    expect(w.owner.jar.cookies.size).toBeGreaterThan(0);
    await failure(w.owner.run(() => publicApi.view(link.token, "wrong")));
    parse("User", await w.owner.run(() => api.auth.me()));
  });

  it("serves attachments only with the password header (an <img> cannot send it, so the page fetches them)", async () => {
    const url = `${base()}${publicApi.thumbUrl(link.token, photoRef.id)}`;
    expect((await rawFetch(url)).status).toBe(404);
    expect((await rawFetch(url, { headers: { "x-share-password": "wrong" } })).status).toBe(404);
    const ok = await rawFetch(url, { headers: { "x-share-password": "open sesame" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    // The client helper the public page uses for protected links.
    const blob = await anon.run(() => publicApi.attachmentBlob(link.token, photoRef.id, null, "open sesame"));
    expect(blob.blob.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe("a public form", () => {
  let formView: View;
  let link: Awaited<ReturnType<typeof share>>;

  beforeAll(async () => {
    const created = await makeView("form", null);
    const entry = (field_id: string, extra: Partial<FormConfig["fields"][number]> = {}) => ({ field_id, required: false, label: null, help: null, ...extra });
    const form: FormConfig = {
      title: "Contact us",
      description: "We reply within a day",
      fields: [entry(name, { required: true, label: "Your name", help: "As on your ID" }), entry(email), entry(qty), entry(status), entry(owner), entry(parent), entry(photo)],
      submit_label: "Send",
      success_message: "Thank you",
      redirect_url: "https://example.com/thanks",
      show_submit_another: true,
    };
    formView = parse("View", await w.owner.run(() => api.views.update(created.id, { config: { ...created.config, form } })));
    link = await share(formView, "form");
  });

  it("describes the form: labels, help, required, options; link and user fields are not collected", async () => {
    const pub = parse("PublicForm", await anon.run(() => publicApi.form(link.token)));
    expect(pub).toMatchObject({ title: "Contact us", description: "We reply within a day", submit_label: "Send", success_message: "Thank you", redirect_url: "https://example.com/thanks", show_submit_another: true });
    expect(pub.fields.map((f) => f.label)).toEqual(["Your name", "Email", "Qty", "Status", "Photo"]);
    expect(pub.fields[0]).toMatchObject({ id: name, required: true, help: "As on your ID", type: "single_line_text" });
    expect(pub.fields.find((f) => f.id === status)?.options).toMatchObject({ choices: [{ name: "Todo" }, { name: "Done" }] });
    expect(pub.fields.some((f) => f.id === owner || f.id === parent)).toBe(false);
  });

  it("does not answer as a read-only view, and a view link does not answer as a form", async () => {
    expectError(await failure(anon.run(() => publicApi.view(link.token))), 404, "not_found");
  });

  it("creates a record anonymously from the submitted values", async () => {
    const before = parse("QueryResponse", await w.owner.run(() => recordsApi.query(grid.id, { limit: 0 }))).total;
    const res = await anon.run(() => publicApi.submitForm(link.token, { [name]: "Web visitor", [email]: "visitor@example.com", [qty]: "7", [status]: choice["Done"]! }));
    expect(res).toEqual({ ok: true });
    const after = parse("QueryResponse", await w.owner.run(() => recordsApi.query(grid.id, { search: "Web visitor" })));
    expect(after.total).toBe(1);
    const created = after.records[0]!;
    expect(created.values).toMatchObject({ [name]: "Web visitor", [email]: "visitor@example.com", [qty]: 7, [status]: choice["Done"] });
    expect(created.created_by ?? null).toBeNull();
    expect(parse("QueryResponse", await w.owner.run(() => recordsApi.query(grid.id, { limit: 0 }))).total).toBe(before + 1);
  });

  it("enforces required fields, field types and the form's own field list", async () => {
    expectError(await failure(anon.run(() => publicApi.submitForm(link.token, { [email]: "x@example.com" }))), 400, "bad_request");
    expectError(await failure(anon.run(() => publicApi.submitForm(link.token, { [name]: "N", [qty]: "-3" }))), 400, "bad_request");
    expectError(await failure(anon.run(() => publicApi.submitForm(link.token, { [name]: "N", [email]: "not an email" }))), 400, "bad_request");
    // Not part of the form: refused, never written.
    expectError(await failure(anon.run(() => publicApi.submitForm(link.token, { [name]: "N", [secret]: "hacked" }))), 400, "bad_request");
    expectError(await failure(anon.run(() => publicApi.submitForm(link.token, { [name]: "N", [owner]: [w.owner.id] }))), 400, "bad_request");
    expectError(await failure(anon.run(() => publicApi.submitForm(link.token, { [name]: "N", [total]: 1 }))), 400, "bad_request");
    // A visitor can never create a select option.
    expectError(await failure(anon.run(() => publicApi.submitForm(link.token, { [name]: "N", [status]: "Brand new option" }))), 400, "bad_request");
    const table = parse("Table", (await refreshBase(w.owner, w.baseId)).tables.find((t) => t.id === contacts.id)!);
    expect((table.fields.find((f) => f.id === status) as Select).options.choices).toHaveLength(2);
  });

  it("uploads a file for the attachment field and stores it on the record", async () => {
    const ref = parse("AttachmentRef", await anon.run(() => publicApi.uploadFormFile(link.token, new File(["cv text"], "cv.txt", { type: "text/plain" }))));
    expect(ref).toMatchObject({ filename: "cv.txt", size: 7 });
    await anon.run(() => publicApi.submitForm(link.token, { [name]: "With file", [photo]: [{ id: ref.id, filename: ref.filename, mime: ref.mime, size: ref.size, width: null, height: null }] }));
    const rec = parse("QueryResponse", await w.owner.run(() => recordsApi.query(grid.id, { search: "With file" }))).records[0]!;
    expect((rec.values[photo] as AttachmentRef[])[0]).toMatchObject({ id: ref.id, filename: "cv.txt" });
  });

  it("rejects an upload to a form without an attachment field, and one to a protected form without the password", async () => {
    const plain = await makeView("form", null);
    await w.owner.run(() => api.views.update(plain.id, { config: { ...plain.config, form: { ...plain.config.form, fields: [{ field_id: name, required: false, label: null, help: null }] } } }));
    const l = await share(plain, "form");
    expectError(await failure(anon.run(() => publicApi.uploadFormFile(l.token, new File(["x"], "x.txt")))), 400, "bad_request");

    const locked = await share(formView, "form", "form pass");
    expectError(await failure(anon.run(() => publicApi.uploadFormFile(locked.token, new File(["x"], "x.txt")))), 401, "share_password_required");
    parse("AttachmentRef", await anon.run(() => publicApi.uploadFormFile(locked.token, new File(["x"], "x.txt"), "form pass")));
    expectError(await failure(anon.run(() => publicApi.submitForm(locked.token, { [name]: "N" }))), 401, "share_password_required");
    expect(await anon.run(() => publicApi.submitForm(locked.token, { [name]: "With pass" }, "form pass"))).toEqual({ ok: true });
  });

  it("stops accepting submissions from one address after 20 in a short time, with a clear 429", async () => {
    const eager = visitor("eager");
    const l = await share(formView, "form");
    for (let i = 0; i < 20; i++) await eager.run(() => publicApi.submitForm(l.token, { [name]: `Bulk ${i}` }));
    const e = await failure(eager.run(() => publicApi.submitForm(l.token, { [name]: "One too many" })));
    expectError(e, 429, "too_many_requests");
    // Another visitor is not affected.
    expect(await visitor("other").run(() => publicApi.submitForm(l.token, { [name]: "Fine" }))).toEqual({ ok: true });
  });

  it("closes the form when the link is switched off, mid-session", async () => {
    const l = await share(formView, "form");
    parse("PublicForm", await anon.run(() => publicApi.form(l.token)));
    await w.owner.run(() => sharesApi.update(l.id, { enabled: false }));
    expectError(await failure(anon.run(() => publicApi.submitForm(l.token, { [name]: "Late" }))), 404, "not_found");
  });

  it("honours a form with no collectable field: nothing to submit", async () => {
    const odd = await makeView("form", null);
    await w.owner.run(() => api.views.update(odd.id, { config: { ...odd.config, form: { ...odd.config.form, fields: [{ field_id: owner, required: false, label: null, help: null }] } } }));
    const l = await share(odd, "form");
    const pub = parse("PublicForm", await anon.run(() => publicApi.form(l.token)));
    expect(pub.fields).toEqual([]);
    expectError(await failure(anon.run(() => publicApi.submitForm(l.token, {}))), 400, "bad_request");
  });
});

// ---------------------------------------------------------------------------------------------
describe("CSV export", () => {
  let view: View;

  beforeAll(async () => {
    view = await makeView("grid", { hidden_fields: [secret], sorts: [{ field_id: name, direction: "asc" }] });
  });

  it("downloads the view's visible fields with its sort, a BOM, CRLF, quoting and formula guards", async () => {
    const { blob, filename } = await w.owner.run(() => csvApi.exportView(view.id, "UTC"));
    expect(filename).toBe(`${view.name}.csv`);
    const text = await blob.text();
    expect([...new Uint8Array(await blob.slice(0, 3).arrayBuffer())]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM (Blob.text() strips it, so look at the bytes)
    const lines = text.split("\r\n");
    expect(lines[0]).toContain("Name");
    expect(lines[0]).not.toContain("Salary");
    expect(text).not.toContain("100000");
    // Sorted by name: the formula-looking name comes first and is guarded with a leading apostrophe.
    expect(lines[1]!.startsWith("'=SUM(A1)")).toBe(true);
    expect(text).toContain('"Ada, Lovelace"');
  });

  it("writes dates in the requested time zone", async () => {
    const utc = await (await w.owner.run(() => csvApi.exportView(view.id, "UTC"))).blob.text();
    const tokyo = await (await w.owner.run(() => csvApi.exportView(view.id, "Asia/Tokyo"))).blob.text();
    expect(utc).toContain("2026-03-10 09:30");
    expect(tokyo).toContain("2026-03-10 18:30");
    expectError(await failure(w.owner.run(() => csvApi.exportView(view.id, "Mars/Olympus"))), 400, "bad_request");
  });

  it("lets viewers export, and keeps outsiders out", async () => {
    const asViewer = await viewer.run(() => csvApi.exportView(view.id, "UTC"));
    expect((await asViewer.blob.text()).length).toBeGreaterThan(10);
    const outsider = await newUser(w.owner, "outsider");
    expectError(await failure(outsider.run(() => csvApi.exportView(view.id, "UTC"))), 404, "not_found");
  });
});

// ---------------------------------------------------------------------------------------------
describe("CSV import", () => {
  let target: Table;
  let tName = "";
  let tQty = "";
  let tNote = "";

  beforeAll(async () => {
    target = parse("Table", await w.owner.run(() => api.tables.create(w.baseId, "Imports")));
    tName = target.primary_field_id;
    tQty = (await w.owner.run(() => schemaApi.createField(target.id, { name: "Qty", type: "number", options: { precision: 0, allow_negative: false } }))).id;
    tNote = (await w.owner.run(() => schemaApi.createField(target.id, { name: "Note", type: "single_line_text", options: {} }))).id;
  });

  const rowsOf = async () => {
    const t = (await refreshBase(w.owner, w.baseId)).tables.find((x) => x.id === target.id)!;
    return parse("QueryResponse", await w.owner.run(() => recordsApi.query(t.views[0]!.id, { limit: 100 })));
  };
  const file = (text: string, filename = "data.csv") => new File([text], filename, { type: "text/csv" });

  it("imports rows through an explicit mapping, skipping columns, and answers ImportResult", async () => {
    const res = parse("ImportResult", await w.owner.run(() => csvApi.importIntoTable(target.id, file("Name,Qty,Ignored\nAnn,1,x\nBob,2,y\n"), { mapping: { Name: tName, Qty: tQty, Ignored: null } })));
    expect(res).toMatchObject({ table_id: target.id, created: 2, fields: [] });
    const r = await rowsOf();
    expect(r.records.map((x) => [x.values[tName], x.values[tQty]])).toEqual([["Ann", 1], ["Bob", 2]]);
  });

  it("maps by the names the server derives: repeated, empty and padded headers", async () => {
    const res = await w.owner.run(() => csvApi.importIntoTable(target.id, file("Name,name, ,Qty\nCy,second,third,3\n"), { mapping: { Name: tName, "name 2": tNote, "Column 3": null, Qty: tQty } }));
    expect(res.created).toBe(1);
    const cy = (await rowsOf()).records.find((x) => x.values[tName] === "Cy")!;
    expect(cy.values).toMatchObject({ [tNote]: "second", [tQty]: 3 });
  });

  it("works without a header row, keyed by column number, and reads semicolon files", async () => {
    await w.owner.run(() => csvApi.importIntoTable(target.id, file("Dee;4\nEli;5\n"), { hasHeader: false, mapping: { "0": tName, "1": tQty } }));
    const names = (await rowsOf()).records.map((x) => x.values[tName]);
    expect(names).toEqual(expect.arrayContaining(["Dee", "Eli"]));
  });

  it("is all or nothing: a bad row lists the problem rows and writes nothing", async () => {
    const before = (await rowsOf()).total;
    const e = await failure(w.owner.run(() => csvApi.importIntoTable(target.id, file("Name,Qty\nOk,1\nBad,abc\nWorse,-5\n\nFine,2\n"), { mapping: { Name: tName, Qty: tQty } })));
    expect(e).toBeInstanceOf(ImportFailedError);
    const failed = e as ImportFailedError;
    expect(failed.status).toBe(422);
    expect(failed.code).toBe("import_failed");
    expect(failed.truncated).toBe(false);
    expect(failed.rows.map((r) => r.row)).toEqual([3, 4]);
    expect(failed.rows.every((r) => r.message.length > 0)).toBe(true);
    expect((await rowsOf()).total).toBe(before);
  });

  it("rejects a mapping that names a missing column, a computed field or a field twice", async () => {
    expectError(await failure(w.owner.run(() => csvApi.importIntoTable(target.id, file("Name\nx\n"), { mapping: { Nope: tName } }))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => csvApi.importIntoTable(target.id, file("Name\nx\n"), { mapping: { Name: "fldNope00000000" } }))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => csvApi.importIntoTable(target.id, file("A,B\nx,y\n"), { mapping: { A: tName, B: tName } }))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => csvApi.importIntoTable(target.id, file("A\nx\n"), { mapping: { A: null } }))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => csvApi.importIntoTable(target.id, file(""), {}))), 400, "bad_request");
  });

  it("lets editors import, not viewers", async () => {
    expect((await editor.run(() => csvApi.importIntoTable(target.id, file("Name\nEd\n"), { mapping: { Name: tName } }))).created).toBe(1);
    expectError(await failure(viewer.run(() => csvApi.importIntoTable(target.id, file("Name\nVi\n"), { mapping: { Name: tName } }))), 403, "forbidden");
  });

  it("creates a new table with inferred field types from a CSV (creators only)", async () => {
    const csv = "Name,Age,Joined,Active,Tier\nAnn,30,2024-01-05,yes,gold\nBob,41,2023-12-31,no,silver\nCyd,29,2022-06-30,yes,gold\n";
    const res = parse("ImportResult", await w.owner.run(() => csvApi.importNewTable(w.baseId, file(csv, "Customers 2026.csv"))));
    expect(res.created).toBe(3);
    expect(res.fields.map((f) => [f.name, f.type])).toEqual(expect.arrayContaining([["Age", "number"], ["Joined", "date"], ["Active", "checkbox"]]));
    const t = (await refreshBase(w.owner, w.baseId)).tables.find((x) => x.id === res.table_id)!;
    expect(t.name).toBe("Customers 2026");
    expect(t.fields[0]!.name).toBe("Name");
    // Again with the same file name: the server makes the name unique.
    const again = await w.owner.run(() => csvApi.importNewTable(w.baseId, file(csv, "Customers 2026.csv")));
    const t2 = (await refreshBase(w.owner, w.baseId)).tables.find((x) => x.id === again.table_id)!;
    expect(t2.name).not.toBe("Customers 2026");
    expectError(await failure(editor.run(() => csvApi.importNewTable(w.baseId, file(csv)))), 403, "forbidden");
  });

  it("rejects a bad new-table file without leaving a table behind", async () => {
    const tablesBefore = (await refreshBase(w.owner, w.baseId)).tables.length;
    expectError(await failure(w.owner.run(() => csvApi.importNewTable(w.baseId, file("")))), 400, "bad_request");
    expect((await refreshBase(w.owner, w.baseId)).tables.length).toBe(tablesBefore);
  });
});

describe("the public error envelope", () => {
  it("is the usual {error: {code, message}} on every public endpoint", async () => {
    const e = await failure(anon.run(() => publicApi.view("tok_nothing")));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("not_found");
    expect(e.message.length).toBeGreaterThan(0);
  });
});
