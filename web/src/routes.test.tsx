/**
 * The route table of the signed-in app (UX overhaul NAV-5 and "Routes"): every screen opens in the
 * new shell with its own header inside `main` and no bar across the app, and the old redirects are
 * the new ones. What each screen shows has its own tests; these are about where a route leads.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BasePerson, BaseSummary, WorkspaceSummary } from "@/api/types";
import { automationSchema, makeAutomation } from "@/automations/testUtils";
import { ADMIN, USER, makeSchema, mockApi, renderApp, stubDesktop, type Handler } from "@/test/utils";

vi.mock("@/views/grid/GridView", async () => {
  const { PlaceholderView } = await import("@/views/PlaceholderView");
  return { default: PlaceholderView };
});

afterEach(() => vi.unstubAllGlobals());

const me: BasePerson = { user_id: "usr1", name: "Ada Lovelace", email: "ada@example.com", pending: false, role: "owner" };

function base(id: string, name: string, over: Partial<BaseSummary> = {}): BaseSummary {
  return { id, workspace_id: "wsp1", name, color: "green", role: "owner", is_top_level: false, people: [me], tables: [], ...over };
}

const TOP = base("app1", "Acme", { is_top_level: true });
const CRM = base("app2", "CRM", { color: "blue" });
const HIRING = base("app3", "Hiring", { color: "orange" });

function workspace(over: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return { id: "wsp1", name: "Acme", color: "blue", role: "owner", bases: [TOP, CRM, HIRING], root_base_id: "app1", member_count: 1, pending_invite_count: 0, ...over };
}

function routes(extra: Record<string, Handler> = {}) {
  return mockApi({
    "GET /api/auth/me": USER,
    "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false, public_url: "https://base.example.org", passkeys_enabled: true },
    "GET /api/workspaces": [workspace(), workspace({ id: "wsp2", name: "Household", color: "teal", bases: [], root_base_id: null })],
    "GET /api/notifications": { notifications: [], unread: 0 },
    "GET /api/inbox": [],
    "GET /api/workspaces/wsp1/members": [{ user_id: "usr1", name: "Ada Lovelace", email: "ada@example.com", role: "owner", all_bases: true, base_ids: [] }],
    "GET /api/workspaces/wsp1/invites": [],
    "GET /api/history": { items: [], next: null, fields: {} },
    "GET /api/trash": { items: [] },
    "GET /api/bases/app1": makeSchema("owner", { name: "Acme", is_top_level: true }),
    "GET /api/bases/app2": makeSchema("owner", { id: "app2", name: "CRM", tables: [] }),
    ...extra,
  });
}

const menu = () => screen.getByRole("navigation", { name: "Main menu" });
const headings = () => screen.getAllByRole("heading", { level: 1 });

/** The frame every screen has now: the menu, a `main`, a header inside it, and no header outside it. */
function expectFrame() {
  const main = screen.getByRole("main");
  expect(main.querySelector("header")).not.toBeNull();
  expect([...document.querySelectorAll("header")].every((h) => h.closest("main"))).toBe(true);
  expect(headings()).toHaveLength(1);
  return main;
}

describe("every signed-in route opens in the shell without a global top bar", () => {
  beforeEach(() => stubDesktop());

  it.each([
    ["/workspace/wsp1", "Home"],
    ["/notifications", "Notifications"],
    ["/workspace/wsp1/automations", "Automations"],
    ["/workspace/wsp1/members", "Members"],
    ["/workspace/wsp1/settings", "Workspace settings"],
    ["/history", "History"],
    ["/trash", "Trash"],
    ["/account", "Account settings"],
    ["/base/app2/automations", "Automations"],
    ["/base/app1", "Tasks"],
    ["/base/app2", "CRM"],
  ])("%s", async (route, title) => {
    routes();
    renderApp({ route });
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expectFrame();
    expect(menu()).toBeInTheDocument();
  });

  it("/admin, for an administrator", async () => {
    routes({ "GET /api/auth/me": ADMIN });
    renderApp({ route: "/admin" });
    expect(await screen.findByRole("heading", { level: 1, name: "Administration" })).toBeInTheDocument();
    expectFrame();
  });

  it("/admin sends everyone else away", async () => {
    routes();
    renderApp({ route: "/admin" });
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Administration" })).not.toBeInTheDocument());
  });
});

describe("/ ", () => {
  beforeEach(() => stubDesktop());

  it("redirects to the last workspace's Home", async () => {
    localStorage.setItem("ob-last-workspace", "wsp2");
    routes();
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(within(menu()).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/workspace/wsp2");
  });

  it("falls back to the first workspace when the remembered one is gone", async () => {
    localStorage.setItem("ob-last-workspace", "wspGone");
    routes();
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(within(menu()).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/workspace/wsp1");
  });

  it("shows the first-run screen when there is no workspace", async () => {
    routes({ "GET /api/workspaces": [] });
    renderApp();
    expect(await screen.findByRole("heading", { name: "Create your first workspace" })).toBeInTheDocument();
  });
});

describe("/workspace/:id/collections", () => {
  it("goes to Home on a desktop, where the menu is beside every screen", async () => {
    stubDesktop();
    routes();
    renderApp({ route: "/workspace/wsp1/collections" });
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Collections" })).not.toBeInTheDocument();
  });

  it("is a screen on a phone, holding what the menu holds", async () => {
    routes();
    renderApp({ route: "/workspace/wsp1/collections" });
    expect(await screen.findByRole("heading", { level: 1, name: "Collections" })).toBeInTheDocument();
    const main = expectFrame();
    expect(await within(main).findByRole("button", { name: /^Acme/ })).toBeInTheDocument();
    expect(within(main).getByRole("region", { name: "Collections" })).toBeInTheDocument();
    expect(within(main).getByRole("link", { name: "Trash" })).toHaveAttribute("href", "/trash?workspace=wsp1");
    expect(within(main).getByRole("link", { name: "History" })).toHaveAttribute("href", "/history?workspace=wsp1");
  });

  it("says when the workspace is not one of the person's", async () => {
    routes();
    renderApp({ route: "/workspace/wspGone/collections" });
    expect(await screen.findByText("Workspace not found")).toBeInTheDocument();
  });
});

describe("/notifications", () => {
  const list = {
    unread: 1,
    notifications: [{ id: "n1", kind: "automation", payload: { message: "Weekly digest sent" }, read_at: null, created_at: Date.now() - 60_000 }],
  };

  it.each([
    ["a desktop", true],
    ["a phone", false],
  ])("lists the notifications on %s", async (_name, desktop) => {
    if (desktop) stubDesktop();
    routes({ "GET /api/notifications": list });
    renderApp({ route: "/notifications" });
    expect(await screen.findByText("Weekly digest sent")).toBeInTheDocument();
    expectFrame();
  });

  it("marks the sidebar's Notifications row as the current page on a desktop", async () => {
    stubDesktop();
    routes({ "GET /api/notifications": list });
    renderApp({ route: "/notifications" });
    await screen.findByText("Weekly digest sent");
    expect(within(menu()).getByRole("button", { name: /^Notifications/ })).toHaveAttribute("aria-current", "page");
    expect(within(menu()).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });
});

describe("/inbox", () => {
  // The routes table: the Inbox has no route of its own, and old links land on Home, which holds the drafts.
  it("redirects to Home", async () => {
    stubDesktop();
    routes();
    renderApp({ route: "/inbox" });
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Inbox" })).not.toBeInTheDocument();
    expect(within(menu()).queryByRole("link", { name: "Inbox" })).not.toBeInTheDocument();
  });
});

describe("/workspace/:id/automations", () => {
  beforeEach(() => stubDesktop());

  const automations = (list: unknown[]) => list as Handler;

  it("lists the automations of every folder, the top level first, each linking to its editor", async () => {
    routes({
      "GET /api/bases/app1/automations": automations([makeAutomation({ id: "autA", base_id: "app1", name: "Welcome email", enabled: true })]),
      "GET /api/bases/app2/automations": automations([makeAutomation({ id: "autB", base_id: "app2", name: "Weekly digest", trigger: { type: "schedule", cron: "0 9 * * 1", timezone: "UTC" } })]),
      "GET /api/bases/app3/automations": automations([]),
    });
    renderApp({ route: "/workspace/wsp1/automations" });
    await screen.findByRole("link", { name: /Welcome email/ });
    const groups = within(screen.getByRole("main")).getAllByRole("region");
    expect(groups.map((g) => within(g).getByRole("heading", { level: 2 }).textContent)).toEqual(["Top level", "CRM", "Hiring"]);
    // A folder without any is still there, so its first one can be made.
    expect(within(groups[2]!).getByText("No automations yet.")).toBeInTheDocument();
    const welcome = within(groups[0]!).getByRole("link", { name: /Welcome email/ });
    expect(welcome).toHaveAttribute("href", "/base/app1/automations/autA");
    expect(welcome).toHaveTextContent("On · A record is created");
    expect(within(groups[1]!).getByRole("link", { name: /Weekly digest/ })).toHaveTextContent("Off · On a schedule");
    expectFrame();
  });

  it("opens the existing editor route for the automation that was chosen", async () => {
    const user = userEvent.setup();
    routes({
      "GET /api/bases/app1/automations": automations([makeAutomation({ name: "Copy tasks" })]),
      "GET /api/bases/app2/automations": automations([]),
      "GET /api/bases/app3/automations": automations([]),
      "GET /api/bases/app1": automationSchema("owner"),
      "GET /api/bases/app1/collaborators": [],
      "GET /api/automations/aut1/runs": { runs: [], total: 0 },
    });
    renderApp({ route: "/workspace/wsp1/automations" });
    await user.click(await screen.findByRole("link", { name: /Copy tasks/ }));
    expect(await screen.findByLabelText("Name")).toHaveValue("Copy tasks");
    expect(screen.getByRole("heading", { level: 1, name: "Automations" })).toBeInTheDocument();
  });

  it("offers New automation for the top level and every folder, even when none has one yet", async () => {
    routes({ "GET /api/bases/app1/automations": automations([]), "GET /api/bases/app2/automations": automations([]), "GET /api/bases/app3/automations": automations([]) });
    renderApp({ route: "/workspace/wsp1/automations" });
    expect(await screen.findAllByText("No automations yet.")).toHaveLength(3);
    // The top level has no row or menu in the sidebar, so this is the only way in to its automations.
    expect(screen.getByRole("link", { name: "New automation in Top level" })).toHaveAttribute("href", "/base/app1/automations");
    expect(screen.getByRole("link", { name: "New automation in CRM" })).toHaveAttribute("href", "/base/app2/automations");
    expect(screen.getByRole("link", { name: "New automation in Hiring" })).toHaveAttribute("href", "/base/app3/automations");
  });

  it("is for creators", async () => {
    routes({ "GET /api/workspaces": [workspace({ role: "editor", bases: [TOP, CRM].map((b) => ({ ...b, role: "editor" })) })] });
    renderApp({ route: "/workspace/wsp1/automations" });
    expect(await screen.findByText("Automations are for creators")).toBeInTheDocument();
    expect(within(menu()).queryByRole("link", { name: "Automations" })).not.toBeInTheDocument();
  });

  it("lists only the folders a limited member can open, with no top level (NAV-10)", async () => {
    const api = routes({
      "GET /api/workspaces": [workspace({ bases: [CRM], root_base_id: null })],
      "GET /api/bases/app2/automations": automations([makeAutomation({ id: "autB", base_id: "app2", name: "Weekly digest" })]),
    });
    renderApp({ route: "/workspace/wsp1/automations" });
    await screen.findByRole("link", { name: /Weekly digest/ });
    const groups = within(screen.getByRole("main")).getAllByRole("region");
    expect(groups.map((g) => within(g).getByRole("heading", { level: 2 }).textContent)).toEqual(["CRM"]);
    expect(screen.queryByRole("heading", { name: "Top level" })).not.toBeInTheDocument();
    expect(api.callsTo("GET /api/bases/app1/automations")).toHaveLength(0);
  });

  it("is offered by the menu's Automations row to creators", async () => {
    routes();
    renderApp({ route: "/workspace/wsp1" });
    await screen.findByRole("heading", { level: 1, name: "Home" });
    expect(await within(menu()).findByRole("link", { name: "Automations" })).toHaveAttribute("href", "/workspace/wsp1/automations");
  });
});

describe("/base/:baseId without collections", () => {
  beforeEach(() => stubDesktop());

  it("is the empty folder: New collection and Import CSV, under the folder's own header", async () => {
    const user = userEvent.setup();
    routes();
    renderApp({ route: "/base/app2" });
    expect(await screen.findByRole("heading", { name: "No collections in CRM yet" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "CRM" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import CSV" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New collection" }));
    expect(await screen.findByRole("dialog", { name: "New collection" })).toBeInTheDocument();
  });
});

describe("the editor route is unchanged", () => {
  beforeEach(() => stubDesktop());

  it("/base/:baseId/automations/:automationId/:tab? still opens the editor and the run history", async () => {
    routes({
      "GET /api/bases/app1": automationSchema("owner"),
      "GET /api/bases/app1/collaborators": [],
      "GET /api/bases/app1/automations": [makeAutomation({ name: "Copy tasks" })],
      "GET /api/automations/aut1/runs": { runs: [], total: 0 },
    });
    renderApp({ route: "/base/app1/automations/aut1/runs" });
    expect(await screen.findByText(/No runs yet|Runs/)).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Automations" })).toBeInTheDocument();
  });
});
