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
        is_top_level: false,
        people: [me, grace, jordan],
        tables: [
          { id: "tbl1", name: "Tasks", icon: null, color: "blue", record_count: 0, record_noun: "" },
          { id: "tbl2", name: "People", icon: "users", color: "blue", record_count: 0, record_noun: "" },
        ],
      },
      { id: "app2", workspace_id: "wsp1", name: "CRM", color: "blue", icon: "users", role: "owner", is_top_level: false, people: [me], tables: [] },
    ],
  },
  {
    id: "wsp2",
    name: "Shared with me",
    color: "blue",
    role: "viewer",
    member_count: 3,
    pending_invite_count: 0,
    bases: [{ id: "app3", workspace_id: "wsp2", name: "Roadmap", color: "red", role: "viewer", is_top_level: false, people: [me, grace], tables: [] }],
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

const remember = (place: { tables?: Record<string, string>; projects?: Record<string, string> }) =>
  localStorage.setItem("ob-last-place", JSON.stringify({ tables: {}, projects: {}, ...place }));

describe("/", () => {
  it("opens the last workspace's Home: it does not take the person back to the project they left", async () => {
    stubDesktop();
    localStorage.setItem("ob-last-workspace", "wsp2");
    remember({ projects: { app3: "tbl2" }, tables: { tbl2: "viw4" } });
    routes();
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Roadmap" })).not.toBeInTheDocument();
    // The sidebar's Home row is the screen being shown, and it is the remembered workspace's.
    const menu = screen.getByRole("navigation", { name: "Main menu" });
    expect(within(menu).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/workspace/wsp2");
    expect(within(menu).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    // The switcher names that workspace: it does not lead back to its remembered project either.
    expect(await within(menu).findByRole("button", { name: /^Shared with me/ })).toBeInTheDocument();
  });

  it("opens the first workspace's Home when none was used, or the remembered one is gone", async () => {
    stubDesktop();
    localStorage.setItem("ob-last-workspace", "wspGone");
    routes();
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Main menu" })).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/workspace/wsp1");
  });

  it("opens Home for a workspace without projects too", async () => {
    stubDesktop();
    routes({ "GET /api/workspaces": [{ ...workspaces[0]!, bases: [] }] });
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
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

    // The new workspace opens on its own Home.
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(api.callsTo("POST /api/workspaces")[0]?.body).toEqual({ name: "Studio", color: "blue" });
  });

  it("gives the first workspace the colour picked for it", async () => {
    const user = userEvent.setup();
    const api = routes({
      "GET /api/workspaces": [],
      "POST /api/workspaces": { id: "wsp9", name: "Studio", color: "red", role: "owner", bases: [], member_count: 1, pending_invite_count: 0 },
    });
    renderApp();
    const name = await screen.findByRole("textbox", { name: "Workspace name" });
    // The mark beside the name starts on the first hue and follows the pick, so what is made is what was shown.
    const mark = name.parentElement!.querySelector(".ob-mark")!;
    expect(mark).toHaveClass("ob-hue-blue");
    await user.type(name, "Studio");
    await user.click(screen.getByRole("radio", { name: "Red" }));
    expect(mark).toHaveClass("ob-hue-red");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces")[0]?.body).toEqual({ name: "Studio", color: "red" }));
  });

  it("shows an error when the workspaces cannot be loaded", async () => {
    routes({ "GET /api/workspaces": apiError(500, "internal", "Something broke") });
    renderApp();
    expect(await screen.findByText("Something broke")).toBeInTheDocument();
  });
});

describe("/workspace/:id", () => {
  it("is that workspace's Home, not its last project", async () => {
    stubDesktop();
    remember({ projects: { app2: "tbl9" } });
    const api = routes();
    renderApp({ route: "/workspace/wsp1" });
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(api.callsTo("GET /api/bases/app2")).toHaveLength(0);
    expect(localStorage.getItem("ob-last-workspace")).toBe("wsp1");
  });

  it("offers no spreadsheet import of its own: a CSV file is one collection, imported inside a folder", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderApp({ route: "/workspace/wsp1" });
    await screen.findByRole("heading", { level: 1, name: "Home" });
    expect(screen.queryByRole("button", { name: /spreadsheet|import/i })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /^Acme/ }));
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

describe("workspace settings", () => {
  it("changes a workspace's color on its settings page", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({ "PATCH /api/workspaces/wsp1": workspaces[0]! });
    renderApp({ route: "/workspace/wsp1/settings" });
    await screen.findByRole("heading", { level: 1, name: "Workspace settings" });
    await user.click(screen.getByRole("button", { name: "Change color…" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Workspace color" })).getByRole("radio", { name: "Orange" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1")[0]?.body).toEqual({ color: "orange" }));
  });
});
