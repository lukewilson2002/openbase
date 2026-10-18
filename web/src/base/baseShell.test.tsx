import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BasePerson, BaseSchema } from "@/api/types";
import { SIDEBAR_KEY } from "@/shell/sidebarPrefs";
import { USER, apiError, makeSchema, makeView, makeWorkspace, mockApi, renderApp, stubDesktop } from "@/test/utils";

// These tests are about the shell (menu, top bar, permissions). The real grid draws on a canvas
// and has its own tests under src/views/grid, so the shell tests render the placeholder for it.
vi.mock("@/views/grid/GridView", async () => {
  const { PlaceholderView } = await import("@/views/PlaceholderView");
  const { useSearchParams } = await import("react-router");
  // Shows the ?record= parameter so tests can see whether the shell's redirects keep it.
  function Stub(props: Parameters<typeof PlaceholderView>[0]) {
    const [params] = useSearchParams();
    return (
      <>
        <PlaceholderView {...props} />
        <output data-testid="record-param">{params.get("record")}</output>
      </>
    );
  }
  return { default: Stub };
});

// Same for the kanban view (its own tests live in src/views/kanban).
vi.mock("@/views/kanban/KanbanView", async () => {
  const { PlaceholderView } = await import("@/views/PlaceholderView");
  return { default: PlaceholderView };
});

afterEach(() => vi.unstubAllGlobals());

function openBase(role: string, extra: Record<string, unknown> = {}, route = "/base/app1") {
  const api = mockApi({
    "GET /api/auth/me": USER,
    "GET /api/bases/app1": makeSchema(role),
    "GET /api/workspaces": [makeWorkspace(role, [{ id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", role, people: [], tables: [] }])],
    "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false, public_url: "https://base.example.org", passkeys_enabled: true },
    ...extra,
  });
  renderApp({ route });
  return api;
}

const menu = () => screen.getByRole("navigation", { name: "Main menu" });
const tables = () => screen.getByRole("list", { name: "Tables in Project tracker" });
/** The menu's "…" for the open project: what the pickers, the workspace page and the footer used to hold. */
const openProjectMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Project options for Project tracker" }));
  return screen.findByRole("menu");
};
const itemNames = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim());

/** Opens the "Add view" menu of the open table. */
async function openAddView(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(tables()).getByRole("button", { name: "Add view" }));
  return screen.findByRole("menu");
}

describe("base shell on a desktop", () => {
  beforeEach(() => stubDesktop());

  it("canonicalises the URL and renders the first view through the registry", async () => {
    openBase("owner");
    expect(await screen.findByText("Grid view coming soon")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All tasks" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("main", { name: "All tasks" })).toBeInTheDocument();
  });

  it("puts the project in the app shell: `Acme / Project tracker` as plain text in the top bar, the Inbox then the tree in the menu", async () => {
    openBase("viewer");
    await screen.findByText("Grid view coming soon");
    const header = document.querySelector("header")!;
    expect(within(header).getByText("Acme")).toBeInTheDocument();
    expect(within(header).getByRole("heading", { name: "Project tracker", level: 1 })).toBeInTheDocument();
    // The names are text now, not pickers.
    expect(within(header).queryByRole("button", { name: /Acme|Project tracker/ })).not.toBeInTheDocument();
    // A viewer can neither invite nor share a view, so there is no Share to open.
    expect(within(header).queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(within(menu()).getAllByRole("button")[0]).toHaveAccessibleName("Inbox");
    expect(await within(menu()).findByRole("button", { name: "Account menu" })).toBeInTheDocument();
    // One tree: the workspace, its project, the project's tables.
    expect(within(menu()).getByRole("button", { name: "Collapse Acme" })).toHaveAttribute("aria-expanded", "true");
    expect(within(within(menu()).getByRole("list", { name: "Projects in Acme" })).getByRole("button", { name: "Collapse Project tracker" })).toBeInTheDocument();
    expect(within(tables()).getByRole("link", { name: "Tasks" })).toBeInTheDocument();
    expect(within(menu()).queryByRole("link", { name: "Members" })).not.toBeInTheDocument();
  });

  it("shows the other workspaces' projects from inside a project, and expanding one lists its tables without leaving", async () => {
    const user = userEvent.setup();
    const garden = makeSchema("owner", { id: "app2", workspace_id: "wsp2", name: "Garden", workspace_name: "Home" });
    garden.tables = [{ ...garden.tables[1]!, id: "tbl7", base_id: "app2", name: "Plants", views: [makeView({ id: "viw7", table_id: "tbl7", name: "All plants" })] }];
    const api = openBase("owner", {
      "GET /api/workspaces": [
        makeWorkspace("owner", [{ id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", role: "owner", people: [], tables: [] }]),
        { ...makeWorkspace("owner", [{ id: "app2", workspace_id: "wsp2", name: "Garden", color: "green", role: "owner", people: [], tables: [] }]), id: "wsp2", name: "Home" },
      ],
      "GET /api/bases/app2": garden,
    });
    await screen.findByText("Grid view coming soon");
    expect(screen.queryByRole("list", { name: "Projects in Home" })).not.toBeInTheDocument();
    await user.click(within(menu()).getByRole("button", { name: "Expand Home" }));
    expect(within(within(menu()).getByRole("list", { name: "Projects in Home" })).getByRole("link", { name: "Garden" })).toHaveAttribute("href", "/base/app2");
    // Nothing is fetched for a project until it is opened.
    expect(api.callsTo("GET /api/bases/app2")).toHaveLength(0);
    await user.click(within(menu()).getByRole("button", { name: "Expand Garden" }));
    const plants = await within(menu()).findByRole("list", { name: "Tables in Garden" });
    expect(within(plants).getByRole("link", { name: "Plants" })).toHaveAttribute("href", "/base/app2/tbl7");
    // The open project's schema is one query shared by its page and the tree.
    expect(api.callsTo("GET /api/bases/app1")).toHaveLength(1);
    expect(screen.getByText("Grid view coming soon")).toBeInTheDocument();
    // The dialogs of tables and views exist only in the open project: another one keeps what needs none.
    expect(within(plants).queryByRole("button", { name: "Add table" })).not.toBeInTheDocument();
    await user.click(within(plants).getByRole("button", { name: "Table options for Plants" }));
    expect(itemNames(await screen.findByRole("menu"))).toEqual(["Duplicate table"]);
  });

  it("makes a new project in the workspace from the workspace menu", async () => {
    const user = userEvent.setup();
    const api = openBase("creator", { "POST /api/workspaces/wsp1/bases": { ...makeSchema("creator"), id: "app2", name: "Garden", tables: [] } });
    await screen.findByText("Grid view coming soon");
    await user.click(screen.getByRole("button", { name: "Workspace options for Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    await user.type(within(dialog).getByLabelText("Project name"), "Garden");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces/wsp1/bases")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces/wsp1/bases")[0]?.body).toEqual({ name: "Garden", empty: true });
  });

  describe("who is viewing", () => {
    const people: BasePerson[] = [
      { user_id: "usr1", name: "Ada Lovelace", email: "ada@example.com", pending: false, role: "owner" },
      { user_id: "usr2", name: "Grace Hopper", email: "grace@example.com", pending: false, role: "editor" },
      { user_id: null, name: "alan@example.com", email: "alan@example.com", pending: true, role: "viewer" },
    ];

    /** The stream the page opens, driven by the test. */
    function stubStream() {
      const streams: { emit: (viewers: string[]) => void }[] = [];
      class FakeEventSource {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        private listeners = new Map<string, (ev: MessageEvent<string>) => void>();
        constructor() {
          streams.push({
            emit: (viewers) => this.listeners.get("presence_changed")?.({ data: JSON.stringify({ base_id: "app1", client_id: null, user_id: null, event: { kind: "presence_changed", viewers } }) } as MessageEvent<string>),
          });
        }
        addEventListener(type: string, l: (ev: MessageEvent<string>) => void) {
          this.listeners.set(type, l);
        }
        close() {}
      }
      vi.stubGlobal("EventSource", FakeEventSource);
      return streams;
    }

    it("shows you alone until someone else arrives, the others who can open it as +N, linking to the members page", async () => {
      openBase("owner", { "GET /api/bases/app1": makeSchema("owner", { people }) });
      const faces = await screen.findByRole("img", { name: "1 person viewing now, 2 more can open this project: you" });
      expect(faces.closest("a")).toHaveAttribute("href", "/workspace/wsp1/members");
      expect(faces).toHaveTextContent("+2");
    });

    it("draws a face for each person the project's stream says is viewing, and drops it when they leave", async () => {
      const streams = stubStream();
      openBase("owner", { "GET /api/bases/app1": makeSchema("owner", { people }) });
      await screen.findByRole("img", { name: /^1 person viewing now/ });
      await waitFor(() => expect(streams).toHaveLength(1));

      act(() => streams[0]!.emit(["usr1", "usr2"]));
      const both = await screen.findByRole("img", { name: "2 people viewing now, 1 more can open this project: you and Grace Hopper" });
      expect(both).toHaveTextContent("+1");
      expect(within(both).getAllByRole("img", { hidden: true }).map((f) => f.getAttribute("aria-label"))).toEqual(["Ada Lovelace", "Grace Hopper"]);

      act(() => streams[0]!.emit(["usr1"]));
      expect(await screen.findByRole("img", { name: "1 person viewing now, 2 more can open this project: you" })).toHaveTextContent("+2");
    });
  });

  it.each([
    ["commenter", false],
    ["editor", false],
    ["creator", true],
    ["owner", true],
  ])("offers Share to a %s: %s", async (role, offered) => {
    openBase(role);
    await screen.findByText("Grid view coming soon");
    const header = document.querySelector("header")!;
    expect(within(header).queryByRole("button", { name: "Share" }) !== null).toBe(offered);
  });

  it("switches views and renders the placeholder for each view type", async () => {
    const user = userEvent.setup();
    openBase("owner");
    await screen.findByText("Grid view coming soon");
    await user.click(screen.getByRole("link", { name: "Board" }));
    expect(await screen.findByText("Kanban view coming soon")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
  });

  it("switches tables, opening the other table's first view, and expands only the open table", async () => {
    const user = userEvent.setup();
    openBase("owner");
    await screen.findByText("Grid view coming soon");
    expect(screen.queryByRole("link", { name: "Everyone" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "People" }));
    expect(await screen.findByRole("link", { name: "Everyone" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "All tasks" })).not.toBeInTheDocument();
  });

  it("opens the view last used in a table when its row is tapped, and remembers each view it shows", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ob-last-place", JSON.stringify({ tables: { tbl1: "viw2" }, projects: {}, workspaces: {} }));
    openBase("owner", {}, "/base/app1/tbl2/viw4");
    await screen.findByText("Grid view coming soon");
    expect(JSON.parse(localStorage.getItem("ob-last-place")!)).toEqual({ tables: { tbl1: "viw2", tbl2: "viw4" }, projects: { app1: "tbl2" }, workspaces: { wsp1: "app1" } });
    await user.click(within(tables()).getByRole("link", { name: "Tasks" }));
    expect(await screen.findByText("Kanban view coming soon")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
    expect(JSON.parse(localStorage.getItem("ob-last-place")!)).toEqual({ tables: { tbl1: "viw2", tbl2: "viw4" }, projects: { app1: "tbl1" }, workspaces: { wsp1: "app1" } });
    expect(localStorage.getItem("ob-last-workspace")).toBe("wsp1");
  });

  it("opens the last table and view when the address has none", async () => {
    localStorage.setItem("ob-last-place", JSON.stringify({ tables: { tbl2: "viw4", tbl1: "viw2" }, projects: { app1: "tbl2" }, workspaces: {} }));
    openBase("owner");
    expect(await screen.findByRole("main", { name: "Everyone" })).toBeInTheDocument();
  });

  it("opens a table's last view when the address names only the table", async () => {
    localStorage.setItem("ob-last-place", JSON.stringify({ tables: { tbl1: "viw2" }, projects: {}, workspaces: {} }));
    openBase("owner", {}, "/base/app1/tbl1");
    expect(await screen.findByRole("main", { name: "Board" })).toBeInTheDocument();
  });

  it("falls back to the first table and view when the remembered ones are gone", async () => {
    localStorage.setItem("ob-last-place", JSON.stringify({ tables: { tbl1: "viwGone" }, projects: { app1: "tblGone" }, workspaces: {} }));
    openBase("owner");
    expect(await screen.findByRole("main", { name: "All tasks" })).toBeInTheDocument();
    cleanup();
    localStorage.setItem("ob-last-place", JSON.stringify({ tables: { tbl1: "viwGone" }, projects: {}, workspaces: {} }));
    openBase("owner", {}, "/base/app1/tbl1");
    expect(await screen.findByRole("main", { name: "All tasks" })).toBeInTheDocument();
  });

  it("expands and collapses a table with its chevron without opening it", async () => {
    const user = userEvent.setup();
    openBase("owner");
    await screen.findByText("Grid view coming soon");
    const show = screen.getByRole("button", { name: "Show views of People" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    await user.click(show);
    expect(screen.getByRole("link", { name: "Everyone" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "All tasks" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("button", { name: "Hide views of Tasks" }));
    expect(screen.queryByRole("link", { name: "All tasks" })).not.toBeInTheDocument();
  });

  it("shows personal views in their own list, marked as personal", async () => {
    openBase("editor");
    await screen.findByText("Grid view coming soon");
    const personal = screen.getByRole("list", { name: "Personal views" });
    expect(within(personal).getByRole("link", { name: /My tasks/ })).toBeInTheDocument();
    expect(within(personal).getByRole("img", { name: "Personal view" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Shared views" })).queryByText("My tasks")).not.toBeInTheDocument();
  });

  it("collapses the menu with the corner toggle and remembers it", async () => {
    const user = userEvent.setup();
    openBase("owner");
    await screen.findByText("Grid view coming soon");
    await user.click(screen.getByRole("button", { name: "Hide menu" }));
    expect(screen.queryByRole("navigation", { name: "Main menu" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(SIDEBAR_KEY)!)).toMatchObject({ collapsed: true });
    // The view keeps the page.
    expect(screen.getByText("Grid view coming soon")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show menu" }));
    expect(tables()).toBeInTheDocument();
  });

  it("explains a missing project", async () => {
    mockApi({ "GET /api/auth/me": USER, "GET /api/bases/app1": apiError(404, "not_found", "base not found") });
    renderApp({ route: "/base/app1" });
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to my projects" })).toBeInTheDocument();
  });

  describe("viewer", () => {
    it("cannot add tables, create views, rename the base or manage views and tables", async () => {
      openBase("viewer");
      await screen.findByText("Grid view coming soon");
      expect(screen.queryByRole("button", { name: "Add table" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Table options/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Add view" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Options for/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Automations" })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Project tracker", level: 1 })).toBeInTheDocument();
    });

    it("has no Share (nothing to invite or share) but still finds the members", async () => {
      const user = userEvent.setup();
      openBase("viewer");
      await screen.findByText("Grid view coming soon");
      expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
      const projectMenu = await openProjectMenu(user);
      expect(itemNames(projectMenu)).toEqual(["Members"]);
      expect(within(projectMenu).getByRole("menuitem", { name: "Members" })).toHaveAttribute("href", "/workspace/wsp1/members");
    });
  });

  describe("editor", () => {
    it("can create personal views only and cannot change tables or shared views", async () => {
      const user = userEvent.setup();
      const api = openBase("editor", {
        "POST /api/tables/tbl1/views": (call: { body: unknown }) => ({ id: "viw9", table_id: "tbl1", name: (call.body as { name: string }).name, type: "calendar", personal: true, locked: false, config: {} }),
      });
      await screen.findByText("Grid view coming soon");
      expect(screen.queryByRole("button", { name: "Add table" })).not.toBeInTheDocument();
      expect(screen.queryByTitle("Rename base")).not.toBeInTheDocument();
      // Shared views are creator territory; the editor's own personal view is manageable.
      expect(screen.queryByRole("button", { name: "Options for All tasks" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Options for My tasks" })).toBeInTheDocument();

      const types = await openAddView(user);
      expect(within(types).getByText(/Editors can create personal views/)).toBeInTheDocument();
      await user.click(within(types).getByRole("menuitem", { name: /^Calendar/ }));
      const dialog = await screen.findByRole("dialog", { name: "New calendar view" });
      expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
      expect(within(dialog).getByLabelText("Name")).toHaveValue("Calendar view");
      await user.click(within(dialog).getByRole("button", { name: "Create view" }));
      await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/views")).toHaveLength(1));
      expect(api.callsTo("POST /api/tables/tbl1/views")[0]?.body).toEqual({ name: "Calendar view", type: "calendar", personal: true, config: null });
    });

    it("has no Automations or project Trash, but Members", async () => {
      const user = userEvent.setup();
      openBase("editor");
      await screen.findByText("Grid view coming soon");
      expect(screen.queryByRole("link", { name: "Automations" })).not.toBeInTheDocument();
      expect(itemNames(await openProjectMenu(user))).toEqual(["Members"]);
    });
  });

  describe("importing CSV", () => {
    it("lets editors import into a table but not rename, duplicate or delete it", async () => {
      const user = userEvent.setup();
      openBase("editor");
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Table options for Tasks" }));
      expect(await screen.findByRole("menuitem", { name: /Import CSV/ })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Rename table" })).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Delete table" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("menuitem", { name: /Import CSV/ }));
      expect(await screen.findByRole("dialog", { name: "Import CSV into Tasks" })).toBeInTheDocument();
    });

    it("keeps viewers and commenters out of it", async () => {
      openBase("commenter");
      await screen.findByText("Grid view coming soon");
      expect(screen.queryByRole("button", { name: /Table options/ })).not.toBeInTheDocument();
    });

    it("offers creators a new table from CSV next to the empty one", async () => {
      const user = userEvent.setup();
      openBase("creator");
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Add table" }));
      expect(await screen.findByRole("menuitem", { name: "New empty table" })).toBeInTheDocument();
      await user.click(screen.getByRole("menuitem", { name: /New table from CSV/ }));
      expect(await screen.findByRole("dialog", { name: "New table from CSV" })).toBeInTheDocument();
    });
  });

  describe("creator", () => {
    it("can manage tables, rename the project and create each of the seven view types", async () => {
      const user = userEvent.setup();
      openBase("creator");
      await screen.findByText("Grid view coming soon");
      expect(screen.getByRole("button", { name: "Add table" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Table options for Tasks" })).toBeInTheDocument();
      // Every table has its menu, not only the open one.
      expect(screen.getByRole("button", { name: "Table options for People" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Options for All tasks" })).toBeInTheDocument();
      const types = await openAddView(user);
      const items = within(types).getAllByRole("menuitem");
      expect(items.map((i) => i.textContent)).toEqual([
        "GridRows and columns, like a spreadsheet",
        "FormA page others fill in to add records",
        "GalleryBig cards with pictures",
        "KanbanCards in columns by a single select",
        "CalendarRecords placed on their dates",
        "TimelineStart and end dates as bars",
        "ListA simple, compact list",
      ]);
      expect(within(types).queryByText(/Editors can create/)).not.toBeInTheDocument();
    });

    it("creates a shared view, with the personal option unchecked by default", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", {
        "POST /api/tables/tbl1/views": { id: "viw9", table_id: "tbl1", name: "Sprint board", type: "kanban", personal: false, locked: false, config: {} },
      });
      await screen.findByText("Grid view coming soon");
      await user.click(within(await openAddView(user)).getByRole("menuitem", { name: /^Kanban/ }));
      const dialog = await screen.findByRole("dialog", { name: "New kanban view" });
      expect(within(dialog).getByRole("checkbox", { name: /Personal view/ })).not.toBeChecked();
      const name = within(dialog).getByLabelText("Name");
      await user.clear(name);
      await user.type(name, "Sprint board");
      await user.click(within(dialog).getByRole("button", { name: "Create view" }));
      await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/views")).toHaveLength(1));
      expect(api.callsTo("POST /api/tables/tbl1/views")[0]?.body).toEqual({ name: "Sprint board", type: "kanban", personal: false, config: null });
    });

    it("locks a view from its menu", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", { "PATCH /api/views/viw1": { status: 204 } });
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Options for All tasks" }));
      await user.click(await screen.findByRole("menuitem", { name: "Lock view" }));
      await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
      expect(api.callsTo("PATCH /api/views/viw1")[0]?.body).toEqual({ locked: true });
    });

    it("does not offer locking or sharing for personal views", async () => {
      const user = userEvent.setup();
      openBase("creator");
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Options for My tasks" }));
      expect(await screen.findByRole("menuitem", { name: "Rename view" })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /Lock view/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /Share view/ })).not.toBeInTheDocument();
    });

    it("renames a view from its menu", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", { "PATCH /api/views/viw2": { status: 204 } });
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Options for Board" }));
      await user.click(await screen.findByRole("menuitem", { name: "Rename view" }));
      const dialog = await screen.findByRole("dialog", { name: "Rename view" });
      const name = within(dialog).getByLabelText("Name");
      await user.clear(name);
      await user.type(name, "Stages");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(api.callsTo("PATCH /api/views/viw2")[0]?.body).toEqual({ name: "Stages" }));
    });

    it("renames the project from its menu", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", { "PATCH /api/bases/app1": { status: 204 } });
      await screen.findByText("Grid view coming soon");
      await openProjectMenu(user);
      await user.click(await screen.findByRole("menuitem", { name: "Rename project" }));
      const input = within(await screen.findByRole("dialog", { name: "Rename project" })).getByRole("textbox", { name: "Project name" });
      await user.clear(input);
      await user.type(input, "Renamed{Enter}");
      await waitFor(() => expect(api.callsTo("PATCH /api/bases/app1")).toHaveLength(1));
      expect(api.callsTo("PATCH /api/bases/app1")[0]?.body).toEqual({ name: "Renamed" });
    });

    it("adds a table and opens it", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", {
        "POST /api/bases/app1/tables": { id: "tbl9", base_id: "app1", name: "Projects", description: null, primary_field_id: "f", fields: [], views: [] },
      });
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Add table" }));
      await user.click(await screen.findByRole("menuitem", { name: "New empty table" }));
      await user.type(await screen.findByLabelText("Name"), "Projects");
      await user.click(screen.getByRole("button", { name: "Create table" }));
      await waitFor(() => expect(api.callsTo("POST /api/bases/app1/tables")).toHaveLength(1));
      expect(api.callsTo("POST /api/bases/app1/tables")[0]?.body).toEqual({ name: "Projects" });
    });

    it("cannot delete the last remaining view or table", async () => {
      const user = userEvent.setup();
      const schema = makeSchema("creator");
      schema.tables = [{ ...schema.tables[0]!, views: [schema.tables[0]!.views[0]!] }];
      openBase("creator", { "GET /api/bases/app1": schema });
      await screen.findByText("Grid view coming soon");

      await user.click(screen.getByRole("button", { name: "Options for All tasks" }));
      expect(await screen.findByRole("menuitem", { name: "Delete view" })).toHaveAttribute("aria-disabled", "true");
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "Table options for Tasks" }));
      expect(await screen.findByRole("menuitem", { name: "Delete table" })).toHaveAttribute("aria-disabled", "true");
    });

    it("deletes another table after confirming", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", { "DELETE /api/tables/tbl2": { status: 204 } });
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Table options for People" }));
      await user.click(await screen.findByRole("menuitem", { name: "Delete table" }));
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete table" }));
      await waitFor(() => expect(api.callsTo("DELETE /api/tables/tbl2")).toHaveLength(1));
    });

    it("shares from the top bar: invites, and the view on screen picked under Share a view", async () => {
      const user = userEvent.setup();
      openBase("creator", { "GET /api/views/viw2/shares": [] }, "/base/app1/tbl1/viw2");
      await screen.findByText("Kanban view coming soon");
      await user.click(screen.getByRole("button", { name: "Share" }));
      const dialog = await screen.findByRole("dialog", { name: "Share Project tracker" });
      expect(within(dialog).getByRole("tab", { name: "Invite people" })).toHaveAttribute("aria-selected", "true");
      await user.click(within(dialog).getByRole("tab", { name: "Share a view" }));
      expect(within(dialog).getByLabelText("View")).toHaveValue("viw2");
    });

    it("opens Share on the Share a view tab from a view's menu, with that view picked", async () => {
      const user = userEvent.setup();
      openBase("creator", { "GET /api/views/viw2/shares": [] });
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Options for Board" }));
      await user.click(await screen.findByRole("menuitem", { name: "Share view…" }));
      const dialog = await screen.findByRole("dialog", { name: "Share Project tracker" });
      expect(within(dialog).getByRole("tab", { name: "Share a view" })).toHaveAttribute("aria-selected", "true");
      expect(within(dialog).getByLabelText("View")).toHaveValue("viw2");
    });
  });

  describe("the project's menu and rows", () => {
    it("shows the Inbox to everyone and the project's Trash to creators only", async () => {
      const user = userEvent.setup();
      openBase("viewer", { "GET /api/notifications": { notifications: [], unread: 2 } });
      await screen.findByText("Grid view coming soon");
      expect(await within(menu()).findByRole("button", { name: "Inbox, 2 unread" })).toBeInTheDocument();
      expect(itemNames(await openProjectMenu(user))).not.toContain("Trash");
      await user.keyboard("{Escape}");
      // The Trash of everything is always at the bottom.
      expect(within(menu()).getAllByRole("link", { name: "Trash" }).at(-1)).toHaveAttribute("href", "/trash");
    });

    it("links a creator to the one Trash page, filtered to this project", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", {
        "GET /api/trash": { items: [{ kind: "table", id: "tbl9", name: "Old budget", table_id: null, deleted_at: Date.now() - 86_400_000, expires_at: Date.now() + 29 * 86_400_000, workspace_id: "wsp1", workspace_name: "Acme", workspace_color: "green", base_id: "app1", base_name: "Project tracker" }] },
      });
      await screen.findByText("Grid view coming soon");
      const item = within(await openProjectMenu(user)).getByRole("menuitem", { name: "Trash" });
      expect(item).toHaveAttribute("href", "/trash?base=app1");
      await user.click(item);
      expect(await screen.findByRole("heading", { level: 1, name: "Trash" })).toBeInTheDocument();
      expect(await screen.findByText("Old budget")).toBeInTheDocument();
      expect(api.callsTo("GET /api/trash")[0]!.query.get("base_id")).toBe("app1");
    });

    it("links creators to the automations from the open project's row and menu", async () => {
      const user = userEvent.setup();
      openBase("creator");
      await screen.findByText("Grid view coming soon");
      const link = within(menu()).getByRole("link", { name: "Automations" });
      expect(link).toHaveAttribute("href", "/base/app1/automations");
      expect(link).not.toHaveAttribute("aria-current", "page");
      expect(within(await openProjectMenu(user)).getByRole("menuitem", { name: "Automations" })).toHaveAttribute("href", "/base/app1/automations");
    });
  });

  it("keeps ?record= when it canonicalises a link such as a notification's", async () => {
    openBase("owner", {}, "/base/app1/tbl1?record=rec1");
    expect(await screen.findByTestId("record-param")).toHaveTextContent("rec1");
    expect(screen.getByRole("link", { name: "All tasks" })).toHaveAttribute("aria-current", "page");
  });
});

describe("an empty base", () => {
  beforeEach(() => stubDesktop());
  const empty = (role: string) => makeSchema(role, { tables: [] });

  it("invites a creator to make the first table by name and opens it", async () => {
    const user = userEvent.setup();
    let made = false;
    const withTable = (): BaseSchema => {
      const s = makeSchema("creator");
      return { ...s, tables: [{ ...s.tables[0]!, id: "tbl9", name: "Chores", views: [{ ...s.tables[0]!.views[0]!, id: "viw9", table_id: "tbl9" }] }] };
    };
    const api = openBase("creator", {
      "GET /api/bases/app1": () => (made ? withTable() : empty("creator")),
      "POST /api/bases/app1/tables": () => {
        made = true;
        return withTable().tables[0];
      },
    });
    expect(await screen.findByRole("heading", { name: "Create your first table" })).toBeInTheDocument();
    expect(screen.getByText("A table is one list of things, like your chores or a shopping list. You add the fields you need as you go.")).toBeInTheDocument();
    expect(within(tables()).getByText("No tables yet.")).toBeInTheDocument();
    const create = screen.getByRole("button", { name: "Create table" });
    expect(create).toBeDisabled();
    const name = screen.getByRole("textbox", { name: "Table name" });
    expect(name).toHaveAttribute("placeholder", "For example, Tasks");
    await user.type(name, "Chores");
    await user.click(create);
    await waitFor(() => expect(api.callsTo("POST /api/bases/app1/tables")).toHaveLength(1));
    expect(api.callsTo("POST /api/bases/app1/tables")[0]?.body).toEqual({ name: "Chores" });
    expect(await screen.findByText("Grid view coming soon")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Chores" })).toHaveAttribute("aria-current", "page");
  });

  it("offers a creator a CSV import instead", async () => {
    const user = userEvent.setup();
    openBase("creator", { "GET /api/bases/app1": empty("creator") });
    await user.click(await screen.findByRole("button", { name: "Import a CSV" }));
    expect(await screen.findByRole("dialog", { name: "New table from CSV" })).toBeInTheDocument();
  });

  it.each(["viewer", "editor"])("tells a %s whom to ask", async (role) => {
    openBase(role, { "GET /api/bases/app1": empty(role) });
    expect(await screen.findByText("This base has no tables yet. Ask someone who can create tables to add one.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Create your first table" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Table name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import a CSV" })).not.toBeInTheDocument();
    expect(within(tables()).getByText("No tables yet.")).toBeInTheDocument();
  });
});

describe("base shell on a phone", () => {
  it("keeps the menu in a drawer that closes when a view is chosen", async () => {
    const user = userEvent.setup();
    openBase("owner");
    await screen.findByText("Grid view coming soon");
    expect(screen.queryByRole("list", { name: "Tables in Project tracker" })).not.toBeInTheDocument();
    // Share keeps its name as an icon button.
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show menu" }));
    let drawer = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(within(drawer).getByRole("link", { name: "Board" }));
    expect(await screen.findByText("Kanban view coming soon")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument());

    // Choosing the view already open closes it too, though the address stays the same.
    await user.click(screen.getByRole("button", { name: "Show menu" }));
    drawer = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(within(drawer).getByRole("link", { name: "Board" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument());
  });

  it("names the project in the top bar, where a tap opens the drawer: the Inbox, then the tree", async () => {
    const user = userEvent.setup();
    openBase("owner");
    await screen.findByText("Grid view coming soon");
    // The workspace small over the project's name; not a picker.
    const title = screen.getByRole("heading", { level: 1 });
    expect(title).toHaveTextContent("AcmeProject tracker");
    await user.click(within(title).getByRole("button", { name: "Project tracker in Acme. Open the menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    expect(within(drawer).getByRole("button", { name: "Close menu" })).toBeInTheDocument();
    const nav = within(drawer).getByRole("navigation", { name: "Main menu" });
    expect(within(nav).getAllByRole("button")[0]).toHaveAccessibleName("Inbox");
    expect(within(nav).getByRole("list", { name: "Tables in Project tracker" })).toBeInTheDocument();
    // Folding rows is not navigating: the drawer stays.
    await user.click(within(nav).getByRole("button", { name: "Show views of People" }));
    await user.click(within(nav).getByRole("button", { name: "Collapse Project tracker" }));
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeInTheDocument();
  });

  it("opens a table's dialogs over the drawer", async () => {
    const user = userEvent.setup();
    openBase("creator");
    await screen.findByText("Grid view coming soon");
    await user.click(screen.getByRole("button", { name: "Show menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(within(drawer).getByRole("button", { name: "Table options for People" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename table" }));
    expect(await screen.findByRole("dialog", { name: "Rename table" })).toBeInTheDocument();
  });
});

describe("icons", () => {
  beforeEach(() => stubDesktop());
  const withIcons = (role: string) => {
    const schema = makeSchema(role, { icon: "store" });
    schema.tables[0]!.icon = "truck";
    return schema;
  };
  const icon = (el: HTMLElement | Element | null, name: string) => el?.querySelector(`svg.lucide-${name}`);

  it("shows the base icon in the top bar and a table's own icon left of its name in the menu (none for a plain table)", async () => {
    openBase("viewer", { "GET /api/bases/app1": withIcons("viewer") });
    await screen.findByText("Grid view coming soon");
    const tile = screen.getByRole("heading", { level: 1 }).querySelector("[data-entity-tile]")!;
    expect(icon(tile, "store")).toBeInTheDocument();
    expect(tile).not.toHaveTextContent("P");

    const tasks = screen.getByRole("link", { name: "Tasks" });
    expect(icon(tasks, "truck")).toBeInTheDocument();
    expect(tasks.firstElementChild).toBe(icon(tasks, "truck"));
    const people = screen.getByRole("link", { name: "People" });
    expect(people.querySelector("svg")).toBeNull();
  });

  it("shows the generic base icon in the top bar tile when the base has no icon", async () => {
    openBase("viewer");
    await screen.findByText("Grid view coming soon");
    const tile = screen.getByRole("heading", { level: 1 }).querySelector("[data-entity-tile]");
    expect(tile?.querySelector("svg.lucide-database")).toBeInTheDocument();
    expect(tile).not.toHaveTextContent("P");
  });

  it("lets creators change the project icon from its menu, and remove it", async () => {
    const user = userEvent.setup();
    const api = openBase("creator", {
      "GET /api/bases/app1": withIcons("creator"),
      // The menu's rows (and so the icon dialog) come from the workspaces list.
      "GET /api/workspaces": [makeWorkspace("creator", [{ id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", icon: "store", role: "creator", people: [], tables: [] }])],
      "PATCH /api/bases/app1": { status: 204 },
    });
    await screen.findByText("Grid view coming soon");
    const changeIcon = async () => {
      await openProjectMenu(user);
      await user.click(await screen.findByRole("menuitem", { name: /Change icon/ }));
    };
    await changeIcon();
    const popular = await screen.findByRole("group", { name: "Popular icons" });
    expect(within(popular).getAllByRole("button")).toHaveLength(20);
    await user.click(within(popular).getByRole("button", { name: "Star" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/bases/app1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/bases/app1")[0]?.body).toEqual({ icon: "star" });

    // removing it sends null, which the server reads as "clear"
    await changeIcon();
    await user.click(await screen.findByRole("button", { name: "Remove icon" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/bases/app1")).toHaveLength(2));
    expect(api.callsTo("PATCH /api/bases/app1")[1]?.body).toEqual({ icon: null });
  });

  it("gives editors no way to change the project or a table icon (they cannot rename either)", async () => {
    const user = userEvent.setup();
    openBase("editor", { "GET /api/bases/app1": withIcons("editor") });
    await screen.findByText("Grid view coming soon");
    const projectMenu = await openProjectMenu(user);
    expect(within(projectMenu).queryByRole("menuitem", { name: /Change icon/ })).not.toBeInTheDocument();
    expect(within(projectMenu).queryByRole("menuitem", { name: "Rename project" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Table options for Tasks" }));
    expect(await screen.findByRole("menuitem", { name: /Import CSV/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Change icon/ })).not.toBeInTheDocument();
  });

  it("gives viewers the icons but no picker", async () => {
    openBase("viewer", { "GET /api/bases/app1": withIcons("viewer") });
    await screen.findByText("Grid view coming soon");
    expect(screen.queryByRole("button", { name: /Table options/ })).not.toBeInTheDocument();
    expect(document.querySelector("header [data-entity-tile] svg.lucide-store")).toBeInTheDocument();
  });

  it("changes a table's icon from its menu", async () => {
    const user = userEvent.setup();
    const api = openBase("creator", { "GET /api/bases/app1": withIcons("creator"), "PATCH /api/tables/tbl1": { status: 204 } });
    await screen.findByText("Grid view coming soon");
    await user.click(screen.getByRole("button", { name: "Table options for Tasks" }));
    await user.click(await screen.findByRole("menuitem", { name: /Change icon/ }));
    const dialog = await screen.findByRole("dialog", { name: "Table icon" });
    expect(await within(dialog).findByRole("button", { name: "Truck" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(dialog).getByRole("button", { name: "Wrench" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/tables/tbl1")[0]?.body).toEqual({ icon: "wrench" });
  });

  it("creates a table with an icon chosen in the dialog", async () => {
    const user = userEvent.setup();
    const api = openBase("creator", {
      "POST /api/bases/app1/tables": { id: "tbl9", base_id: "app1", name: "Orders", icon: "package", description: null, primary_field_id: "f", fields: [], views: [] },
    });
    await screen.findByText("Grid view coming soon");
    await user.click(screen.getByRole("button", { name: "Add table" }));
    await user.click(await screen.findByRole("menuitem", { name: "New empty table" }));
    const dialog = await screen.findByRole("dialog", { name: "New table" });
    await user.type(within(dialog).getByLabelText("Name"), "Orders");
    await user.click(within(dialog).getByRole("button", { name: "Choose icon" }));
    await user.click(await screen.findByRole("button", { name: "Package" }));
    // the picker closes and the dialog now shows the chosen icon
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Change icon" })).toBeInTheDocument());
    await user.click(within(dialog).getByRole("button", { name: "Create table" }));
    await waitFor(() => expect(api.callsTo("POST /api/bases/app1/tables")).toHaveLength(1));
    expect(api.callsTo("POST /api/bases/app1/tables")[0]?.body).toEqual({ name: "Orders", icon: "package" });
  });

  it("renames a table without sending its icon when the icon was not touched", async () => {
    const user = userEvent.setup();
    const api = openBase("creator", { "GET /api/bases/app1": withIcons("creator"), "PATCH /api/tables/tbl1": { status: 204 } });
    await screen.findByText("Grid view coming soon");
    await user.click(screen.getByRole("button", { name: "Table options for Tasks" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename table" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename table" });
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Jobs");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/tables/tbl1")[0]?.body).toEqual({ name: "Jobs" });
  });

  it("removes a table's icon from the rename dialog by sending null", async () => {
    const user = userEvent.setup();
    const api = openBase("creator", { "GET /api/bases/app1": withIcons("creator"), "PATCH /api/tables/tbl1": { status: 204 } });
    await screen.findByText("Grid view coming soon");
    await user.click(screen.getByRole("button", { name: "Table options for Tasks" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename table" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename table" });
    await user.click(within(dialog).getByRole("button", { name: "Change icon" }));
    await user.click(await screen.findByRole("button", { name: "Remove icon" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/tables/tbl1")[0]?.body).toEqual({ name: "Tasks", icon: null });
  });
});
