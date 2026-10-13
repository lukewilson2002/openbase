/**
 * Views through the real API client against the real server: every view type, config updates
 * (full replacement), personal and locked views, duplication, deletion and who may do what.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api/endpoints";
import { recordsApi, schemaApi } from "../src/api/records";
import type { ViewConfig, ViewType } from "../src/api/types";
import { createWorld, expectError, failure, fieldNamed, joinBase, newUser, refreshBase, tableOf, type Profile, type World } from "./support";
import { parse } from "./typecheck";

let w: World;
let tableId = "";
let nameFieldId = "";
let statusFieldId = "";
let editor: Profile;
let viewer: Profile;
let creator: Profile;

const VIEW_TYPES: ViewType[] = ["grid", "form", "gallery", "kanban", "calendar", "timeline", "list"];

beforeAll(async () => {
  w = await createWorld("Views");
  const t = w.base.tables[0]!;
  tableId = t.id;
  nameFieldId = t.primary_field_id;
  const status = await w.owner.run(() => schemaApi.createField(tableId, { name: "Status", type: "single_select", options: { choices: [{ id: "", name: "Todo", color: "gray" }, { id: "", name: "Done", color: "green" }] } }));
  statusFieldId = status.id;
  editor = await newUser(w.owner, "editor");
  viewer = await newUser(w.owner, "viewer");
  creator = await newUser(w.owner, "creator");
  await joinBase(w.owner, w.baseId, editor, "editor");
  await joinBase(w.owner, w.baseId, viewer, "viewer");
  await joinBase(w.owner, w.baseId, creator, "creator");
});

const viewsOf = async (p: Profile) => (await tableOf(p, w.baseId, tableId)).views;

describe("creating views", () => {
  for (const type of VIEW_TYPES) {
    it(`creates a ${type} view (201) with a default config`, async () => {
      const view = parse("View", await w.owner.run(() => api.views.create(tableId, { name: `A ${type}`, type, config: null })));
      expect(w.owner.status).toBe(201);
      expect(view).toMatchObject({ name: `A ${type}`, type, table_id: tableId, personal: false, locked: false });
      expect(view.config.sorts).toEqual([]);
      expect(view.config.summaries).toEqual({});
      if (type === "form") expect(view.config.form.fields.map((f) => f.field_id)).toContain(nameFieldId);
      expect((await viewsOf(w.owner)).map((v) => v.id)).toContain(view.id);
    });
  }

  it("rejects an empty name and a config that references unknown fields", async () => {
    expectError(await failure(w.owner.run(() => api.views.create(tableId, { name: " ", type: "grid", config: null }))), 400, "bad_request");
    const base = (await viewsOf(w.owner))[0]!.config;
    const bad: ViewConfig = { ...base, sorts: [{ field_id: "fldNope00000000", direction: "asc" }] };
    expectError(await failure(w.owner.run(() => api.views.create(tableId, { name: "Bad", type: "grid", config: bad }))), 400, "bad_request");
  });
});

describe("view config", () => {
  let viewId = "";
  let config: ViewConfig;

  it("replaces the whole config and answers the updated view", async () => {
    const created = parse("View", await w.owner.run(() => api.views.create(tableId, { name: "Configured", type: "grid", config: null })));
    viewId = created.id;
    config = {
      ...created.config,
      filter: { conjunction: "and", items: [{ field_id: statusFieldId, op: "is", value: "x" }] },
      sorts: [{ field_id: nameFieldId, direction: "desc" }],
      groups: [{ field_id: statusFieldId, direction: "asc" }],
      hidden_fields: [],
      field_widths: { [nameFieldId]: 320 },
      frozen_columns: 1,
      row_height: "tall",
      summaries: { [nameFieldId]: "filled" },
      row_color: { mode: "by_select", field_id: statusFieldId },
    };
    // `is` on a select takes a choice id.
    const status = fieldNamed(await tableOf(w.owner, w.baseId, tableId), "Status") as Extract<ReturnType<typeof fieldNamed>, { type: "single_select" }>;
    config.filter = { conjunction: "or", items: [{ field_id: statusFieldId, op: "is", value: status.options.choices[0]!.id }] };
    const updated = parse("View", await w.owner.run(() => api.views.update(viewId, { config })));
    expect(w.owner.status).toBe(200);
    expect(updated.config).toEqual(config);
    expect((await viewsOf(w.owner)).find((v) => v.id === viewId)?.config).toEqual(config);
  });

  it("rejects operators that do not suit the field, too many group levels and unknown fields", async () => {
    // (A field the saved config already mentions is exempt from the operator check, so use a fresh view.)
    const fresh = parse("View", await w.owner.run(() => api.views.create(tableId, { name: "Strict", type: "grid", config: null })));
    expectError(await failure(w.owner.run(() => api.views.update(fresh.id, { config: { ...fresh.config, filter: { conjunction: "and", items: [{ field_id: statusFieldId, op: "lt", value: 3 }] } } }))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => api.views.update(fresh.id, { config: { ...fresh.config, sorts: [{ field_id: "fldNope00000000", direction: "asc" }] } }))), 400, "bad_request");
    const four = Array.from({ length: 4 }, () => ({ field_id: nameFieldId, direction: "asc" as const }));
    expectError(await failure(w.owner.run(() => api.views.update(viewId, { config: { ...config, groups: four } }))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => api.views.update(viewId, { config: { ...config, hidden_fields: ["fldNope00000000"] } }))), 400, "bad_request");
    expect((await viewsOf(w.owner)).find((v) => v.id === viewId)?.config).toEqual(config);
  });

  it("renames a view and reorders it", async () => {
    const renamed = parse("View", await w.owner.run(() => api.views.update(viewId, { name: "Renamed view", position: 0 })));
    expect(renamed.name).toBe("Renamed view");
    expect(renamed.config).toEqual(config);
  });
});

describe("who may change a shared view", () => {
  let shared = "";

  it("lets only creators create shared views; editors create personal ones", async () => {
    expectError(await failure(editor.run(() => api.views.create(tableId, { name: "Shared by editor", type: "grid", config: null }))), 403, "forbidden");
    expectError(await failure(viewer.run(() => api.views.create(tableId, { name: "Personal by viewer", type: "grid", personal: true, config: null }))), 403, "forbidden");
    const created = parse("View", await creator.run(() => api.views.create(tableId, { name: "Team view", type: "grid", config: null })));
    shared = created.id;
  });

  it("lets editors save the config of an unlocked shared view but not viewers", async () => {
    const view = (await viewsOf(editor)).find((v) => v.id === shared)!;
    const config = { ...view.config, row_height: "medium" as const };
    expect(parse("View", await editor.run(() => api.views.update(shared, { config }))).config.row_height).toBe("medium");
    expectError(await failure(viewer.run(() => api.views.update(shared, { config: { ...config, row_height: "tall" } }))), 403, "forbidden");
  });

  it("locks a view: only creators change it afterwards, editors keep their personal copy options", async () => {
    expectError(await failure(editor.run(() => api.views.update(shared, { locked: true }))), 403, "forbidden");
    expect(parse("View", await creator.run(() => api.views.update(shared, { locked: true }))).locked).toBe(true);
    const view = (await viewsOf(editor)).find((v) => v.id === shared)!;
    expect(view.locked).toBe(true);
    expectError(await failure(editor.run(() => api.views.update(shared, { config: { ...view.config, row_height: "short" } }))), 403, "forbidden");
    expectError(await failure(editor.run(() => api.views.update(shared, { name: "Mine" }))), 403, "forbidden");
    expect(parse("View", await creator.run(() => api.views.update(shared, { config: { ...view.config, row_height: "short" } }))).config.row_height).toBe("short");
    expect(parse("View", await creator.run(() => api.views.update(shared, { locked: false }))).locked).toBe(false);
  });
});

describe("personal views", () => {
  let personal = "";

  it("creates a personal view that only its owner sees", async () => {
    const view = parse("View", await editor.run(() => api.views.create(tableId, { name: "Mine", type: "grid", personal: true, config: null })));
    expect(view.personal).toBe(true);
    personal = view.id;
    expect((await viewsOf(editor)).map((v) => v.id)).toContain(personal);
    expect((await viewsOf(w.owner)).map((v) => v.id)).not.toContain(personal);
    expect((await viewsOf(viewer)).map((v) => v.id)).not.toContain(personal);
  });

  it("hides it completely from other users: no query, no update, no delete", async () => {
    expectError(await failure(w.owner.run(() => recordsApi.query(personal, {}))), 404, "not_found");
    expectError(await failure(w.owner.run(() => api.views.update(personal, { name: "stolen" }))), 404, "not_found");
    expectError(await failure(w.owner.run(() => api.views.remove(personal))), 404, "not_found");
  });

  it("can be configured by its owner even when the editor could not change a locked shared view", async () => {
    const view = (await viewsOf(editor)).find((v) => v.id === personal)!;
    const config = { ...view.config, sorts: [{ field_id: nameFieldId, direction: "asc" as const }] };
    expect(parse("View", await editor.run(() => api.views.update(personal, { config }))).config.sorts).toHaveLength(1);
    // Personal views cannot be locked.
    expectError(await failure(editor.run(() => api.views.update(personal, { locked: true }))), 400, "bad_request");
  });

  it("is deleted by its owner", async () => {
    expect(parse("OkResponse", await editor.run(() => api.views.remove(personal)))).toEqual({ ok: true });
    expect((await viewsOf(editor)).map((v) => v.id)).not.toContain(personal);
  });
});

describe("duplicating and deleting views", () => {
  it("duplicates a view (201) with its config, optionally as a personal view", async () => {
    const source = (await viewsOf(w.owner)).find((v) => v.name === "Renamed view")!;
    const copy = parse("View", await w.owner.run(() => api.views.duplicate(source.id, { name: "Copy of it" })));
    expect(w.owner.status).toBe(201);
    expect(copy).toMatchObject({ name: "Copy of it", type: source.type, personal: false });
    expect(copy.id).not.toBe(source.id);
    expect(copy.config).toEqual(source.config);

    const mine = parse("View", await editor.run(() => api.views.duplicate(source.id, { personal: true })));
    expect(mine.personal).toBe(true);
    expect(mine.name.length).toBeGreaterThan(0);
  });

  it("deletes a shared view with 200 ok, and keeps at least one shared view per table", async () => {
    const created = parse("View", await w.owner.run(() => api.views.create(tableId, { name: "Short lived", type: "gallery", config: null })));
    expectError(await failure(editor.run(() => api.views.remove(created.id))), 403, "forbidden");
    expect(parse("OkResponse", await w.owner.run(() => api.views.remove(created.id)))).toEqual({ ok: true });
    expect(w.owner.status).toBe(200);
    expectError(await failure(w.owner.run(() => api.views.remove(created.id))), 404, "not_found");

    // A table with a single shared view keeps it.
    const t = parse("Table", await w.owner.run(() => api.tables.create(w.baseId, "Lonely")));
    expectError(await failure(w.owner.run(() => api.views.remove(t.views[0]!.id))), 409, "conflict");
  });

  it("restores a deleted view from the trash", async () => {
    const created = parse("View", await w.owner.run(() => api.views.create(tableId, { name: "Bring me back", type: "list", config: null })));
    await w.owner.run(() => api.views.remove(created.id));
    const trash = parse("TrashListing", await w.owner.run(() => api.trash.forBase(w.baseId)));
    expect(trash.items).toContainEqual(expect.objectContaining({ kind: "view", id: created.id }));
    parse("RestoreResponse", await w.owner.run(() => api.trash.restore({ kind: "view", id: created.id })));
    expect((await viewsOf(w.owner)).map((v) => v.id)).toContain(created.id);
    expect((await refreshBase(w.owner, w.baseId)).tables.find((t) => t.id === tableId)?.views.map((v) => v.id)).toContain(created.id);
  });
});
