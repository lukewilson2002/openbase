import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BasePerson, BaseSchema } from "@/api/types";
import { SIDEBAR_KEY } from "@/shell/sidebarPrefs";
import { USER, apiError, makeSchema, makeWorkspace, mockApi, renderApp, stubDesktop } from "@/test/utils";

// These tests are about the shell (menu, top bar, permissions). The real grid draws on a canvas
// and has its own tests under src/views/grid, so the shell tests render the placeholder for it,
// with the toolbar's view switcher above it (the real views draw it in their toolbar).
vi.mock("@/views/grid/GridView", async () => {
  const { PlaceholderView } = await import("@/views/PlaceholderView");
  const { ViewSwitcher } = await import("@/components/viewbar/ViewSwitcher");
  const { useSearchParams } = await import("react-router");
  // Shows the ?record= parameter so tests can see whether the shell's redirects keep it.
  function Stub(props: Parameters<typeof PlaceholderView>[0]) {
    const [params] = useSearchParams();
    return (
      <>
        <ViewSwitcher schema={props.schema} table={props.table} view={props.view} />
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
  const { ViewSwitcher } = await import("@/components/viewbar/ViewSwitcher");
  function Stub(props: Parameters<typeof PlaceholderView>[0]) {
    return (
      <>
        <ViewSwitcher schema={props.schema} table={props.table} view={props.view} />
        <PlaceholderView {...props} />
      </>
    );
  }
  return { default: Stub };
});

afterEach(() => vi.unstubAllGlobals());

/** A collection as the workspaces list summarises it, which is what the sidebar draws its rows from. */
const summary = (t: BaseSchema["tables"][number]) => ({ id: t.id, name: t.name, color: t.color, record_count: t.record_count, body_field_id: null, home_date_field_id: null, done_field_id: null, record_noun: "" });

function openBase(role: string, extra: Record<string, unknown> = {}, route = "/base/app1") {
  // The folder's collections in the sidebar follow the schema the test serves.
  const served = extra["GET /api/bases/app1"] ?? makeSchema(role);
  const schemaNow = () => (typeof served === "function" ? (served as () => BaseSchema)() : (served as BaseSchema));
  const api = mockApi({
    "GET /api/auth/me": USER,
    "GET /api/bases/app1": makeSchema(role),
    "GET /api/workspaces": () => [makeWorkspace(role, [{ id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", role, is_top_level: false, people: [], tables: schemaNow().tables.map(summary) }])],
    "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false, public_url: "https://base.example.org", passkeys_enabled: true },
    ...extra,
  });
  renderApp({ route });
  return api;
}

const menu = () => screen.getByRole("navigation", { name: "Main menu" });
const tables = () => screen.getByRole("list", { name: "Collections in Project tracker" });
const tasksLink = () => within(tables()).getByRole("link", { name: /^Tasks/ });
/** The sidebar's "…" for the open folder. */
const openFolderMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("button", { name: "Folder options for Project tracker" }));
  return screen.findByRole("menu");
};
const itemNames = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim());

/** Opens the list of the open table's views, from the toolbar's button naming the open view. */
async function openViews(user: ReturnType<typeof userEvent.setup>, open = "All tasks", table = "Tasks") {
  await user.click(screen.getByRole("button", { name: `View: ${open}` }));
  return screen.findByRole("menu", { name: `Views of ${table}` });
}

/** Opens the submenu of a view type's views, from its row in the list (the views of one type share a row). */
async function openType(user: ReturnType<typeof userEvent.setup>, list: HTMLElement, type: string) {
  within(list).getByRole("menuitem", { name: new RegExp(`^${type} views`) }).focus();
  await user.keyboard("{ArrowRight}");
  return screen.findByRole("menu", { name: `${type} views` });
}

/** Opens a view's options with a right-click on it in the list. */
async function openViewOptions(list: HTMLElement, view: string | RegExp, name: string) {
  fireEvent.contextMenu(within(list).getByRole("menuitem", { name: view }), { clientX: 60, clientY: 80 });
  return screen.findByRole("menu", { name: `Options for ${name}` });
}

/** Opens the "Add view" menu of the open table: at the end of the toolbar's list of views. */
async function openAddView(user: ReturnType<typeof userEvent.setup>) {
  const list = await openViews(user);
  within(list).getByRole("menuitem", { name: "Add view" }).focus();
  await user.keyboard("{ArrowRight}");
  return screen.findByRole("menu", { name: "Add view" });
}

/** Chooses an item of a submenu, as the keyboard does (jsdom gives Radix's submenus no pointer). */
async function pick(user: ReturnType<typeof userEvent.setup>, name: string | RegExp) {
  const item = await screen.findByRole("menuitem", { name });
  item.focus();
  await user.keyboard("{Enter}");
}

/** Chooses an item of the open folder's "…" menu. */
async function chooseInFolderMenu(user: ReturnType<typeof userEvent.setup>, name: string | RegExp) {
  await openFolderMenu(user);
  await user.click(await screen.findByRole("menuitem", { name }));
}

describe("base shell on a desktop", () => {
  beforeEach(() => stubDesktop());

  it("canonicalises the URL and renders the first view through the registry", async () => {
    const user = userEvent.setup();
    openBase("owner");
    expect(await screen.findByText("Grid view coming soon")).toBeInTheDocument();
    expect(tasksLink()).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("main", { name: "All tasks" })).toBeInTheDocument();
    // The open view is the toolbar's, not the sidebar's.
    const list = await openViews(user);
    expect(within(await openType(user, list, "Grid")).getByRole("menuitem", { name: "All tasks" })).toHaveAttribute("aria-current", "page");
  });

  it("puts the collection in the app shell: no top bar, its own header inside main, then Home and Notifications above the collections in the sidebar", async () => {
    openBase("viewer");
    await screen.findByText("Grid view coming soon");
    // NAV-5: nothing spans the app; the header belongs to the screen and sits in its `main`.
    expect([...document.querySelectorAll("header")].every((h) => h.closest("main"))).toBe(true);
    const main = screen.getByRole("main", { name: "All tasks" });
    const header = main.querySelector("header")!;
    expect(header).not.toBeNull();
    // The workspace as the path (this project is a folder), and the collection's name as the screen's one h1.
    expect(within(header).getByText("Acme / Project tracker")).toBeInTheDocument();
    expect(within(header).getByRole("heading", { name: "Tasks", level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(within(header).queryByRole("button", { name: /Acme|Project tracker/ })).not.toBeInTheDocument();
    // A viewer can neither invite nor share a view, so there is no Share to open.
    expect(within(header).queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Search everything" })).toBeInTheDocument();
    expect(within(menu()).getAllByRole("link")[0]).toHaveAccessibleName("Home");
    expect(within(menu()).queryByRole("link", { name: "Inbox" })).not.toBeInTheDocument();
    expect(within(menu()).getByRole("button", { name: "Notifications" })).toBeInTheDocument();
    // The Automations row is for creators.
    expect(within(menu()).queryByRole("link", { name: "Automations" })).not.toBeInTheDocument();
    expect(await within(menu()).findByRole("button", { name: "Account menu" })).toBeInTheDocument();
    // The workspace in the switcher, the folder under Collections, and its collections.
    expect(within(menu()).getByRole("button", { name: /^Acme/ })).toBeInTheDocument();
    expect(await within(menu()).findByRole("button", { name: "Project tracker" })).toHaveAttribute("aria-expanded", "true");
    expect(within(tables()).getByRole("link", { name: /^Tasks/ })).toBeInTheDocument();
    expect(within(menu()).queryByRole("link", { name: "Members" })).not.toBeInTheDocument();
  });

  it("names the top level's collection under the workspace alone, and a creator sees Share in the header", async () => {
    const user = userEvent.setup();
    openBase("owner", { "GET /api/bases/app1": makeSchema("owner", { is_top_level: true }) });
    await screen.findByText("Grid view coming soon");
    const header = screen.getByRole("main", { name: "All tasks" }).querySelector("header")!;
    expect(within(header).getByText("Acme")).toBeInTheDocument();
    expect(within(header).queryByText("Acme / Project tracker")).not.toBeInTheDocument();
    await user.click(within(header).getByRole("button", { name: "Share" }));
    expect(await screen.findByRole("dialog", { name: /Share/ })).toBeInTheDocument();
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
    await user.click(within(await openViews(user)).getByRole("menuitem", { name: "Board" }));
    expect(await screen.findByText("Kanban view coming soon")).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Board" })).toBeInTheDocument();
    expect(within(await openViews(user, "Board")).getByRole("menuitem", { name: "Board" })).toHaveAttribute("aria-current", "page");
  });

  it("switches tables, opening the other table's first view", async () => {
    const user = userEvent.setup();
    openBase("owner");
    await screen.findByText("Grid view coming soon");
    await user.click(within(tables()).getByRole("link", { name: /^People/ }));
    expect(await screen.findByRole("main", { name: "Everyone" })).toBeInTheDocument();
    expect(within(tables()).getByRole("link", { name: /^People/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "View: Everyone" })).toBeInTheDocument();
    // The sidebar lists no views, of this collection or of any other.
    expect(within(menu()).queryByRole("link", { name: "Everyone" })).not.toBeInTheDocument();
    expect(within(menu()).queryByRole("link", { name: "All tasks" })).not.toBeInTheDocument();
  });

  it("opens the view last used in a collection when its row is tapped, and remembers each view it shows", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ob-last-place", JSON.stringify({ tables: { tbl1: "viw2" }, projects: {}, workspaces: {} }));
    openBase("owner", {}, "/base/app1/tbl2/viw4");
    await screen.findByText("Grid view coming soon");
    expect(JSON.parse(localStorage.getItem("ob-last-place")!)).toEqual({ tables: { tbl1: "viw2", tbl2: "viw4" }, projects: { app1: "tbl2" }, workspaces: { wsp1: "app1" } });
    await user.click(tasksLink());
    expect(await screen.findByText("Kanban view coming soon")).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Board" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View: Board" })).toBeInTheDocument();
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

  it("lists collections only in the sidebar: no views under a collection", async () => {
    const user = userEvent.setup();
    openBase("creator");
    await screen.findByText("Grid view coming soon");
    expect(screen.queryByRole("button", { name: /^(Show|Hide) views of/ })).not.toBeInTheDocument();
    expect(within(tables()).getAllByRole("link").map((a) => a.textContent)).toEqual(["Tasks0", "People0"]);
    expect(within(menu()).queryByRole("list", { name: /^(Shared|Personal) views$/ })).not.toBeInTheDocument();
    expect(within(menu()).queryByRole("button", { name: /^Options for/ })).not.toBeInTheDocument();
    // The views are in the toolbar's list instead.
    expect(within(await openViews(user)).getByRole("menuitem", { name: "Board" })).toBeInTheDocument();
  });

  it("marks the open collection's row with its color, in the selected style, and no icon", async () => {
    openBase("owner");
    await screen.findByText("Grid view coming soon");
    const tasks = tasksLink();
    expect(tasks).toHaveClass("bg-primary-soft", "font-semibold");
    expect(tasks.querySelector(".ob-mark")).toHaveClass("ob-solid");
    expect(tasks.querySelector("svg")).toBeNull();
    const people = within(tables()).getByRole("link", { name: /^People/ });
    expect(people).not.toHaveClass("bg-primary-soft");
    expect(people).not.toHaveAttribute("aria-current");
  });

  it("marks personal views as personal in the list of views", async () => {
    const user = userEvent.setup();
    openBase("editor");
    await screen.findByText("Grid view coming soon");
    const grids = await openType(user, await openViews(user), "Grid");
    expect(within(within(grids).getByRole("menuitem", { name: /My tasks/ })).getByRole("img", { name: "Personal view" })).toBeInTheDocument();
    expect(within(within(grids).getByRole("menuitem", { name: /All tasks/ })).queryByRole("img", { name: "Personal view" })).not.toBeInTheDocument();
  });

  it("collapses the sidebar with the corner toggle and remembers it", async () => {
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
      const user = userEvent.setup();
      openBase("viewer");
      await screen.findByText("Grid view coming soon");
      // The browser's own menu stays on the views: there is nothing to do with one, nor an Add view.
      expect(fireEvent.contextMenu(screen.getByRole("button", { name: "View: All tasks" }))).toBe(true);
      const list = await openViews(user);
      expect(fireEvent.contextMenu(within(list).getByRole("menuitem", { name: "Board" }))).toBe(true);
      expect(screen.queryByRole("menu", { name: /^Options for/ })).not.toBeInTheDocument();
      expect(within(list).queryByRole("menuitem", { name: "Add view" })).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
      // A collection has no menu for a viewer: nothing in it is theirs to change.
      expect(screen.queryByRole("button", { name: /^Collection options for/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Automations" })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Tasks", level: 1 })).toBeInTheDocument();
    });

    it("has no Share (nothing to invite or share) but still finds who has access", async () => {
      const user = userEvent.setup();
      openBase("viewer");
      await screen.findByText("Grid view coming soon");
      expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
      const folderMenu = await openFolderMenu(user);
      expect(itemNames(folderMenu)).toEqual(["Access"]);
      expect(within(folderMenu).getByRole("menuitem", { name: "Access" })).toHaveAttribute("href", "/workspace/wsp1/members");
    });
  });

  describe("editor", () => {
    it("can create personal views only and cannot change tables or shared views", async () => {
      const user = userEvent.setup();
      const api = openBase("editor", {
        "POST /api/tables/tbl1/views": (call: { body: unknown }) => ({ id: "viw9", table_id: "tbl1", name: (call.body as { name: string }).name, type: "calendar", personal: true, locked: false, config: {} }),
      });
      await screen.findByText("Grid view coming soon");
      expect(screen.queryByTitle("Rename project")).not.toBeInTheDocument();
      // Shared views are creator territory; the editor's own personal view is manageable.
      expect(fireEvent.contextMenu(screen.getByRole("button", { name: "View: All tasks" }))).toBe(true);
      expect(screen.queryByRole("menu", { name: "Options for All tasks" })).not.toBeInTheDocument();
      const list = await openViews(user);
      const mine = await openViewOptions(await openType(user, list, "Grid"), /My tasks/, "My tasks");
      expect(within(mine).getByRole("menuitem", { name: "Rename view" })).toBeInTheDocument();
      await user.keyboard("{Escape}{Escape}{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

      const types = await openAddView(user);
      expect(within(types).getByText(/Editors can create personal views/)).toBeInTheDocument();
      expect(within(types).getByRole("menuitem", { name: /^Calendar/ })).toBeInTheDocument();
      await pick(user, /^Calendar/);
      const dialog = await screen.findByRole("dialog", { name: "New calendar view" });
      expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
      expect(within(dialog).getByLabelText("Name")).toHaveValue("Calendar");
      await user.click(within(dialog).getByRole("button", { name: "Create view" }));
      await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/views")).toHaveLength(1));
      expect(api.callsTo("POST /api/tables/tbl1/views")[0]?.body).toEqual({ name: "Calendar", type: "calendar", personal: true, config: null });
    });

    it("has no Automations in the folder's menu, but Access", async () => {
      const user = userEvent.setup();
      openBase("editor");
      await screen.findByText("Grid view coming soon");
      expect(screen.queryByRole("link", { name: "Automations" })).not.toBeInTheDocument();
      expect(itemNames(await openFolderMenu(user))).toEqual(["Access"]);
    });
  });

  describe("importing CSV", () => {
    it("lets editors import into a collection but not rename, duplicate or delete it", async () => {
      const user = userEvent.setup();
      openBase("editor");
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Collection options for Tasks" }));
      expect(itemNames(await screen.findByRole("menu"))).toEqual(["Import CSV"]);
      await user.click(screen.getByRole("menuitem", { name: /Import CSV/ }));
      expect(await screen.findByRole("dialog", { name: "Import CSV into Tasks" })).toBeInTheDocument();
    });

    it("keeps viewers and commenters out of it", async () => {
      openBase("commenter");
      await screen.findByText("Grid view coming soon");
      expect(screen.queryByRole("button", { name: /^Collection options for/ })).not.toBeInTheDocument();
    });

    it("offers creators a new collection from CSV next to the empty one", async () => {
      const user = userEvent.setup();
      openBase("creator");
      await screen.findByText("Grid view coming soon");
      await openFolderMenu(user);
      expect(await screen.findByRole("menuitem", { name: "New collection" })).toBeInTheDocument();
      await user.click(screen.getByRole("menuitem", { name: "New collection from CSV" }));
      expect(await screen.findByRole("dialog", { name: "New table from CSV" })).toBeInTheDocument();
    });
  });

  describe("creator", () => {
    it("can manage collections, rename the folder and create each of the seven view types", async () => {
      const user = userEvent.setup();
      openBase("creator");
      await screen.findByText("Grid view coming soon");
      expect(screen.getByRole("button", { name: "Collection options for Tasks" })).toBeInTheDocument();
      // Every collection has its menu, not only the open one.
      expect(screen.getByRole("button", { name: "Collection options for People" })).toBeInTheDocument();
      fireEvent.contextMenu(screen.getByRole("button", { name: "View: All tasks" }));
      expect(await screen.findByRole("menu", { name: "Options for All tasks" })).toBeInTheDocument();
      await user.keyboard("{Escape}");
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
      await openAddView(user);
      await pick(user, /^Kanban/);
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
      fireEvent.contextMenu(screen.getByRole("button", { name: "View: All tasks" }));
      await user.click(await screen.findByRole("menuitem", { name: "Lock view" }));
      await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
      expect(api.callsTo("PATCH /api/views/viw1")[0]?.body).toEqual({ locked: true });
    });

    it("does not offer locking or sharing for personal views", async () => {
      const user = userEvent.setup();
      openBase("creator");
      await screen.findByText("Grid view coming soon");
      await openViewOptions(await openType(user, await openViews(user), "Grid"), /My tasks/, "My tasks");
      expect(await screen.findByRole("menuitem", { name: "Rename view" })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /Lock view/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /Share view/ })).not.toBeInTheDocument();
    });

    it("renames a view from its menu", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", { "PATCH /api/views/viw2": { status: 204 } });
      await screen.findByText("Grid view coming soon");
      await openViewOptions(await openViews(user), "Board", "Board");
      await user.click(await screen.findByRole("menuitem", { name: "Rename view" }));
      const dialog = await screen.findByRole("dialog", { name: "Rename view" });
      const name = within(dialog).getByLabelText("Name");
      await user.clear(name);
      await user.type(name, "Stages");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(api.callsTo("PATCH /api/views/viw2")[0]?.body).toEqual({ name: "Stages" }));
    });

    it("renames the folder from its menu", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", { "PATCH /api/bases/app1": { status: 204 } });
      await screen.findByText("Grid view coming soon");
      await chooseInFolderMenu(user, "Rename");
      const input = within(await screen.findByRole("dialog", { name: "Rename folder" })).getByRole("textbox", { name: "Folder name" });
      await user.clear(input);
      await user.type(input, "Renamed{Enter}");
      await waitFor(() => expect(api.callsTo("PATCH /api/bases/app1")).toHaveLength(1));
      expect(api.callsTo("PATCH /api/bases/app1")[0]?.body).toEqual({ name: "Renamed" });
    });

    it("adds a collection and opens it", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", {
        "POST /api/bases/app1/tables": { id: "tbl9", base_id: "app1", name: "Projects", description: null, primary_field_id: "f", fields: [], views: [] },
      });
      await screen.findByText("Grid view coming soon");
      await chooseInFolderMenu(user, "New collection");
      await user.type(await screen.findByLabelText("Collection name"), "Projects");
      await user.click(screen.getByRole("button", { name: "Create collection" }));
      await waitFor(() => expect(api.callsTo("POST /api/bases/app1/tables")).toHaveLength(1));
      expect(api.callsTo("POST /api/bases/app1/tables")[0]?.body).toEqual({ name: "Projects" });
    });

    it("lists the default grid first in the view list, and a collection's row opens the view last used", async () => {
      const user = userEvent.setup();
      const schema = makeSchema("creator");
      const t = schema.tables[0]!;
      schema.tables[0] = { ...t, views: [{ ...t.views[0]!, id: "viwD", name: "Default grid", is_default: true }, ...t.views] };
      openBase("creator", { "GET /api/bases/app1": schema });
      await screen.findByText("Grid view coming soon");
      // A row names no view: BaseShell picks the one last used (else the first), so the row never links to one that is gone.
      await waitFor(() => expect(tasksLink()).toHaveAttribute("href", "/base/app1/tbl1"));
      expect(within(menu()).queryByRole("link", { name: /Default grid/ })).toBeNull();
      const list = await openViews(user);
      expect(within(list).getAllByRole("menuitem")[0]).toHaveAccessibleName("Default grid");
      expect(within(list).getAllByRole("menuitem")[0]).toHaveAttribute("href", "/base/app1/tbl1/viwD");
    });

    it("can delete the last view (the default grid stays), but not the last collection", async () => {
      const user = userEvent.setup();
      const schema = makeSchema("creator");
      schema.tables = [{ ...schema.tables[0]!, views: [schema.tables[0]!.views[0]!] }];
      openBase("creator", { "GET /api/bases/app1": schema });
      await screen.findByText("Grid view coming soon");

      fireEvent.contextMenu(screen.getByRole("button", { name: "View: All tasks" }));
      expect(await screen.findByRole("menuitem", { name: "Delete view" })).not.toHaveAttribute("aria-disabled");
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "Collection options for Tasks" }));
      expect(await screen.findByRole("menuitem", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");
    });

    it("deletes another collection after confirming", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", { "DELETE /api/tables/tbl2": { status: 204 } });
      await screen.findByText("Grid view coming soon");
      await user.click(screen.getByRole("button", { name: "Collection options for People" }));
      await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete collection" }));
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
      await openViewOptions(await openViews(user), "Board", "Board");
      await user.click(await screen.findByRole("menuitem", { name: "Share view…" }));
      const dialog = await screen.findByRole("dialog", { name: "Share Project tracker" });
      expect(within(dialog).getByRole("tab", { name: "Share a view" })).toHaveAttribute("aria-selected", "true");
      expect(within(dialog).getByLabelText("View")).toHaveValue("viw2");
    });
  });

  describe("the sidebar's rows and the folder's menu", () => {
    it("shows Notifications to everyone, and History and Trash filtered to the workspace", async () => {
      openBase("viewer", { "GET /api/notifications": { notifications: [], unread: 2 } });
      await screen.findByText("Grid view coming soon");
      expect(await within(menu()).findByRole("button", { name: "Notifications, 2 unread" })).toBeInTheDocument();
      expect(within(menu()).getByRole("link", { name: "History" })).toHaveAttribute("href", "/history?workspace=wsp1");
      expect(within(menu()).getByRole("link", { name: "Trash" })).toHaveAttribute("href", "/trash?workspace=wsp1");
    });

    it("links to the Trash page filtered to this workspace", async () => {
      const user = userEvent.setup();
      const api = openBase("creator", {
        "GET /api/trash": { items: [{ kind: "table", id: "tbl9", name: "Old budget", table_id: null, deleted_at: Date.now() - 86_400_000, expires_at: Date.now() + 29 * 86_400_000, workspace_id: "wsp1", workspace_name: "Acme", workspace_color: "green", base_id: "app1", base_name: "Project tracker" }] },
      });
      await screen.findByText("Grid view coming soon");
      await user.click(within(menu()).getByRole("link", { name: "Trash" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Trash" })).toBeInTheDocument();
      expect(await screen.findByText("Old budget")).toBeInTheDocument();
      expect(api.callsTo("GET /api/trash")[0]!.query.get("workspace_id")).toBe("wsp1");
    });

    it("links creators to the folder's automations from its menu, and to the workspace's list from the Automations row", async () => {
      const user = userEvent.setup();
      openBase("creator");
      await screen.findByText("Grid view coming soon");
      expect(within(menu()).getByRole("link", { name: "Automations" })).toHaveAttribute("href", "/workspace/wsp1/automations");
      expect(within(await openFolderMenu(user)).getByRole("menuitem", { name: "Automations" })).toHaveAttribute("href", "/base/app1/automations");
    });

    it("opens the folder's menu with a right-click on its row", async () => {
      openBase("creator");
      await screen.findByText("Grid view coming soon");
      const name = await within(menu()).findByRole("button", { name: "Project tracker" });
      // Not the browser's own menu.
      expect(fireEvent.contextMenu(name)).toBe(false);
      const options = await screen.findByRole("menu");
      expect(within(options).getByRole("menuitem", { name: "Automations" })).toHaveAttribute("href", "/base/app1/automations");
      expect(within(options).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    });
  });

  it("keeps ?record= when it canonicalises a link such as a notification's", async () => {
    openBase("owner", {}, "/base/app1/tbl1?record=rec1");
    expect(await screen.findByTestId("record-param")).toHaveTextContent("rec1");
    expect(screen.getByRole("main", { name: "All tasks" })).toBeInTheDocument();
    expect(tasksLink()).toHaveAttribute("aria-current", "page");
  });
});

describe("an empty base", () => {
  beforeEach(() => stubDesktop());
  const empty = (role: string) => makeSchema(role, { tables: [] });

  it("invites a creator to make the first collection and opens it", async () => {
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
    expect(await screen.findByRole("heading", { name: "No collections in Project tracker yet" })).toBeInTheDocument();
    expect(screen.getByText("A collection is one list of things, like your chores or a shopping list. You add the properties you need as you go.")).toBeInTheDocument();
    expect(within(tables()).getByText("No collections yet.")).toBeInTheDocument();
    // The header names the folder while it holds nothing.
    expect(screen.getByRole("heading", { name: "Project tracker", level: 1 })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New collection" }));
    const dialog = await screen.findByRole("dialog", { name: "New collection" });
    await user.type(within(dialog).getByLabelText("Collection name"), "Chores");
    await user.click(within(dialog).getByRole("button", { name: "Create collection" }));
    await waitFor(() => expect(api.callsTo("POST /api/bases/app1/tables")).toHaveLength(1));
    expect(api.callsTo("POST /api/bases/app1/tables")[0]?.body).toEqual({ name: "Chores" });
    expect(await screen.findByText("Grid view coming soon")).toBeInTheDocument();
    expect(within(tables()).getByRole("link", { name: /^Chores/ })).toHaveAttribute("aria-current", "page");
  });

  it("offers a creator a CSV import instead", async () => {
    const user = userEvent.setup();
    openBase("creator", { "GET /api/bases/app1": empty("creator") });
    await user.click(await screen.findByRole("button", { name: "Import CSV" }));
    expect(await screen.findByRole("dialog", { name: "New table from CSV" })).toBeInTheDocument();
  });

  it.each(["viewer", "editor"])("tells a %s whom to ask", async (role) => {
    openBase(role, { "GET /api/bases/app1": empty(role) });
    expect(await screen.findByText("Ask someone who can create collections to add one.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New collection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import CSV" })).not.toBeInTheDocument();
    expect(within(tables()).getByText("No collections yet.")).toBeInTheDocument();
  });
});

describe("base shell on a phone", () => {
  it("keeps the menu in a drawer that closes when a collection is chosen", async () => {
    const user = userEvent.setup();
    openBase("owner");
    await screen.findByText("Grid view coming soon");
    expect(screen.queryByRole("list", { name: "Collections in Project tracker" })).not.toBeInTheDocument();
    // Share keeps its name as an icon button.
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show menu" }));
    let drawer = await screen.findByRole("dialog", { name: "Menu" });
    // Opening a collection closes the drawer; it opens the view last used in it.
    await user.click(await within(drawer).findByRole("link", { name: /^People/ }));
    expect(await screen.findByRole("main", { name: "Everyone" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument());

    // Choosing the collection already open closes it too, though the address stays the same.
    await user.click(screen.getByRole("button", { name: "Show menu" }));
    drawer = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(await within(drawer).findByRole("link", { name: /^People/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument());
  });

  it("names the collection in its own header, whose toggle opens the drawer: Home and Notifications, then the collections", async () => {
    const user = userEvent.setup();
    openBase("owner");
    await screen.findByText("Grid view coming soon");
    // The workspace and folder small over the open collection's name; not a picker.
    const header = screen.getByRole("main", { name: "All tasks" }).querySelector("header")!;
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tasks");
    expect(within(header).getByText("Acme / Project tracker")).toBeInTheDocument();
    await user.click(within(header).getByRole("button", { name: "Show menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    expect(within(drawer).getByRole("button", { name: "Close menu" })).toBeInTheDocument();
    const nav = within(drawer).getByRole("navigation", { name: "Main menu" });
    expect(within(nav).getAllByRole("link")[0]).toHaveAccessibleName("Home");
    expect(within(nav).getByRole("button", { name: "Notifications" })).toBeInTheDocument();
    expect(await within(nav).findByRole("list", { name: "Collections in Project tracker" })).toBeInTheDocument();
    // Folding a folder is not navigating: the drawer stays.
    await user.click(within(nav).getByRole("button", { name: "Project tracker" }));
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeInTheDocument();
  });

  it("opens a collection's dialogs over the drawer", async () => {
    const user = userEvent.setup();
    openBase("creator");
    await screen.findByText("Grid view coming soon");
    await user.click(screen.getByRole("button", { name: "Show menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(await within(drawer).findByRole("button", { name: "Collection options for People" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    expect(await screen.findByRole("dialog", { name: "Rename collection" })).toBeInTheDocument();
  });
});
