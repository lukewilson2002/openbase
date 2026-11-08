/**
 * Agent access (AGT-1, AGT-3, AGT-4, AGT-6): what a full-access API token can do to workspaces and
 * folders, over REST and through the MCP tools, and that every delete can be undone. Full access is
 * `write` plus `manage`, created the way the account page does it. The OAuth side (an upgrade with
 * Change access) is in oauth.contract.test.ts, next to the SDK client it needs.
 *
 * A "folder" is a project (`base` in the REST API); a workspace's top-level project is the one whose
 * collections the app shows directly under the workspace.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api/endpoints";
import type { TrashItem } from "../src/api/types";
import { call, fails, rpc, toolNames } from "./mcpClient";
import { adminProfile, newUser, rand, seeded, type Profile } from "./support";
import { parse, parseList } from "./typecheck";

/** A REST call with a bearer token and no cookies, the way a script or `curl` would make it. */
async function rest(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${seeded.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let admin: Profile;
const created: { owner: Profile; id: string }[] = [];

async function makeToken(owner: Profile, label: string, scope: { write: boolean; manage: boolean }): Promise<string> {
  const t = parse("CreatedToken", await owner.run(() => api.tokens.create({ name: `${label}-${rand()}`, ...scope, base_ids: null, expires_in_days: null })));
  created.push({ owner, id: t.info.id });
  return t.token;
}

let full = "";
let writeOnly = "";
let readOnly = "";

beforeAll(async () => {
  admin = await adminProfile();
  full = await makeToken(admin, "agt-full", { write: true, manage: true });
  writeOnly = await makeToken(admin, "agt-write", { write: true, manage: false });
  readOnly = await makeToken(admin, "agt-read", { write: false, manage: false });
});

afterAll(async () => {
  for (const { owner, id } of created) await owner.run(() => api.tokens.revoke(id));
});

const workspaceById = async (id: string) => parseList("WorkspaceSummary", await admin.run(api.workspaces.list)).find((w) => w.id === id);

describe("a full-access token over REST", () => {
  it("creates a workspace with its top-level project, a folder, and deletes and restores them", async () => {
    const made = await rest(full, "POST", "/api/workspaces", { name: `Agent ${rand()}` });
    expect(made.status).toBe(201);
    const ws = parse("WorkspaceSummary", made.body);
    // The workspace comes with its top level, named after it, and it is listed as such.
    expect(ws.role).toBe("owner");
    expect(ws.bases).toHaveLength(1);
    expect(ws.root_base_id).toBe(ws.bases[0]!.id);
    expect(ws.bases[0]).toMatchObject({ name: ws.name, is_top_level: true });
    const top = ws.root_base_id!;

    // A folder next to it.
    const folderRes = await rest(full, "POST", `/api/workspaces/${ws.id}/bases`, { name: "Folder" });
    expect(folderRes.status).toBe(201);
    const folder = parse("BaseSchema", folderRes.body);
    expect(folder).toMatchObject({ is_top_level: false, workspace_id: ws.id });

    // Delete the folder: it leaves the listing and lands in the trash, with the date it will be purged.
    const removed = await rest(full, "DELETE", `/api/bases/${folder.id}`);
    expect(removed.status).toBe(200);
    expect((await workspaceById(ws.id))!.bases.map((b) => b.id)).toEqual([top]);
    expect((await rest(full, "GET", `/api/bases/${folder.id}`)).status).toBe(404);
    const trashed = parse("TrashListing", (await rest(full, "GET", `/api/workspaces/${ws.id}/trash`)).body).items.filter((i) => i.kind === "base");
    expect(trashed.map((i) => i.id)).toEqual([folder.id]);
    expect(trashed[0]!.expires_at).toBeGreaterThan(Date.now());

    // Restore it: the same folder, with the same id, is back.
    const restored = await rest(full, "POST", "/api/trash/restore", { kind: "base", id: folder.id });
    expect(restored.status).toBe(200);
    parse("RestoreResponse", restored.body);
    expect(parse("BaseSchema", (await rest(full, "GET", `/api/bases/${folder.id}`)).body).id).toBe(folder.id);
    expect((await workspaceById(ws.id))!.bases.map((b) => b.id).sort()).toEqual([top, folder.id].sort());

    // The workspace goes to the trash with everything in it, and comes back the same way.
    expect((await rest(full, "DELETE", `/api/workspaces/${ws.id}`)).status).toBe(200);
    expect(await workspaceById(ws.id)).toBeUndefined();
    const gone = parse("TrashListing", (await rest(full, "GET", "/api/trash/workspaces")).body).items.find((i: TrashItem) => i.id === ws.id);
    expect(gone?.kind).toBe("workspace");
    expect((await rest(full, "POST", "/api/trash/restore", { kind: "workspace", id: ws.id })).status).toBe(200);
    const back = (await workspaceById(ws.id))!;
    expect(back.root_base_id).toBe(top);
    expect(back.bases.map((b) => b.id).sort()).toEqual([top, folder.id].sort());
  });

  it("refuses to delete the top-level project and says how to fix it", async () => {
    const ws = parse("WorkspaceSummary", (await rest(full, "POST", "/api/workspaces", { name: `Top ${rand()}` })).body);
    const top = ws.root_base_id!;
    const refused = await rest(full, "DELETE", `/api/bases/${top}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("conflict");
    expect(refused.body.error.message).toContain("Make another folder the top level first, or delete the workspace");
    // Nothing moved.
    expect((await workspaceById(ws.id))!.bases.map((b) => b.id)).toEqual([top]);

    // Making another folder the top level frees the first one to be deleted, and protects the new one.
    const other = parse("BaseSchema", (await rest(full, "POST", `/api/workspaces/${ws.id}/bases`, { name: "Next top" })).body);
    const moved = parse("WorkspaceSummary", (await rest(full, "POST", `/api/workspaces/${ws.id}/top-level`, { base_id: other.id })).body);
    expect(moved.root_base_id).toBe(other.id);
    expect((await rest(full, "DELETE", `/api/bases/${top}`)).status).toBe(200);
    expect((await rest(full, "DELETE", `/api/bases/${other.id}`)).status).toBe(409);
    await rest(full, "DELETE", `/api/workspaces/${ws.id}`);
  });

  it("has no way to erase a workspace or a folder for good", async () => {
    const ws = parse("WorkspaceSummary", (await rest(full, "POST", "/api/workspaces", { name: `Keep ${rand()}` })).body);
    await rest(full, "DELETE", `/api/workspaces/${ws.id}`);
    // The trash can only be read and restored from, whatever the verb.
    for (const path of ["/api/trash", "/api/trash/workspaces", `/api/trash/${ws.id}`, "/api/trash/purge"]) {
      const res = await rest(full, "DELETE", path);
      expect([404, 405], `DELETE ${path}`).toContain(res.status);
    }
    expect((await rest(full, "POST", "/api/trash/restore", { kind: "workspace", id: ws.id })).status).toBe(200);
    expect(await workspaceById(ws.id)).toBeDefined();
    await rest(full, "DELETE", `/api/workspaces/${ws.id}`);
  });
});

describe("the same through MCP tools", () => {
  it("creates a workspace and gets its top level, creates, deletes and restores a folder, then the workspace", async () => {
    const made = await call(full, "create_workspace", { name: `Tools ${rand()}` });
    const wsId = made.workspace_id as string;
    const top = made.top_level_project as string;
    expect(top).toBeTruthy();
    expect(made.workspace).toMatchObject({ id: wsId, root_base_id: top, role: "owner" });
    expect((await workspaceById(wsId))!.root_base_id).toBe(top);

    // list_projects says which project is the top level.
    const listed = (await call(full, "list_projects", {})).workspaces.find((w: { id: string }) => w.id === wsId);
    expect(listed.top_level_project).toBe(top);
    expect(listed.bases.map((b: { id: string; is_top_level: boolean }) => [b.id, b.is_top_level])).toEqual([[top, true]]);

    // A folder: creating needs the creator role, which the owner has.
    const folder = (await call(full, "create_project", { workspace_id: wsId, name: "Folder" })).base.id as string;
    const afterCreate = (await call(full, "list_projects", {})).workspaces.find((w: { id: string }) => w.id === wsId);
    expect(afterCreate.bases.find((b: { id: string }) => b.id === folder).is_top_level).toBe(false);

    // The delete says what moved, how to bring it back and until when.
    const deleted = await call(full, "delete_project", { project_id: folder });
    expect(deleted.trashed).toMatchObject({ kind: "project", id: folder, name: "Folder" });
    expect(deleted.restore_with).toEqual({ tool: "restore_from_trash", arguments: { kind: "project", id: folder } });
    expect(deleted.retention_days).toBeGreaterThan(0);
    expect(Date.parse(deleted.purge_after)).toBeGreaterThan(Date.now());
    expect(deleted.note).toContain("restore_from_trash");
    expect((await workspaceById(wsId))!.bases.map((b) => b.id)).toEqual([top]);
    const trash = await call(full, "list_trash", { workspace_id: wsId });
    expect(trash.items.map((i: { id: string }) => i.id)).toContain(folder);

    // Run the recipe from the result exactly as written.
    await call(full, deleted.restore_with.tool, deleted.restore_with.arguments);
    expect((await workspaceById(wsId))!.bases.map((b) => b.id).sort()).toEqual([top, folder].sort());

    // Deleting the top level is refused with the way out.
    const refused = await fails(full, "delete_project", { project_id: top });
    expect(refused).toContain("Make another folder the top level first, or delete the workspace");
    expect((await call(full, "set_top_level_project", { workspace_id: wsId, project_id: folder })).top_level_project).toBe(folder);
    await call(full, "delete_project", { project_id: top });
    expect(await fails(full, "delete_project", { project_id: folder })).toContain("top");
    await call(full, "restore_from_trash", { kind: "project", id: top });

    // The workspace, with everything in it, can be undone too.
    const gone = await call(full, "delete_workspace", { workspace_id: wsId });
    expect(gone.trashed).toMatchObject({ kind: "workspace", id: wsId });
    expect(gone.trashed.projects.map((p: { id: string }) => p.id).sort()).toEqual([top, folder].sort());
    expect(gone.restore_with.arguments).toEqual({ kind: "workspace", id: wsId });
    expect(Date.parse(gone.purge_after)).toBeGreaterThan(Date.now());
    expect(await workspaceById(wsId)).toBeUndefined();
    await call(full, gone.restore_with.tool, gone.restore_with.arguments);
    const back = (await workspaceById(wsId))!;
    expect(back.root_base_id).toBe(folder);
    expect(back.bases.map((b) => b.id).sort()).toEqual([top, folder].sort());
    await call(full, "delete_workspace", { workspace_id: wsId });
  });

  it("offers no tool that erases a workspace or a folder", async () => {
    for (const name of await toolNames(full)) {
      for (const word of ["purge", "erase", "empty_trash", "destroy", "wipe"]) expect(name, `${name} looks like a permanent delete`).not.toContain(word);
    }
  });
});

describe("a token without the manage permission", () => {
  it("is refused over REST with an error that names the missing permission", async () => {
    const owned = parse("WorkspaceSummary", (await rest(full, "POST", "/api/workspaces", { name: `Guarded ${rand()}` })).body);
    const folder = parse("BaseSchema", (await rest(full, "POST", `/api/workspaces/${owned.id}/bases`, { name: "Folder" })).body);
    for (const token of [writeOnly, readOnly]) {
      const create = await rest(token, "POST", "/api/workspaces", { name: "Nope" });
      expect(create.status).toBe(403);
      expect(create.body.error.code).toBe("forbidden");
      if (token === writeOnly) expect(create.body.error.message).toContain("'manage' permission");
    }
    for (const [method, path] of [["DELETE", `/api/bases/${folder.id}`], ["DELETE", `/api/workspaces/${owned.id}`], ["POST", `/api/workspaces/${owned.id}/top-level`]] as const) {
      const res = await rest(writeOnly, method, path, method === "POST" ? { base_id: folder.id } : undefined);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.message, `${method} ${path}`).toContain("'manage' permission");
    }
    // Nothing happened.
    expect((await workspaceById(owned.id))!.bases).toHaveLength(2);
    await rest(full, "DELETE", `/api/workspaces/${owned.id}`);
  });

  it("is refused through the tools, which say which permission is missing", async () => {
    const owned = await call(full, "create_workspace", { name: `Guarded tools ${rand()}` });
    const wsId = owned.workspace_id as string;
    const folder = (await call(full, "create_project", { workspace_id: wsId, name: "Folder" })).base.id as string;
    // The manage tools are not even offered to it ...
    const offered = await toolNames(writeOnly);
    for (const name of ["create_workspace", "delete_workspace", "delete_project", "set_top_level_project"]) expect(offered, name).not.toContain(name);
    expect(offered).toContain("create_records");
    // ... and asking for one by name is an error that says what to do.
    for (const [name, args] of [
      ["create_workspace", { name: "Nope" }],
      ["delete_project", { project_id: folder }],
      ["delete_workspace", { workspace_id: wsId }],
      ["set_top_level_project", { workspace_id: wsId, project_id: folder }],
    ] as const) {
      expect(await fails(writeOnly, name, args), name).toContain("'manage' permission");
    }
    // A read-only token is refused too.
    expect(await fails(readOnly, "create_workspace", { name: "Nope" })).toMatch(/permission|write|read-only/i);
    expect((await workspaceById(wsId))!.bases).toHaveLength(2);
    await call(full, "delete_workspace", { workspace_id: wsId });
  });
});

describe("deleting needs the workspace owner, even with full access", () => {
  let creator: Profile;
  let creatorToken = "";
  let wsId = "";
  let folder = "";

  beforeAll(async () => {
    const made = await call(full, "create_workspace", { name: `Owned ${rand()}` });
    wsId = made.workspace_id;
    creator = await newUser(admin, "agt-creator");
    const invite = parse("CreatedInvite", await admin.run(() => api.invites.createForWorkspace(wsId, { role: "creator", email: null })));
    await creator.run(() => api.invites.accept(invite.url.split("/invite/")[1]!));
    creatorToken = await makeToken(creator, "agt-creator", { write: true, manage: true });
  });

  afterAll(async () => {
    await call(full, "delete_workspace", { workspace_id: wsId });
  });

  it("lets a creator with full access create a folder but not delete it or the workspace", async () => {
    const res = await rest(creatorToken, "POST", `/api/workspaces/${wsId}/bases`, { name: "Creator's folder" });
    expect(res.status).toBe(201);
    folder = parse("BaseSchema", res.body).id;
    for (const [method, path] of [["DELETE", `/api/bases/${folder}`], ["DELETE", `/api/workspaces/${wsId}`]] as const) {
      const refused = await rest(creatorToken, method, path);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.body.error.message.toLowerCase(), `${method} ${path}`).toContain("owner");
    }
    expect(await fails(creatorToken, "delete_project", { project_id: folder })).toMatch(/owner/i);
    expect(await fails(creatorToken, "delete_workspace", { workspace_id: wsId })).toMatch(/owner/i);
    // The owner's token still can.
    await call(full, "delete_project", { project_id: folder });
  });

  it("does not let an editor with full access create a folder", async () => {
    const editor = await newUser(admin, "agt-editor");
    const invite = parse("CreatedInvite", await admin.run(() => api.invites.createForWorkspace(wsId, { role: "editor", email: null })));
    await editor.run(() => api.invites.accept(invite.url.split("/invite/")[1]!));
    const token = await makeToken(editor, "agt-editor", { write: true, manage: true });
    const refused = await rest(token, "POST", `/api/workspaces/${wsId}/bases`, { name: "Editor's folder" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message.toLowerCase()).toContain("creator");
    expect((await fails(token, "create_project", { workspace_id: wsId, name: "Editor's folder" })).toLowerCase()).toContain("creator");
  });
});

describe("what the MCP catalogue tells an agent", () => {
  it("describes projects as folders and deletes as recoverable", async () => {
    const tools: { name: string; description: string }[] = (await rpc(full, "tools/list")).body.result.tools;
    const text = (n: string) => tools.find((t) => t.name === n)!.description;
    for (const n of ["list_projects", "create_project", "delete_project", "set_top_level_project"]) expect(text(n), n).toContain("folder");
    expect(text("delete_workspace")).toContain("restore_from_trash");
    expect(text("delete_project")).toContain("restore_from_trash");
    expect(text("create_workspace")).toContain("top-level project");
  });
});
