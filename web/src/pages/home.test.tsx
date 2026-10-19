import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BasePerson, WorkspaceSummary } from "@/api/types";
import { USER, apiError, makeSchema, mockApi, renderApp, stubDesktop, type Handler } from "@/test/utils";

// These tests are about where the home routes lead; the grid itself has its own tests.
vi.mock("@/views/grid/GridView", async () => {
  const { PlaceholderView } = await import("@/views/PlaceholderView");
  return { default: PlaceholderView };
});

afterEach(() => vi.unstubAllGlobals());

const me: BasePerson = { user_id: "usr1", name: "Ada Lovelace", email: "ada@example.com", pending: false, role: "owner" };
const grace: BasePerson = { user_id: "usr2", name: "Grace Hopper", email: "grace@example.com", pending: false, role: "editor" };
const jordan: BasePerson = { user_id: null, name: "jordan@example.com", email: "jordan@example.com", pending: true, role: "viewer" };

const workspaces: WorkspaceSummary[] = [
  {
    id: "wsp1",
    name: "Acme",
    color: "green",
    role: "owner",
    member_count: 2,
    pending_invite_count: 1,
    bases: [
      {
        id: "app1",
        workspace_id: "wsp1",
        name: "Project tracker",
        color: "green_dark",
        role: "owner",
        people: [me, grace, jordan],
        tables: [
          { id: "tbl1", name: "Tasks", icon: null },
          { id: "tbl2", name: "People", icon: "users" },
        ],
      },
      { id: "app2", workspace_id: "wsp1", name: "CRM", color: "blue", icon: "users", role: "owner", people: [me], tables: [] },
    ],
  },
  {
    id: "wsp2",
    name: "Shared with me",
    color: "blue",
    role: "viewer",
    member_count: 3,
    pending_invite_count: 0,
    bases: [{ id: "app3", workspace_id: "wsp2", name: "Roadmap", color: "red", role: "viewer", people: [me, grace], tables: [] }],
  },
];

function routes(extra: Record<string, Handler> = {}) {
  return mockApi({
    "GET /api/auth/me": USER,
    "GET /api/workspaces": workspaces,
    "GET /api/notifications": { notifications: [], unread: 0 },
    "GET /api/inbox": [],
    "GET /api/bases/app1": makeSchema("owner"),
    "GET /api/bases/app2": makeSchema("owner", { id: "app2", name: "CRM", tables: [] }),
    "GET /api/bases/app3": makeSchema("viewer", { id: "app3", workspace_id: "wsp2", name: "Roadmap", workspace_name: "Shared with me" }),
    ...extra,
  });
}

/** The workspaces list as the server keeps it: a deleted project is gone from the next fetch. */
function withDeletable(id: string): Record<string, Handler> {
  let list = workspaces;
  return {
    "GET /api/workspaces": () => list,
    [`DELETE /api/bases/${id}`]: () => {
      list = list.map((w) => ({ ...w, bases: w.bases.filter((b) => b.id !== id) }));
      return { status: 204 };
    },
  };
}

const remember = (place: { tables?: Record<string, string>; projects?: Record<string, string>; workspaces?: Record<string, string> }) =>
  localStorage.setItem("ob-last-place", JSON.stringify({ tables: {}, projects: {}, workspaces: {}, ...place }));

describe("/", () => {
  it("is the Inbox: it does not take the person back to the project they left", async () => {
    stubDesktop();
    localStorage.setItem("ob-last-workspace", "wsp2");
    remember({ workspaces: { wsp2: "app3" }, projects: { app3: "tbl2" }, tables: { tbl2: "viw4" } });
    routes();
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Roadmap" })).not.toBeInTheDocument();
    // The menu is the way to the projects, and the Inbox row is the page being shown.
    const menu = screen.getByRole("navigation", { name: "Main menu" });
    expect(within(menu).getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
    // The workspace's name folds it: it does not lead back to its remembered project either.
    expect(await within(menu).findByRole("button", { name: "Shared with me" })).toBeInTheDocument();
    expect(within(menu).queryByRole("link", { name: "Shared with me" })).not.toBeInTheDocument();
  });

  it("is the Inbox for a workspace without projects too", async () => {
    stubDesktop();
    routes({ "GET /api/workspaces": [{ ...workspaces[0]!, bases: [] }] });
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
  });

  it("offers to create the first workspace and opens it", async () => {
    const user = userEvent.setup();
    let list: WorkspaceSummary[] = [];
    const api = routes({
      "GET /api/workspaces": () => list,
      "POST /api/workspaces": (call) => {
        list = [{ id: "wsp9", name: (call.body as { name: string }).name, color: "green", role: "owner", bases: [], member_count: 1, pending_invite_count: 0 }];
        return list[0];
      },
    });
    renderApp();
    expect(await screen.findByRole("heading", { name: "Create your first workspace" })).toBeInTheDocument();
    expect(screen.getByText("Workspaces are private until you invite someone.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Suggestions" })).not.toBeInTheDocument();
    const name = screen.getByRole("textbox", { name: "Workspace name" });
    expect(name).toHaveAttribute("placeholder", "For example, Personal");
    await user.type(name, "Studio");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(await screen.findByRole("heading", { name: "No projects in Studio yet" })).toBeInTheDocument();
    expect(api.callsTo("POST /api/workspaces")[0]?.body).toEqual({ name: "Studio" });
  });

  it("gives the first workspace the colour picked for it", async () => {
    const user = userEvent.setup();
    const api = routes({
      "GET /api/workspaces": [],
      "POST /api/workspaces": { id: "wsp9", name: "Studio", color: "red", role: "owner", bases: [], member_count: 1, pending_invite_count: 0 },
    });
    renderApp();
    await user.type(await screen.findByRole("textbox", { name: "Workspace name" }), "Studio");
    await user.click(screen.getByRole("radio", { name: "Red" }));
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces")[0]?.body).toEqual({ name: "Studio", color: "red" }));
  });

  it("shows an error when the workspaces cannot be loaded", async () => {
    routes({ "GET /api/workspaces": apiError(500, "internal", "Something broke") });
    renderApp();
    expect(await screen.findByText("Something broke")).toBeInTheDocument();
  });
});

describe("home menu", () => {
  it("lists the workspaces, expands the open one, and creates a new one from the + button", async () => {
    stubDesktop();
    const user = userEvent.setup();
    let list = workspaces;
    const api = routes({
      "GET /api/workspaces": () => list,
      "POST /api/workspaces": (call) => {
        const ws: WorkspaceSummary = { id: "wsp9", name: (call.body as { name: string }).name, icon: "store", color: "blue", role: "owner", bases: [], member_count: 1, pending_invite_count: 0 };
        list = [...list, ws];
        return ws;
      },
    });
    renderApp({ route: "/workspace/wsp1/settings" });
    const menu = await screen.findByRole("navigation", { name: "Main menu" });
    expect(await within(menu).findByRole("button", { name: "Shared with me" })).toBeInTheDocument();
    const acme = await within(menu).findByRole("list", { name: "Projects in Acme" });
    expect(within(acme).getByRole("button", { name: "Project tracker" })).toBeInTheDocument();
    expect(within(acme).getByRole("button", { name: "CRM" })).toBeInTheDocument();
    expect(within(acme).queryAllByRole("link")).toHaveLength(0);
    // The Trash of everything closes the menu; account settings are in the profile menu now.
    expect(within(menu).getAllByRole("link", { name: "Trash" }).at(-1)).toHaveAttribute("href", "/trash");
    expect(within(menu).getAllByRole("link").some((l) => l.getAttribute("href") === "/account")).toBe(false);

    await user.click(within(menu).getByRole("button", { name: "New workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    await user.type(within(dialog).getByLabelText("Name"), "Studio");
    await user.click(within(dialog).getByRole("button", { name: "Choose icon" }));
    await user.click(await screen.findByRole("button", { name: "Store" }));
    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces")[0]?.body).toEqual({ name: "Studio", icon: "store" });
    expect(await screen.findByRole("heading", { name: "No projects in Studio yet" })).toBeInTheDocument();
  });
});

describe("/workspace/:id", () => {
  it("opens the project last opened in the workspace", async () => {
    stubDesktop();
    remember({ workspaces: { wsp1: "app2" } });
    const api = routes();
    renderApp({ route: "/workspace/wsp1" });
    expect(await screen.findByRole("heading", { level: 1, name: "CRM" })).toBeInTheDocument();
    expect(api.callsTo("GET /api/bases/app2").length).toBeGreaterThan(0);
  });

  it("opens the first project when none was opened, or the remembered one is gone", async () => {
    stubDesktop();
    remember({ workspaces: { wsp1: "appGone" } });
    routes();
    renderApp({ route: "/workspace/wsp1" });
    expect(await screen.findByRole("heading", { level: 1, name: "Project tracker" })).toBeInTheDocument();
  });

  it("gives an empty workspace its page: make a project", async () => {
    stubDesktop();
    routes({ "GET /api/workspaces": [{ ...workspaces[0]!, bases: [] }] });
    renderApp({ route: "/workspace/wsp1" });
    expect(await screen.findByRole("heading", { name: "No projects in Acme yet" })).toBeInTheDocument();
    expect(screen.getByText("A project holds your tables. Make one, then add a table to it, or import a CSV file as its first table.")).toBeInTheDocument();
  });

  it("tells a viewer to wait, with nothing to create", async () => {
    stubDesktop();
    routes({ "GET /api/workspaces": [{ ...workspaces[1]!, bases: [] }] });
    renderApp({ route: "/workspace/wsp2" });
    expect(await screen.findByRole("heading", { name: "No projects in Shared with me yet" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New project" })).not.toBeInTheDocument();
  });

  it("creates an empty project with an icon from the empty page, and opens it", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({
      "GET /api/workspaces": [{ ...workspaces[0]!, bases: [] }],
      "POST /api/workspaces/wsp1/bases": makeSchema("owner", { id: "app9", name: "Fresh", icon: "wallet" }),
      "GET /api/bases/app9": makeSchema("owner", { id: "app9", name: "Fresh", icon: "wallet" }),
    });
    renderApp({ route: "/workspace/wsp1" });
    await user.click(await screen.findByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    await user.type(within(dialog).getByLabelText("Project name"), "Fresh");
    await user.click(within(dialog).getByRole("button", { name: "Choose icon" }));
    await user.click(await screen.findByRole("button", { name: "Wallet" }));
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(api.callsTo("POST /api/workspaces/wsp1/bases")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces/wsp1/bases")[0]?.body).toEqual({ name: "Fresh", icon: "wallet", empty: true });
    await waitFor(() => expect(api.callsTo("GET /api/bases/app9").length).toBeGreaterThan(0));
  });

  it("offers no spreadsheet import of its own: a CSV file is one table, imported inside a project", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes({ "GET /api/workspaces": [{ ...workspaces[0]!, bases: [] }] });
    renderApp({ route: "/workspace/wsp1" });
    expect(await screen.findByRole("button", { name: "New project" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /spreadsheet|import/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Workspace options for Acme" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: /spreadsheet|import/i })).not.toBeInTheDocument();
  });

  it("says when the workspace does not exist and forgets it as the last one", async () => {
    localStorage.setItem("ob-last-workspace", "wspGone");
    routes();
    renderApp({ route: "/workspace/wspGone" });
    expect(await screen.findByText("Workspace not found")).toBeInTheDocument();
    expect(localStorage.getItem("ob-last-workspace")).toBeNull();
  });
});

describe("the project menu in the tree", () => {
  const open = () => renderApp({ route: "/workspace/wsp1/settings" });

  it("renames a project, sending the icon only when it changed", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({ "PATCH /api/bases/app1": { status: 204 } });
    open();
    await user.click(await screen.findByRole("button", { name: "Project options for Project tracker" }));
    await user.click(await screen.findByRole("menuitem", { name: /Rename project/ }));
    const dialog = await screen.findByRole("dialog", { name: "Rename project" });
    const name = within(dialog).getByLabelText("Project name");
    await user.clear(name);
    await user.type(name, "Tracker");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/bases/app1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/bases/app1")[0]?.body).toEqual({ name: "Tracker" });
  });

  it("changes a project's icon, duplicates it and deletes it", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({
      "PATCH /api/bases/app2": { status: 204 },
      "POST /api/bases/app2/duplicate": { id: "app8" },
      ...withDeletable("app2"),
    });
    open();
    await user.click(await screen.findByRole("button", { name: "Project options for CRM" }));
    await user.click(await screen.findByRole("menuitem", { name: /Change icon/ }));
    await user.click(await within(await screen.findByRole("dialog", { name: "Project icon" })).findByRole("button", { name: "Heart" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/bases/app2")[0]?.body).toEqual({ icon: "heart" }));

    await user.click(screen.getByRole("button", { name: "Project options for CRM" }));
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate project" }));
    await waitFor(() => expect(api.callsTo("POST /api/bases/app2/duplicate")[0]?.body).toEqual({ name: "CRM copy", include_records: true }));

    await user.click(screen.getByRole("button", { name: "Project options for CRM" }));
    await user.click(await screen.findByRole("menuitem", { name: /Delete project/ }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Delete project" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/bases/app2")).toHaveLength(1));
    // Gone from the menu without waiting for the list to come back.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Project options for CRM" })).not.toBeInTheDocument());
  });

  it("leaves a deleted project's own page for its workspace", async () => {
    stubDesktop();
    const user = userEvent.setup();
    remember({ workspaces: { wsp1: "app2" }, projects: { app2: "tbl1" } });
    const api = routes(withDeletable("app2"));
    renderApp({ route: "/base/app2/tbl1/viw1" });
    await screen.findByRole("heading", { level: 1, name: "CRM" });
    await user.click(await screen.findByRole("button", { name: "Project options for CRM" }));
    await user.click(await screen.findByRole("menuitem", { name: /Delete project/ }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete project" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/bases/app2")).toHaveLength(1));
    // Not back to the project it just lost, although it was the last one opened here.
    expect(await screen.findByRole("heading", { level: 1, name: "Project tracker" })).toBeInTheDocument();
  });

  it("shares a project from its menu", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    open();
    await user.click(await screen.findByRole("button", { name: "Project options for Project tracker" }));
    await user.click(await screen.findByRole("menuitem", { name: /Share/ }));
    expect(await screen.findByRole("dialog", { name: "Share Project tracker" })).toBeInTheDocument();
  });
});

describe("the workspace menu in the tree", () => {
  const open = () => renderApp({ route: "/workspace/wsp1/settings" });

  it("renames and deletes the workspace, and changes its icon", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({ "PATCH /api/workspaces/wsp1": { ...workspaces[0]! }, "DELETE /api/workspaces/wsp1": { ok: true } });
    open();
    await user.click(await screen.findByRole("button", { name: "Workspace options for Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: /Change icon/ }));
    await user.click(await screen.findByRole("button", { name: "Heart" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1")[0]?.body).toEqual({ icon: "heart" }));
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Workspace options for Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const rename = await screen.findByRole("dialog", { name: "Rename workspace" });
    await user.clear(within(rename).getByLabelText("Name"));
    await user.type(within(rename).getByLabelText("Name"), "Acme Inc");
    await user.click(within(rename).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1")[1]?.body).toEqual({ name: "Acme Inc" }));

    await user.click(screen.getByRole("button", { name: "Workspace options for Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: /Delete workspace/ }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete workspace" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/workspaces/wsp1")).toHaveLength(1));
  });

  it("opens the Share dialog for the whole workspace, with the views of every project", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes();
    open();
    await user.click(await screen.findByRole("button", { name: "Workspace options for Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: /Invite people/ }));
    const dialog = await screen.findByRole("dialog", { name: "Share Acme" });
    expect(within(dialog).getByRole("radio", { name: "All projects in Acme" })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: /Send invite/ })).toBeInTheDocument();
    // The projects' schemas (for their views) load only once "Share a view" is opened.
    expect(api.callsTo("GET /api/bases/app1")).toHaveLength(0);

    await user.click(within(dialog).getByRole("tab", { name: "Share a view" }));
    const select = await within(dialog).findByLabelText("View");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Project tracker › Tasks › All tasks", "Project tracker › Tasks › Board", "Project tracker › People › Everyone"]);
  });
});

describe("colors of workspaces and projects", () => {
  const open = () => renderApp({ route: "/workspace/wsp1/settings" });

  it("creates a workspace with the color chosen in its dialog, and sends none when none was chosen", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({ "POST /api/workspaces": (call) => ({ ...workspaces[0]!, id: "wsp9", name: (call.body as { name: string }).name, bases: [] }) });
    open();
    const menu = await screen.findByRole("navigation", { name: "Main menu" });
    await user.click(await within(menu).findByRole("button", { name: "New workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    await user.type(within(dialog).getByLabelText("Name"), "Studio");
    await user.click(within(dialog).getByRole("radio", { name: "Red" }));
    expect(within(dialog).getByRole("radio", { name: "Red" })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces")[0]?.body).toEqual({ name: "Studio", color: "red" });
  });

  it("sends no color when none was chosen, so the server picks one", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({ "POST /api/workspaces": (call) => ({ ...workspaces[0]!, id: "wsp9", name: (call.body as { name: string }).name, bases: [] }) });
    open();
    const menu = await screen.findByRole("navigation", { name: "Main menu" });
    await user.click(await within(menu).findByRole("button", { name: "New workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    expect(within(dialog).queryByRole("radio", { checked: true })).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Name"), "Garage");
    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces")[0]?.body).toEqual({ name: "Garage" });
  });

  it("creates a project with the color chosen in its dialog", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({ "POST /api/workspaces/wsp1/bases": makeSchema("owner", { id: "app9", name: "Garden", tables: [] }) });
    open();
    await user.click(await screen.findByRole("button", { name: "Workspace options for Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    await user.type(within(dialog).getByLabelText("Project name"), "Garden");
    await user.click(within(dialog).getByRole("radio", { name: "Teal" }));
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces/wsp1/bases")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces/wsp1/bases")[0]?.body).toEqual({ name: "Garden", color: "teal", empty: true });
  });

  it("changes a workspace's color from its menu, starting on the color it has", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({ "PATCH /api/workspaces/wsp1": workspaces[0]! });
    open();
    await user.click(await screen.findByRole("button", { name: "Workspace options for Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: /Change color/ }));
    const dialog = await screen.findByRole("dialog", { name: "Workspace color" });
    expect(within(dialog).getByRole("radio", { name: "Green" })).toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: "Purple" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/workspaces/wsp1")[0]?.body).toEqual({ color: "purple" });
    // The dialog closed, and the list is fetched again so every tile follows.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace color" })).not.toBeInTheDocument());
    await waitFor(() => expect(api.callsTo("GET /api/workspaces").length).toBeGreaterThan(1));
  });

  it("changes a workspace's color on its settings page", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({ "PATCH /api/workspaces/wsp1": workspaces[0]! });
    open();
    await screen.findByRole("heading", { level: 1, name: "Workspace settings" });
    await user.click(screen.getByRole("button", { name: "Change color…" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Workspace color" })).getByRole("radio", { name: "Orange" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1")[0]?.body).toEqual({ color: "orange" }));
  });

  it("changes a project's color from its menu", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({ "PATCH /api/bases/app2": { status: 204 } });
    open();
    await user.click(await screen.findByRole("button", { name: "Project options for CRM" }));
    await user.click(await screen.findByRole("menuitem", { name: /Change color/ }));
    const dialog = await screen.findByRole("dialog", { name: "Project color" });
    expect(within(dialog).getByRole("radio", { name: "Blue" })).toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: "Pink" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/bases/app2")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/bases/app2")[0]?.body).toEqual({ color: "pink" });
  });

  it("offers the color to whoever may rename: no workspace color for a non-owner, no project color for a viewer", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    open();
    await user.click(await screen.findByRole("button", { name: "Workspace options for Shared with me" }));
    expect(await screen.findByRole("menuitem", { name: /Members/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Change color/ })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Expand Shared with me" }));
    await user.click(await screen.findByRole("button", { name: "Project options for Roadmap" }));
    expect(await screen.findByRole("menuitem", { name: /Members/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Change color/ })).not.toBeInTheDocument();
  });
});
