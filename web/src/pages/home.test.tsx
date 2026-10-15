import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BasePerson, WorkspaceSummary } from "@/api/types";
import { USER, apiError, makeSchema, mockApi, renderApp, stubDesktop, type Handler } from "@/test/utils";

afterEach(() => vi.unstubAllGlobals());

const me: BasePerson = { user_id: "usr1", name: "Ada Lovelace", email: "ada@example.com", pending: false, role: "owner" };
const grace: BasePerson = { user_id: "usr2", name: "Grace Hopper", email: "grace@example.com", pending: false, role: "editor" };
const jordan: BasePerson = { user_id: null, name: "jordan@example.com", email: "jordan@example.com", pending: true, role: "viewer" };

const workspaces: WorkspaceSummary[] = [
  {
    id: "wsp1",
    name: "Acme",
    role: "owner",
    member_count: 2,
    pending_invite_count: 1,
    bases: [
      { id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", role: "owner", people: [me, grace, jordan] },
      { id: "app2", workspace_id: "wsp1", name: "CRM", color: "blue", icon: "users", role: "owner", people: [me] },
    ],
  },
  {
    id: "wsp2",
    name: "Shared with me",
    role: "viewer",
    member_count: 3,
    pending_invite_count: 0,
    bases: [{ id: "app3", workspace_id: "wsp2", name: "Roadmap", color: "red", role: "viewer", people: [me, grace] }],
  },
];

function routes(extra: Record<string, Handler> = {}) {
  return mockApi({ "GET /api/auth/me": USER, "GET /api/workspaces": workspaces, "GET /api/notifications": { notifications: [], unread: 0 }, ...extra });
}

describe("/", () => {
  it("opens the workspace opened last", async () => {
    localStorage.setItem("ob-last-workspace", "wsp2");
    routes();
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "Shared with me" })).toBeInTheDocument();
  });

  it("falls back to the first workspace", async () => {
    localStorage.setItem("ob-last-workspace", "wspGone");
    routes();
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "Acme" })).toBeInTheDocument();
    expect(localStorage.getItem("ob-last-workspace")).toBe("wsp1");
  });

  it("offers to create the first workspace and opens it", async () => {
    const user = userEvent.setup();
    let list: WorkspaceSummary[] = [];
    const api = routes({
      "GET /api/workspaces": () => list,
      "POST /api/workspaces": (call) => {
        list = [{ id: "wsp9", name: (call.body as { name: string }).name, role: "owner", bases: [], member_count: 1, pending_invite_count: 0 }];
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

    expect(await screen.findByRole("heading", { level: 1, name: "Studio" })).toBeInTheDocument();
    expect(api.callsTo("POST /api/workspaces")[0]?.body).toEqual({ name: "Studio" });
    expect(screen.getByText("Make your first base")).toBeInTheDocument();
    expect(screen.getByText("Only you")).toBeInTheDocument();
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
        const ws: WorkspaceSummary = { id: "wsp9", name: (call.body as { name: string }).name, icon: "store", role: "owner", bases: [], member_count: 1, pending_invite_count: 0 };
        list = [...list, ws];
        return ws;
      },
    });
    renderApp({ route: "/workspace/wsp1" });
    const menu = await screen.findByRole("navigation", { name: "Main menu" });
    expect(await within(menu).findByRole("link", { name: "Shared with me" })).toHaveAttribute("href", "/workspace/wsp2");
    expect(within(menu).getByRole("link", { name: "Bases" })).toHaveAttribute("aria-current", "page");
    expect(within(menu).getByRole("link", { name: "Members" })).toHaveAttribute("href", "/workspace/wsp1/members");
    expect(within(menu).getByRole("link", { name: "Workspace settings" })).toHaveAttribute("href", "/workspace/wsp1/settings");
    expect(within(menu).getByRole("link", { name: "Trash" })).toHaveAttribute("href", "/trash");
    expect(within(menu).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/account");

    await user.click(within(menu).getByRole("button", { name: "New workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    await user.type(within(dialog).getByLabelText("Name"), "Studio");
    await user.click(within(dialog).getByRole("button", { name: "Choose icon" }));
    await user.click(await screen.findByRole("button", { name: "Store" }));
    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces")[0]?.body).toEqual({ name: "Studio", icon: "store" });
    expect(await screen.findByRole("heading", { level: 1, name: "Studio" })).toBeInTheDocument();
  });

  it("restores a deleted workspace from Trash", async () => {
    const user = userEvent.setup();
    let deleted = [{ kind: "workspace", id: "wspOld", name: "Old clients", icon: "users", table_id: null, deleted_at: Date.now() - 3 * 24 * 3600_000 }];
    const api = routes({
      "GET /api/trash/workspaces": () => ({ items: deleted }),
      "POST /api/trash/restore": () => {
        deleted = [];
        return { ok: true, restored_field_ids: [] };
      },
    });
    renderApp({ route: "/trash" });
    const section = (await screen.findByRole("heading", { name: "Recently deleted workspaces" })).closest("section")!;
    expect(within(section).getByText("Deleted 3 days ago")).toBeInTheDocument();
    expect(section.querySelector("svg.lucide-users")).toBeInTheDocument();
    await user.click(within(section).getByRole("button", { name: "Restore Old clients" }));
    await waitFor(() => expect(api.callsTo("POST /api/trash/restore")[0]?.body).toEqual({ kind: "workspace", id: "wspOld" }));
    expect(await screen.findByText("No deleted workspaces")).toBeInTheDocument();
  });

  it("says when Trash is empty", async () => {
    routes({ "GET /api/trash/workspaces": { items: [] } });
    renderApp({ route: "/trash" });
    expect(await screen.findByText("No deleted workspaces")).toBeInTheDocument();
  });
});

describe("workspace page", () => {
  it("lists the bases with their tables, who can open every base, and who else can open each", async () => {
    stubDesktop();
    routes({ "GET /api/bases/app1": makeSchema("owner") });
    renderApp({ route: "/workspace/wsp1" });
    expect(await screen.findByRole("heading", { level: 1, name: "Acme" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Can open every base in Acme: you" })).toHaveAttribute("href", "/workspace/wsp1/members");
    const bases = screen.getByRole("list", { name: "Bases" });
    expect(within(bases).getByRole("link", { name: "Project tracker" })).toHaveAttribute("href", "/base/app1");

    const tracker = within(bases).getByRole("link", { name: "Project tracker" }).closest("li")!;
    expect(await within(tracker).findByRole("list", { name: "Tables in Project tracker: Tasks, People" })).toBeInTheDocument();
    // Only the people beyond those who can open every base, with the invited one dashed.
    expect(within(tracker).getByRole("img", { name: "Also opens Project tracker: Grace Hopper and jordan@example.com (invited, not joined yet)" })).toBeInTheDocument();
    expect(tracker.querySelector("[data-pending]")).toHaveClass("border-dashed");
    const crm = within(bases).getByRole("link", { name: "CRM" }).closest("li")!;
    expect(within(crm).queryByRole("img", { name: /Also opens/ })).not.toBeInTheDocument();
    expect(crm.querySelector("svg.lucide-users")).toBeInTheDocument();
  });

  it("shows a few tables of a base, then how many more", async () => {
    stubDesktop();
    const schema = makeSchema("owner");
    const table = schema.tables[1]!;
    const tables = ["Tasks", "People", "Sprints", "Bugs", "Ideas"].map((name, i) => ({ ...table, id: `tbl${i}`, name }));
    routes({ "GET /api/bases/app1": { ...schema, tables } });
    renderApp({ route: "/workspace/wsp1" });
    const chips = await screen.findByRole("list", { name: /^Tables in Project tracker/ });
    expect(within(chips).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Tasks", "People", "Sprints", "+2"]);
  });

  it("says Only you for a workspace nobody else is in, and leaves out the legend without invites", async () => {
    routes({ "GET /api/workspaces": [{ ...workspaces[0]!, member_count: 1, pending_invite_count: 0, bases: [workspaces[0]!.bases[1]!] }] });
    renderApp({ route: "/workspace/wsp1" });
    expect(await screen.findByRole("link", { name: "Only you" })).toHaveAttribute("href", "/workspace/wsp1/members");
    expect(screen.queryByText(/A grey, dashed face/)).not.toBeInTheDocument();
  });

  it("gives a viewer nothing to create or manage", async () => {
    routes();
    renderApp({ route: "/workspace/wsp2" });
    await screen.findByRole("heading", { level: 1, name: "Shared with me" });
    expect(screen.getByRole("link", { name: "Roadmap" })).toBeInTheDocument();
    for (const name of ["New base", "Import a spreadsheet", "Share", "Workspace actions for Shared with me", "Actions for Roadmap"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /Change icon of/ })).not.toBeInTheDocument();
  });

  it("puts New base and Import in the header on a desktop", async () => {
    stubDesktop();
    routes();
    renderApp({ route: "/workspace/wsp1" });
    await screen.findByRole("heading", { level: 1, name: "Acme" });
    expect(screen.getByRole("button", { name: "New base" })).not.toHaveClass("fixed");
    expect(screen.getByRole("button", { name: "Import a spreadsheet" })).not.toHaveClass("fixed");
  });

  it("floats Import and New base at the bottom corners on a phone", async () => {
    routes();
    renderApp({ route: "/workspace/wsp1" });
    await screen.findByRole("heading", { level: 1, name: "Acme" });
    expect(screen.getByRole("button", { name: "New base" })).toHaveClass("fixed", "right-[max(1rem,env(safe-area-inset-right))]");
    expect(screen.getByRole("button", { name: "Import a spreadsheet" })).toHaveClass("fixed", "left-[max(1rem,env(safe-area-inset-left))]");
  });

  it("creates an empty base with a colour and an icon, and opens it", async () => {
    const user = userEvent.setup();
    const api = routes({ "POST /api/workspaces/wsp1/bases": { id: "app9", workspace_id: "wsp1", name: "Fresh", color: "pink", icon: "wallet", role: "owner", people: [], tables: [], workspace_name: "Acme" } });
    renderApp({ route: "/workspace/wsp1" });
    await user.click(await screen.findByRole("button", { name: "New base" }));
    const dialog = await screen.findByRole("dialog", { name: "New base" });
    await user.type(within(dialog).getByLabelText("Name"), "Fresh");
    await user.click(within(dialog).getByRole("radio", { name: "Pink" }));
    await user.click(within(dialog).getByRole("button", { name: "Choose icon" }));
    await user.click(await screen.findByRole("button", { name: "Wallet" }));
    await user.click(within(dialog).getByRole("button", { name: "Create base" }));

    await waitFor(() => expect(api.callsTo("POST /api/workspaces/wsp1/bases")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces/wsp1/bases")[0]?.body).toEqual({ name: "Fresh", color: "pink", icon: "wallet", empty: true });
    await waitFor(() => expect(api.callsTo("GET /api/bases/app9").length).toBeGreaterThan(0));
  });

  it("imports a spreadsheet into a new base named after the file", async () => {
    const user = userEvent.setup();
    const api = routes({
      "POST /api/workspaces/wsp1/bases": { id: "app9", workspace_id: "wsp1", name: "contacts", color: "blue_dark", role: "owner", people: [], tables: [], workspace_name: "Acme" },
      "POST /api/bases/app9/import": { table_id: "tbl9", created: 2, fields: [{ id: "f1", name: "Name", type: "single_line_text" }] },
    });
    renderApp({ route: "/workspace/wsp1" });
    await user.click(await screen.findByRole("button", { name: "Import a spreadsheet" }));
    const dialog = await screen.findByRole("dialog", { name: "Import a spreadsheet" });
    await user.upload(await within(dialog).findByLabelText("CSV file"), new File(["Name\nAda\nGrace\n"], "contacts.csv", { type: "text/csv" }));
    expect(await within(dialog).findByLabelText("Name")).toHaveValue("contacts");
    await user.click(within(dialog).getByRole("button", { name: "Import" }));

    await waitFor(() => expect(api.callsTo("POST /api/bases/app9/import")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces/wsp1/bases")[0]?.body).toEqual({ name: "contacts", empty: true });
    await waitFor(() => expect(api.callsTo("GET /api/bases/app9").length).toBeGreaterThan(0));
  });

  it("offers an empty workspace its first base", async () => {
    stubDesktop();
    routes({ "GET /api/workspaces": [{ ...workspaces[0]!, bases: [] }] });
    renderApp({ route: "/workspace/wsp1" });
    expect(await screen.findByRole("heading", { name: "Make your first base" })).toBeInTheDocument();
    expect(screen.getByText("A base holds one project. Start empty, or bring in a spreadsheet you already have.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New base" })).toHaveLength(2);
  });

  it("keeps the base menu: rename sends the icon only when it changed", async () => {
    const user = userEvent.setup();
    const api = routes({ "PATCH /api/bases/app1": { status: 204 } });
    renderApp({ route: "/workspace/wsp1" });
    await user.click(await screen.findByRole("button", { name: "Actions for Project tracker" }));
    await user.click(await screen.findByRole("menuitem", { name: /Rename or recolour/ }));
    const dialog = await screen.findByRole("dialog", { name: "Edit base" });
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Tracker");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/bases/app1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/bases/app1")[0]?.body).toEqual({ name: "Tracker", color: "green_dark" });
  });

  it("changes a base icon, duplicates and deletes a base from its menu", async () => {
    const user = userEvent.setup();
    const api = routes({
      "PATCH /api/bases/app2": { status: 204 },
      "POST /api/bases/app2/duplicate": { id: "app8" },
      "DELETE /api/bases/app2": { status: 204 },
    });
    renderApp({ route: "/workspace/wsp1" });
    await user.click(await screen.findByRole("button", { name: "Actions for CRM" }));
    await user.click(await screen.findByRole("menuitem", { name: /Change icon/ }));
    await user.click(await within(await screen.findByRole("dialog", { name: "Base icon" })).findByRole("button", { name: "Heart" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/bases/app2")[0]?.body).toEqual({ icon: "heart" }));

    await user.click(screen.getByRole("button", { name: "Actions for CRM" }));
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() => expect(api.callsTo("POST /api/bases/app2/duplicate")[0]?.body).toEqual({ name: "CRM copy", include_records: true }));

    await user.click(screen.getByRole("button", { name: "Actions for CRM" }));
    await user.click(await screen.findByRole("menuitem", { name: /Delete base/ }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Delete base" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/bases/app2")).toHaveLength(1));
  });

  it("lets the owner change the workspace icon from its tile, rename it and delete it", async () => {
    const user = userEvent.setup();
    const api = routes({ "PATCH /api/workspaces/wsp1": { ...workspaces[0]! }, "DELETE /api/workspaces/wsp1": { ok: true } });
    renderApp({ route: "/workspace/wsp1" });
    await user.click(await screen.findByRole("button", { name: "Change icon of Acme" }));
    await user.click(await screen.findByRole("button", { name: "Heart" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1")[0]?.body).toEqual({ icon: "heart" }));

    await user.click(screen.getByRole("button", { name: "Workspace actions for Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    const rename = await screen.findByRole("dialog", { name: "Rename workspace" });
    await user.clear(within(rename).getByLabelText("Name"));
    await user.type(within(rename).getByLabelText("Name"), "Acme Inc");
    await user.click(within(rename).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1")[1]?.body).toEqual({ name: "Acme Inc" }));

    await user.click(screen.getByRole("button", { name: "Workspace actions for Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: /Delete workspace/ }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete workspace" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/workspaces/wsp1")).toHaveLength(1));
  });

  it("says when the workspace does not exist and forgets it as the last one", async () => {
    localStorage.setItem("ob-last-workspace", "wspGone");
    routes();
    renderApp({ route: "/workspace/wspGone" });
    expect(await screen.findByText("Workspace not found")).toBeInTheDocument();
    expect(localStorage.getItem("ob-last-workspace")).toBeNull();
  });

  it("opens the Share dialog for the whole workspace, with the views of every base", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes({ "GET /api/bases/app1": makeSchema("owner"), "GET /api/bases/app2": makeSchema("owner", { id: "app2", name: "CRM", tables: [] }) });
    renderApp({ route: "/workspace/wsp1" });
    await user.click(await screen.findByRole("button", { name: "Share" }));
    const dialog = await screen.findByRole("dialog", { name: "Share Acme" });
    expect(within(dialog).getByRole("radio", { name: "All bases in Acme" })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: /Send invite/ })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("tab", { name: "Share a view" }));
    const select = await within(dialog).findByLabelText("View");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Project tracker › Tasks › All tasks", "Project tracker › Tasks › Board", "Project tracker › People › Everyone"]);
  });
});
