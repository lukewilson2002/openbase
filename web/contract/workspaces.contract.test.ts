/**
 * Workspaces, bases and tables through the real API client against the real server: create,
 * read the schema, rename, duplicate, collaborators and members, delete and restore from the
 * trash. Every response is checked against the generated bindings.
 */
import { describe, expect, it } from "vitest";
import { api } from "../src/api/endpoints";
import { recordsApi, schemaApi } from "../src/api/records";
import { adminProfile, createWorld, expectError, failure, joinBase, newUser, rand, refreshBase, type Profile, type World } from "./support";
import { parse, parseList } from "./typecheck";

describe("workspaces", () => {
  let owner: Profile;
  let other: Profile;
  let workspaceId = "";
  const name = `Workspace ${rand()}`;

  it("creates a workspace (201) the creator owns, with no bases yet", async () => {
    owner = await adminProfile();
    other = await newUser(owner, "outsider");
    const ws = parse("WorkspaceSummary", await owner.run(() => api.workspaces.create(name)));
    expect(owner.status).toBe(201);
    expect(ws).toMatchObject({ name, role: "owner", bases: [] });
    workspaceId = ws.id;
  });

  it("lists workspaces as a bare array, only those the caller can see", async () => {
    expect(parseList("WorkspaceSummary", await owner.run(api.workspaces.list)).map((w) => w.id)).toContain(workspaceId);
    expect(parseList("WorkspaceSummary", await other.run(api.workspaces.list)).map((w) => w.id)).not.toContain(workspaceId);
  });

  it("renames a workspace and answers the updated summary", async () => {
    const renamed = parse("WorkspaceSummary", await owner.run(() => api.workspaces.update(workspaceId, { name: `${name} (renamed)` })));
    expect(owner.status).toBe(200);
    expect(renamed).toMatchObject({ id: workspaceId, name: `${name} (renamed)` });
    expectError(await failure(owner.run(() => api.workspaces.update(workspaceId, { name: "  " }))), 400, "bad_request");
  });

  it("hides the workspace from people who are not members", async () => {
    expectError(await failure(other.run(() => api.workspaces.update(workspaceId, { name: "mine now" }))), 404, "not_found");
    expectError(await failure(other.run(() => api.workspaces.members(workspaceId))), 404, "not_found");
  });

  it("lists, changes and removes members", async () => {
    const invite = parse("CreatedInvite", await owner.run(() => api.invites.createForWorkspace(workspaceId, { role: "editor", email: null })));
    parse("InviteInfo", await other.run(() => api.invites.accept(invite.url.split("/invite/")[1]!)));
    const members = parseList("Member", await owner.run(() => api.workspaces.members(workspaceId)));
    expect(members.map((m) => [m.user_id, m.role]).sort()).toEqual(
      [
        [owner.id, "owner"],
        [other.id, "editor"],
      ].sort(),
    );

    expect(parse("OkResponse", await owner.run(() => api.workspaces.updateMember(workspaceId, other.id, { role: "viewer" })))).toEqual({ ok: true });
    expect(owner.status).toBe(200);
    expect(parseList("Member", await owner.run(() => api.workspaces.members(workspaceId))).find((m) => m.user_id === other.id)?.role).toBe("viewer");
    // A viewer cannot manage members.
    expectError(await failure(other.run(() => api.workspaces.updateMember(workspaceId, owner.id, { role: "viewer" }))), 403, "forbidden");
    expectError(await failure(owner.run(() => api.workspaces.updateMember(workspaceId, other.id, { role: "overlord" }))), 400, "bad_request");

    expect(parse("OkResponse", await owner.run(() => api.workspaces.removeMember(workspaceId, other.id)))).toEqual({ ok: true });
    expect(parseList("Member", await owner.run(() => api.workspaces.members(workspaceId))).map((m) => m.user_id)).toEqual([owner.id]);
  });

  it("deletes a workspace into the trash and restores it with its bases", async () => {
    const base = parse("BaseSchema", await owner.run(() => api.bases.create(workspaceId, { name: "Inside" })));
    expect(parse("OkResponse", await owner.run(() => api.workspaces.remove(workspaceId)))).toEqual({ ok: true });
    expect(owner.status).toBe(200);
    expect(parseList("WorkspaceSummary", await owner.run(api.workspaces.list)).map((w) => w.id)).not.toContain(workspaceId);
    expectError(await failure(owner.run(() => api.bases.get(base.id))), 404, "not_found");

    // The workspace's own trash listing is gone with it, but its owner finds it in their list of
    // deleted workspaces and can restore it; nobody else sees it or can restore it.
    expectError(await failure(owner.run(() => api.trash.forWorkspace(workspaceId))), 404, "not_found");
    const deleted = parse("TrashListing", await owner.run(api.trash.deletedWorkspaces));
    expect(deleted.items).toContainEqual(expect.objectContaining({ kind: "workspace", id: workspaceId, name: expect.any(String) }));
    expect(parse("TrashListing", await other.run(api.trash.deletedWorkspaces)).items.map((i) => i.id)).not.toContain(workspaceId);
    expectError(await failure(other.run(() => api.trash.restore({ kind: "workspace", id: workspaceId }))), 404, "not_found");
    expect(parse("RestoreResponse", await owner.run(() => api.trash.restore({ kind: "workspace", id: workspaceId })))).toEqual({ ok: true, restored_field_ids: [] });
    expect(parseList("WorkspaceSummary", await owner.run(api.workspaces.list)).map((w) => w.id)).toContain(workspaceId);
    expect(parse("TrashListing", await owner.run(api.trash.deletedWorkspaces)).items.map((i) => i.id)).not.toContain(workspaceId);
    expect((await refreshBase(owner, base.id)).name).toBe("Inside");
  });
});

describe("bases", () => {
  let w: World;
  let editor: Profile;

  it("creates a base (201) that comes with a table, a primary field and a grid view", async () => {
    w = await createWorld("Bases");
    editor = await newUser(w.owner, "editor");
    expect(w.base).toMatchObject({ workspace_id: w.workspaceId, name: "Bases base", role: "owner" });
    expect(w.base.tables.length).toBeGreaterThanOrEqual(1);
    const t = w.base.tables[0]!;
    expect(t.fields.map((f) => f.id)).toContain(t.primary_field_id);
    expect(t.views.some((v) => v.type === "grid")).toBe(true);
    // The workspace summary lists it.
    const ws = parseList("WorkspaceSummary", await w.owner.run(api.workspaces.list)).find((x) => x.id === w.workspaceId);
    expect(ws?.bases.map((b) => b.id)).toContain(w.baseId);
    parseList("BaseSummary", ws!.bases);
  });

  it("answers the full schema with the caller's role", async () => {
    const schema = await refreshBase(w.owner, w.baseId);
    expect(schema.id).toBe(w.baseId);
    expect(schema.role).toBe("owner");
    await joinBase(w.owner, w.baseId, editor, "editor");
    expect((await refreshBase(editor, w.baseId)).role).toBe("editor");
  });

  it("renames and recolours a base and answers the updated schema", async () => {
    const updated = parse("BaseSchema", await w.owner.run(() => api.bases.update(w.baseId, { name: "Renamed base", color: "blue_dark" })));
    expect(w.owner.status).toBe(200);
    expect(updated).toMatchObject({ id: w.baseId, name: "Renamed base", color: "blue_dark" });
    expectError(await failure(editor.run(() => api.bases.update(w.baseId, { name: "No" }))), 403, "forbidden");
    expectError(await failure(w.owner.run(() => api.bases.update(w.baseId, { name: "" }))), 400, "bad_request");
  });

  it("lists collaborators and members", async () => {
    const collaborators = parseList("Collaborator", await w.owner.run(() => api.bases.collaborators(w.baseId)));
    expect(collaborators.map((c) => c.id)).toEqual(expect.arrayContaining([w.owner.id, editor.id]));
    const members = parseList("Member", await w.owner.run(() => api.bases.members(w.baseId)));
    expect(members.find((m) => m.user_id === editor.id)?.role).toBe("editor");
    // Collaborators are visible to every viewer of the base, members only to managers.
    expect(parseList("Collaborator", await editor.run(() => api.bases.collaborators(w.baseId)))).not.toHaveLength(0);
    expectError(await failure(editor.run(() => api.bases.members(w.baseId))), 403, "forbidden");
  });

  it("changes and removes a base member", async () => {
    expect(parse("OkResponse", await w.owner.run(() => api.bases.updateMember(w.baseId, editor.id, { role: "commenter" })))).toEqual({ ok: true });
    expect((await refreshBase(editor, w.baseId)).role).toBe("commenter");
    expect(parse("OkResponse", await w.owner.run(() => api.bases.removeMember(w.baseId, editor.id)))).toEqual({ ok: true });
    expectError(await failure(editor.run(() => api.bases.get(w.baseId))), 404, "not_found");
  });

  it("duplicates a base with or without its records", async () => {
    const table = w.base.tables[0]!;
    await w.owner.run(() => recordsApi.create(table.id, { records: [{ values: { [table.primary_field_id]: "Row one" } }] }));

    const withRecords = parse("BaseSchema", await w.owner.run(() => api.bases.duplicate(w.baseId, { name: "Copy with records", include_records: true })));
    expect(w.owner.status).toBe(201);
    expect(withRecords).toMatchObject({ name: "Copy with records", workspace_id: w.workspaceId });
    expect(withRecords.id).not.toBe(w.baseId);
    const copiedTable = withRecords.tables[0]!;
    expect(copiedTable.id).not.toBe(table.id);
    expect(copiedTable.fields.map((f) => f.name)).toEqual(table.fields.map((f) => f.name));
    const view = copiedTable.views[0]!;
    const copied = await w.owner.run(() => recordsApi.query(view.id, {}));
    expect(parse("QueryResponse", copied).total).toBe(1);

    const withoutRecords = parse("BaseSchema", await w.owner.run(() => api.bases.duplicate(w.baseId, { name: "Copy without records", include_records: false })));
    const empty = await w.owner.run(() => recordsApi.query(withoutRecords.tables[0]!.views[0]!.id, {}));
    expect(parse("QueryResponse", empty).total).toBe(0);
  });

  it("deletes a base into the trash and restores it", async () => {
    expect(parse("OkResponse", await w.owner.run(() => api.bases.remove(w.baseId)))).toEqual({ ok: true });
    expectError(await failure(w.owner.run(() => api.bases.get(w.baseId))), 404, "not_found");
    const trash = parse("TrashListing", await w.owner.run(() => api.trash.forWorkspace(w.workspaceId)));
    expect(trash.items).toContainEqual(expect.objectContaining({ kind: "base", id: w.baseId }));
    parse("RestoreResponse", await w.owner.run(() => api.trash.restore({ kind: "base", id: w.baseId })));
    expect((await refreshBase(w.owner, w.baseId)).name).toBe("Renamed base");
  });
});

describe("tables", () => {
  let w: World;
  let tableId = "";

  it("creates a table (201) with a primary field and a grid view", async () => {
    w = await createWorld("Tables");
    const t = parse("Table", await w.owner.run(() => api.tables.create(w.baseId, "Projects")));
    expect(w.owner.status).toBe(201);
    expect(t).toMatchObject({ base_id: w.baseId, name: "Projects" });
    expect(t.fields.map((f) => f.id)).toContain(t.primary_field_id);
    expect(t.views.some((v) => v.type === "grid")).toBe(true);
    tableId = t.id;
    expectError(await failure(w.owner.run(() => api.tables.create(w.baseId, "  "))), 400, "bad_request");
  });

  it("renames a table and answers the table", async () => {
    const t = parse("Table", await w.owner.run(() => api.tables.update(tableId, { name: "Initiatives", description: "Big things" })));
    expect(w.owner.status).toBe(200);
    expect(t).toMatchObject({ id: tableId, name: "Initiatives", description: "Big things" });
    expect((await refreshBase(w.owner, w.baseId)).tables.find((x) => x.id === tableId)?.name).toBe("Initiatives");
  });

  it("changes the primary field", async () => {
    const created = await w.owner.run(() => schemaApi.createField(tableId, { name: "Code", type: "single_line_text", options: {} }));
    const t = parse("Table", await w.owner.run(() => api.tables.setPrimaryField(tableId, created.id)));
    expect(w.owner.status).toBe(200);
    expect(t.primary_field_id).toBe(created.id);
    expectError(await failure(w.owner.run(() => api.tables.setPrimaryField(tableId, "fldDoesNotExist"))), 404, "not_found");
  });

  it("duplicates a table with and without records", async () => {
    const t = (await refreshBase(w.owner, w.baseId)).tables.find((x) => x.id === tableId)!;
    await w.owner.run(() => recordsApi.create(tableId, { records: [{ values: { [t.primary_field_id]: "kept" } }, { values: { [t.primary_field_id]: "also kept" } }] }));

    const full = parse("Table", await w.owner.run(() => api.tables.duplicate(tableId, { name: "With records" })));
    expect(w.owner.status).toBe(201);
    expect(full.name).toBe("With records");
    expect(full.id).not.toBe(tableId);
    expect(full.fields.map((f) => f.name)).toEqual(t.fields.map((f) => f.name));
    expect(parse("QueryResponse", await w.owner.run(() => recordsApi.query(full.views[0]!.id, {}))).total).toBe(2);

    const bare = parse("Table", await w.owner.run(() => api.tables.duplicate(tableId, { name: "Structure only", include_records: false })));
    expect(parse("QueryResponse", await w.owner.run(() => recordsApi.query(bare.views[0]!.id, {}))).total).toBe(0);
  });

  it("deletes a table into the trash (200 ok) and restores it", async () => {
    expect(parse("OkResponse", await w.owner.run(() => api.tables.remove(tableId)))).toEqual({ ok: true });
    expect(w.owner.status).toBe(200);
    expect((await refreshBase(w.owner, w.baseId)).tables.map((x) => x.id)).not.toContain(tableId);
    const trash = parse("TrashListing", await w.owner.run(() => api.trash.forBase(w.baseId)));
    expect(trash.items).toContainEqual(expect.objectContaining({ kind: "table", id: tableId, name: "Initiatives" }));
    parse("RestoreResponse", await w.owner.run(() => api.trash.restore({ kind: "table", id: tableId })));
    expect((await refreshBase(w.owner, w.baseId)).tables.map((x) => x.id)).toContain(tableId);
  });

  it("answers 404 for a table that does not exist and 403 for people who may not manage tables", async () => {
    expectError(await failure(w.owner.run(() => api.tables.update("tblNope0000000", { name: "x" }))), 404, "not_found");
    const viewer = await newUser(w.owner, "viewer");
    await joinBase(w.owner, w.baseId, viewer, "editor");
    expectError(await failure(viewer.run(() => api.tables.create(w.baseId, "Not allowed"))), 403, "forbidden");
  });
});

describe("icons", () => {
  let w: World;
  let editor: Profile;

  it("sets, keeps and clears a workspace icon (undefined leaves it, null clears it)", async () => {
    w = await createWorld("Icons");
    editor = await newUser(w.owner, "icons-editor");
    const created = parse("WorkspaceSummary", await w.owner.run(() => api.workspaces.create(`Iconic ${rand()}`, "store")));
    expect(created.icon).toBe("store");

    const set = parse("WorkspaceSummary", await w.owner.run(() => api.workspaces.update(w.workspaceId, { icon: "briefcase" })));
    expect(set.icon).toBe("briefcase");
    // a rename must not touch the icon (the client leaves `icon` out of the body)
    const renamed = parse("WorkspaceSummary", await w.owner.run(() => api.workspaces.update(w.workspaceId, { name: "Icons renamed" })));
    expect(renamed).toMatchObject({ name: "Icons renamed", icon: "briefcase" });
    expect(parseList("WorkspaceSummary", await w.owner.run(api.workspaces.list)).find((x) => x.id === w.workspaceId)?.icon).toBe("briefcase");
    const cleared = parse("WorkspaceSummary", await w.owner.run(() => api.workspaces.update(w.workspaceId, { icon: null })));
    expect(cleared.icon ?? null).toBeNull();

    for (const bad of ["", "Briefcase", "two words", "x".repeat(65)]) {
      expectError(await failure(w.owner.run(() => api.workspaces.update(w.workspaceId, { icon: bad }))), 400, "bad_request");
    }
    expectError(await failure(w.owner.run(() => api.workspaces.create("Bad icon", "Not Valid"))), 400, "bad_request");
  });

  it("sets, keeps and clears a base icon, shown in the schema and the workspace list", async () => {
    const set = parse("BaseSchema", await w.owner.run(() => api.bases.update(w.baseId, { icon: "chart-column" })));
    expect(set.icon).toBe("chart-column");
    expect(parseList("WorkspaceSummary", await w.owner.run(api.workspaces.list)).find((x) => x.id === w.workspaceId)?.bases.find((b) => b.id === w.baseId)?.icon).toBe("chart-column");
    const renamed = parse("BaseSchema", await w.owner.run(() => api.bases.update(w.baseId, { name: "Icons base" })));
    expect(renamed).toMatchObject({ name: "Icons base", icon: "chart-column" });
    expect(parse("BaseSchema", await w.owner.run(() => api.bases.update(w.baseId, { icon: null }))).icon ?? null).toBeNull();
    expectError(await failure(w.owner.run(() => api.bases.update(w.baseId, { icon: "NOPE" }))), 400, "bad_request");
    const withIcon = parse("BaseSchema", await w.owner.run(() => api.bases.create(w.workspaceId, { name: "Born with an icon", icon: "store" })));
    expect(withIcon.icon).toBe("store");
  });

  it("sets, keeps and clears a table icon, and only people who can rename the table may", async () => {
    const t = parse("Table", await w.owner.run(() => api.tables.create(w.baseId, "Shipments", "truck")));
    expect(t.icon).toBe("truck");
    expect(parse("Table", await w.owner.run(() => api.tables.update(t.id, { icon: "package" }))).icon).toBe("package");
    expect(parse("Table", await w.owner.run(() => api.tables.update(t.id, { description: "Things in transit" }))).icon).toBe("package");
    expect((await refreshBase(w.owner, w.baseId)).tables.find((x) => x.id === t.id)?.icon).toBe("package");
    expectError(await failure(w.owner.run(() => api.tables.update(t.id, { icon: "bad icon" }))), 400, "bad_request");

    await joinBase(w.owner, w.baseId, editor, "editor");
    expectError(await failure(editor.run(() => api.tables.update(t.id, { icon: "star" }))), 403, "forbidden");
    expectError(await failure(editor.run(() => api.bases.update(w.baseId, { icon: "star" }))), 403, "forbidden");
    // ...but they see the icon
    expect((await refreshBase(editor, w.baseId)).tables.find((x) => x.id === t.id)?.icon).toBe("package");

    expect(parse("Table", await w.owner.run(() => api.tables.update(t.id, { icon: null }))).icon ?? null).toBeNull();
  });

  it("copies icons when a table or a base is duplicated", async () => {
    await w.owner.run(() => api.bases.update(w.baseId, { icon: "store" }));
    const t = parse("Table", await w.owner.run(() => api.tables.create(w.baseId, "Orders", "shopping-cart")));
    const tableCopy = parse("Table", await w.owner.run(() => api.tables.duplicate(t.id, { name: "Orders again", include_records: false })));
    expect(tableCopy.icon).toBe("shopping-cart");
    const baseCopy = parse("BaseSchema", await w.owner.run(() => api.bases.duplicate(w.baseId, { name: "Icons copy", include_records: false })));
    expect(baseCopy.icon).toBe("store");
    expect(baseCopy.tables.find((x) => x.name === "Orders")?.icon).toBe("shopping-cart");
  });

  it("lists the icon of a trashed table, base and workspace", async () => {
    const t = parse("Table", await w.owner.run(() => api.tables.create(w.baseId, "Doomed", "heart")));
    await w.owner.run(() => api.tables.remove(t.id));
    const trash = parse("TrashListing", await w.owner.run(() => api.trash.forBase(w.baseId)));
    expect(trash.items).toContainEqual(expect.objectContaining({ kind: "table", id: t.id, icon: "heart" }));

    const ws = parse("WorkspaceSummary", await w.owner.run(() => api.workspaces.create(`Trashed ${rand()}`, "folder")));
    const base = parse("BaseSchema", await w.owner.run(() => api.bases.create(ws.id, { name: "Doomed base", icon: "star" })));
    await w.owner.run(() => api.bases.remove(base.id));
    expect(parse("TrashListing", await w.owner.run(() => api.trash.forWorkspace(ws.id))).items).toContainEqual(expect.objectContaining({ kind: "base", id: base.id, icon: "star" }));
    await w.owner.run(() => api.workspaces.remove(ws.id));
    expect(parse("TrashListing", await w.owner.run(api.trash.deletedWorkspaces)).items).toContainEqual(expect.objectContaining({ kind: "workspace", id: ws.id, icon: "folder" }));
  });
});
