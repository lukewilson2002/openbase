/** The sidebar (NAV-1 to NAV-4, NAV-6, NAV-10): its structure, rows, menus per role, folding, reordering and refresh. */
import { Route, Routes, useLocation } from "react-router";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaseSummary, TableSummary, WorkspaceSummary } from "@/api/types";
import { IntroProvider } from "@/onboarding/IntroContext";
import { USER, apiError, makeSchema, mockApi, renderWithProviders, stubDesktop, type Handler } from "@/test/utils";
import { AppShell } from "./AppShell";
import { FOLDERS_OPEN_KEY } from "./NavTree";
import { NavDialogsProvider } from "./NavDialogs";
import { ScreenHeader } from "./ScreenHeader";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const table = (id: string, name: string, color: string, record_count: number): TableSummary => ({ id, name, color, record_count, body_field_id: null, home_date_field_id: null, done_field_id: null, record_noun: "" });
const base = (id: string, workspace_id: string, name: string, role: string, over: Partial<BaseSummary> = {}): BaseSummary => ({ id, workspace_id, name, color: "blue", icon: null, role, people: [], tables: [], is_top_level: false, ...over });

const acme = (role = "owner"): WorkspaceSummary => ({
  id: "wsp1",
  name: "Acme",
  color: "green",
  icon: null,
  role,
  root_base_id: "app0",
  member_count: 2,
  pending_invite_count: 0,
  bases: [
    base("app0", "wsp1", "Acme", role, { is_top_level: true, tables: [table("tbl1", "Tasks", "orange", 12), table("tbl2", "People", "pink", 1234)] }),
    base("app1", "wsp1", "Chores", role, { color: "teal", tables: [table("tbl3", "Dishes", "cyan", 3), table("tbl4", "Laundry", "red", 0)] }),
    base("app2", "wsp1", "CRM", role, { color: "purple", tables: [] }),
  ],
});
const club = (): WorkspaceSummary => ({
  id: "wsp2",
  name: "Book club",
  color: "purple",
  icon: null,
  role: "editor",
  root_base_id: "app5",
  member_count: 3,
  pending_invite_count: 0,
  bases: [base("app5", "wsp2", "Book club", "editor", { is_top_level: true, tables: [table("tbl9", "Reading list", "blue", 7)] })],
});

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}
const where = () => screen.getByTestId("where").textContent;

interface Options {
  workspaces?: Handler;
  route?: string;
  workspaceId?: string;
  tableId?: string;
  extra?: Record<string, Handler>;
}

function render({ workspaces = [acme(), club()], route = "/workspace/wsp1", workspaceId = "wsp1", tableId, extra = {} }: Options = {}) {
  stubDesktop();
  const api = mockApi({
    "GET /api/auth/me": USER,
    "GET /api/notifications": { notifications: [], unread: 0 },
    "GET /api/workspaces": workspaces,
    "GET /api/search": { results: [] },
    ...extra,
  });
  renderWithProviders(
    <IntroProvider>
      <Routes>
        <Route
          path="*"
          element={
            <NavDialogsProvider>
              <AppShell workspaceId={workspaceId} tableId={tableId}>
                <ScreenHeader title="Page title" />
                <Where />
              </AppShell>
            </NavDialogsProvider>
          }
        />
      </Routes>
    </IntroProvider>,
    route,
  );
  return api;
}

const menu = () => screen.getByRole("navigation", { name: "Main menu" });
const names = (el: HTMLElement) => within(el).getAllByRole("menuitem").map((i) => i.textContent?.trim());
const topLevel = () => within(menu()).findByRole("list", { name: "Collections" });

describe("structure", () => {
  it("is the nav landmark, top to bottom: switcher, search, Home, Notifications, Automations, Collections, footer", async () => {
    render();
    const nav = menu();
    expect(nav.tagName).toBe("NAV");
    const switcher = await within(nav).findByRole("button", { name: /^Acme/ });
    expect(switcher).toHaveTextContent("Switch workspace");
    // The workspace's color mark, 26 px, with no letter or icon in it.
    const mark = switcher.querySelector(".ob-mark");
    expect(mark).toHaveClass("ob-mark-26", "ob-solid");
    expect(mark).toBeEmptyDOMElement();
    expect(switcher.querySelector("svg.lucide-chevrons-up-down")).toBeInTheDocument();

    const search = within(nav).getByRole("button", { name: /^Search everything/ });
    expect(search).toHaveTextContent("Ctrl K");
    const home = within(nav).getByRole("link", { name: "Home" });
    expect(home).toHaveAttribute("href", "/workspace/wsp1");
    expect(home).toHaveAttribute("aria-current", "page");
    const notifications = within(nav).getByRole("button", { name: "Notifications" });
    const automations = within(nav).getByRole("link", { name: "Automations" });
    expect(automations).toHaveAttribute("href", "/workspace/wsp1/automations");
    const heading = within(nav).getByRole("heading", { name: "Collections" });
    const history = within(nav).getByRole("link", { name: "History" });
    const trash = within(nav).getByRole("link", { name: "Trash" });
    const settings = within(nav).getByRole("link", { name: "Workspace settings" });
    const account = await within(nav).findByRole("button", { name: "Account menu" });
    const order = [switcher, search, home, notifications, automations, heading, history, trash, settings, account];
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
    expect(history).toHaveAttribute("href", "/history?workspace=wsp1");
    expect(trash).toHaveAttribute("href", "/trash?workspace=wsp1");
    expect(settings).toHaveAttribute("href", "/workspace/wsp1/settings");
    // The person: the avatar and the name.
    expect(account).toHaveTextContent("Ada Lovelace");
    // Nothing in the sidebar is an Inbox, a view, or a project.
    expect(within(nav).queryByRole("link", { name: "Inbox" })).not.toBeInTheDocument();
  });

  it("lists the top-level collections first, then the folders, each folder folded open to its collections", async () => {
    render();
    const nav = menu();
    const top = await topLevel();
    expect(within(top).getAllByRole("link").map((a) => a.textContent)).toEqual(["Tasks12", "People1,234"]);
    expect(within(top).getByRole("link", { name: /^Tasks/ })).toHaveAttribute("href", "/base/app0/tbl1");
    const folders = within(nav).getByRole("list", { name: "Folders" });
    // The top-level project is no folder.
    expect(within(folders).queryByRole("button", { name: "Acme" })).not.toBeInTheDocument();
    expect(within(folders).getAllByRole("button", { name: /^(Chores|CRM)$/ }).map((b) => b.textContent)).toEqual(["Chores", "CRM"]);
    const chores = within(folders).getByRole("button", { name: "Chores" });
    expect(chores).toHaveAttribute("aria-expanded", "true");
    const choresList = within(nav).getByRole("list", { name: "Collections in Chores" });
    expect(chores).toHaveAttribute("aria-controls", choresList.id);
    expect(within(choresList).getAllByRole("link").map((a) => a.textContent)).toEqual(["Dishes3", "Laundry0"]);
    // The collections are in 20 px; the top level's are not.
    expect(choresList).toHaveClass("ml-5");
    expect(top).not.toHaveClass("ml-5");
    // An empty folder says so.
    expect(within(nav).getByText("No collections yet.")).toBeInTheDocument();
    // The top-level collections come before the folders.
    expect(top.compareDocumentPosition(folders) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks only color on collections, folders and the workspace: never an icon, emoji or letter", async () => {
    render({ workspaces: [{ ...acme(), icon: "store" }, club()] });
    const nav = menu();
    const top = await topLevel();
    for (const link of within(top).getAllByRole("link")) {
      expect(link.querySelector(".ob-mark-14")).toHaveClass("ob-solid");
      expect(link.querySelector("svg")).toBeNull();
      expect(link.querySelector(".ob-mark")).toBeEmptyDOMElement();
    }
    const chores = within(nav).getByRole("button", { name: "Chores" });
    expect(chores.querySelector(".ob-mark-14")).toHaveClass("ob-solid");
    // The folder's only glyph is the chevron, which shows its fold state.
    expect(chores.parentElement!.querySelectorAll("svg.lucide")).toHaveLength(2);
    expect(within(nav).getByRole("button", { name: /^Acme/ }).querySelector("[data-entity-tile], svg.lucide-store")).toBeNull();
  });

  it("shows each collection's record count on the right, and marks the open collection", async () => {
    render({ tableId: "tbl2", route: "/base/app0/tbl2" });
    const people = within(await topLevel()).getByRole("link", { name: /^People/ });
    expect(people).toHaveAttribute("aria-current", "page");
    expect(people).toHaveClass("bg-primary-soft", "font-semibold");
    expect(people.textContent).toBe("People1,234");
    expect(within(people).getByText("1,234")).toHaveClass("min-w-7");
    expect(within(await topLevel()).getByRole("link", { name: /^Tasks/ })).not.toHaveAttribute("aria-current");
  });

  it("draws Home and Notifications even before the workspaces arrive, and says nothing of Automations to editors", async () => {
    render({ workspaces: [club()], workspaceId: "wsp2", route: "/workspace/wsp2" });
    const nav = menu();
    expect(await within(nav).findByRole("button", { name: /^Book club/ })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/workspace/wsp2");
    expect(within(nav).queryByRole("link", { name: "Automations" })).not.toBeInTheDocument();
    // Editors have no settings page.
    expect(within(nav).queryByRole("link", { name: "Workspace settings" })).not.toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "History" })).toBeInTheDocument();
  });

  it("shows the workspace used last when the page belongs to none (account, admin)", async () => {
    localStorage.setItem("ob-last-workspace", "wsp2");
    render({ workspaceId: "", route: "/account" });
    expect(await within(menu()).findByRole("button", { name: /^Book club/ })).toBeInTheDocument();
    expect(within(menu()).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/workspace/wsp2");
  });

  it("opens the search from its row", async () => {
    const user = userEvent.setup();
    render();
    await user.click(within(menu()).getByRole("button", { name: /^Search everything/ }));
    expect(await screen.findByRole("dialog", { name: "Search everything" })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Search" })).toHaveFocus();
  });

  it("sets Notifications apart from the pages: it opens beside the sidebar and shows the unread count", async () => {
    const user = userEvent.setup();
    render({ extra: { "GET /api/notifications": { notifications: [], unread: 4 } } });
    const row = await within(menu()).findByRole("button", { name: "Notifications, 4 unread" });
    expect(row).toHaveTextContent("4");
    expect(row).not.toHaveAttribute("aria-current");
    await user.click(row);
    expect(await screen.findByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
  });
});

describe("limited members (NAV-10)", () => {
  it("shows the folders they can open and no top level when they cannot open it", async () => {
    const limited: WorkspaceSummary = { ...acme("editor"), root_base_id: null, bases: acme("editor").bases.filter((b) => !b.is_top_level) };
    render({ workspaces: [limited] });
    const nav = menu();
    expect(await within(nav).findByRole("button", { name: "Chores" })).toBeInTheDocument();
    expect(within(nav).queryByRole("list", { name: "Collections" })).not.toBeInTheDocument();
    expect(within(nav).queryByText("Tasks")).not.toBeInTheDocument();
    // Nothing to add: they cannot create in the top level, and are not creators.
    expect(within(nav).queryByRole("button", { name: "Add a collection or folder" })).not.toBeInTheDocument();
  });

  it("says so when nothing is open to them at all", async () => {
    render({ workspaces: [{ ...acme("viewer"), root_base_id: null, bases: [] }] });
    expect(await screen.findByText("Nothing to show yet.")).toBeInTheDocument();
  });
});

describe("folding folders (NAV-2)", () => {
  it("folds and unfolds a folder on a click or Enter, and remembers that on this device", async () => {
    const user = userEvent.setup();
    const first = render();
    const chores = await within(menu()).findByRole("button", { name: "Chores" });
    expect(screen.getByRole("list", { name: "Collections in Chores" })).toBeInTheDocument();
    await user.click(chores);
    expect(chores).toHaveAttribute("aria-expanded", "false");
    expect(chores).not.toHaveAttribute("aria-controls");
    expect(screen.queryByRole("list", { name: "Collections in Chores" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(FOLDERS_OPEN_KEY)!)).toEqual({ app1: false });
    // A fold goes nowhere.
    expect(where()).toBe("/workspace/wsp1");

    // By keyboard, too.
    chores.focus();
    await user.keyboard("{Enter}");
    expect(chores).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(chores).toHaveAttribute("aria-expanded", "false");
    expect(first.callsTo("GET /api/bases/app1")).toHaveLength(0);
  });

  it("starts the way it was left", async () => {
    localStorage.setItem(FOLDERS_OPEN_KEY, JSON.stringify({ app1: false }));
    render();
    const chores = await within(menu()).findByRole("button", { name: "Chores" });
    expect(chores).toHaveAttribute("aria-expanded", "false");
    expect(within(menu()).getByRole("button", { name: "CRM" })).toHaveAttribute("aria-expanded", "true");
  });

  it("ignores unreadable storage", async () => {
    localStorage.setItem(FOLDERS_OPEN_KEY, "{not json");
    render();
    expect(await within(menu()).findByRole("button", { name: "Chores" })).toHaveAttribute("aria-expanded", "true");
  });

  it("unfolds a folded folder when the open collection turns out to be inside it", async () => {
    localStorage.setItem(FOLDERS_OPEN_KEY, JSON.stringify({ app1: false }));
    render({ tableId: "tbl3", route: "/base/app1/tbl3" });
    const chores = await within(menu()).findByRole("button", { name: "Chores" });
    await waitFor(() => expect(chores).toHaveAttribute("aria-expanded", "true"));
    expect(within(screen.getByRole("list", { name: "Collections in Chores" })).getByRole("link", { name: /^Dishes/ })).toHaveAttribute("aria-current", "page");
    // Folding it again by hand is respected.
    const user = userEvent.setup();
    await user.click(chores);
    expect(chores).toHaveAttribute("aria-expanded", "false");
  });
});

describe("the + beside Collections", () => {
  it("offers a new collection, one from CSV and a new folder to a creator", async () => {
    const user = userEvent.setup();
    render();
    await user.click(await within(menu()).findByRole("button", { name: "Add a collection or folder" }));
    expect(names(await screen.findByRole("menu"))).toEqual(["New collection", "New collection from CSV", "New folder"]);
  });

  it("makes a collection in the top level and opens it", async () => {
    const user = userEvent.setup();
    const api = render({ extra: { "POST /api/bases/app0/tables": { ...makeSchema("owner").tables[0], id: "tbl7", base_id: "app0", name: "Notes" } } });
    await user.click(await within(menu()).findByRole("button", { name: "Add a collection or folder" }));
    await user.click(await screen.findByRole("menuitem", { name: "New collection" }));
    const dialog = await screen.findByRole("dialog", { name: "New collection" });
    // The dialog lives outside the sidebar, and offers no icon.
    expect(within(dialog).queryByRole("button", { name: /icon/i })).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Collection name"), "Notes");
    await user.click(within(dialog).getByRole("button", { name: "Create collection" }));
    await waitFor(() => expect(api.callsTo("POST /api/bases/app0/tables")).toHaveLength(1));
    expect(api.callsTo("POST /api/bases/app0/tables")[0]?.body).toEqual({ name: "Notes" });
    await waitFor(() => expect(where()).toMatch(/^\/base\/app0\/tbl7/));
  });

  it("makes a folder with a chosen color and opens it", async () => {
    const user = userEvent.setup();
    const api = render({ extra: { "POST /api/workspaces/wsp1/bases": makeSchema("owner", { id: "app9", name: "Garden", tables: [] }) } });
    await user.click(await within(menu()).findByRole("button", { name: "Add a collection or folder" }));
    await user.click(await screen.findByRole("menuitem", { name: "New folder" }));
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    await user.type(within(dialog).getByLabelText("Folder name"), "Garden");
    await user.click(within(dialog).getByRole("radio", { name: "Teal" }));
    await user.click(within(dialog).getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces/wsp1/bases")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces/wsp1/bases")[0]?.body).toEqual({ name: "Garden", color: "teal", empty: true });
    await waitFor(() => expect(where()).toBe("/base/app9"));
  });

  it("is for those who can create: an editor of the top level has none", async () => {
    render({ workspaces: [club()], workspaceId: "wsp2", route: "/workspace/wsp2" });
    await within(menu()).findByRole("button", { name: /^Book club/ });
    expect(within(menu()).queryByRole("button", { name: "Add a collection or folder" })).not.toBeInTheDocument();
  });

  it("offers only a new folder to a creator who cannot open the top level", async () => {
    const user = userEvent.setup();
    const limited: WorkspaceSummary = { ...acme("creator"), root_base_id: null, bases: acme("creator").bases.filter((b) => !b.is_top_level) };
    render({ workspaces: [limited] });
    await user.click(await within(menu()).findByRole("button", { name: "Add a collection or folder" }));
    expect(names(await screen.findByRole("menu"))).toEqual(["New folder"]);
  });
});

describe("collection menu (NAV-3)", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>, name = "Tasks") => {
    await user.click(await within(menu()).findByRole("button", { name: `Collection options for ${name}` }));
    return screen.findByRole("menu");
  };

  it("holds Rename, Color, Duplicate, Import CSV, Move up, Move down and Delete for a creator, and no Edit schema or Add view", async () => {
    const user = userEvent.setup();
    render({ workspaces: [acme("creator")] });
    const menuEl = await open(user);
    expect(names(menuEl)).toEqual(["Rename", "Color", "Duplicate", "Import CSV", "Move up", "Move down", "Delete"]);
    expect(within(menuEl).getByRole("menuitem", { name: "Move up" })).toHaveAttribute("aria-disabled", "true");
    expect(within(menuEl).getByRole("menuitem", { name: "Move down" })).not.toHaveAttribute("aria-disabled");
    // No icon picker, however the menu is opened.
    expect(within(menuEl).queryByRole("menuitem", { name: /icon/i })).not.toBeInTheDocument();
  });

  it("gives an editor Import CSV alone", async () => {
    const user = userEvent.setup();
    render({ workspaces: [acme("editor")] });
    expect(names(await open(user))).toEqual(["Import CSV"]);
  });

  it("gives a viewer no menu at all, nor a button for one", async () => {
    render({ workspaces: [acme("viewer")] });
    await topLevel();
    expect(within(menu()).queryByRole("button", { name: /^Collection options for/ })).not.toBeInTheDocument();
    // A right-click on a row is left to the browser.
    expect(fireEvent.contextMenu(within(menu()).getByRole("link", { name: /^Tasks/ }))).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("is also opened by a right-click on the row, and Escape gives focus back to its button", async () => {
    const user = userEvent.setup();
    render();
    const row = within(await topLevel()).getByRole("link", { name: /^Tasks/ });
    // Not the browser's own menu.
    expect(fireEvent.contextMenu(row)).toBe(false);
    const menuEl = await screen.findByRole("menu");
    expect(names(menuEl)[0]).toBe("Rename");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Collection options for Tasks" })).toHaveFocus();
  });

  it("renames, recolors, duplicates and deletes", async () => {
    const user = userEvent.setup();
    const api = render({
      extra: {
        "PATCH /api/tables/tbl1": { status: 204 },
        "POST /api/tables/tbl1/duplicate": { ...makeSchema("owner").tables[0], id: "tbl8", base_id: "app0", name: "Tasks copy" },
        "DELETE /api/tables/tbl1": { status: 204 },
      },
    });
    await user.click(await within(menu()).findByRole("button", { name: "Collection options for Tasks" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const rename = await screen.findByRole("dialog", { name: "Rename collection" });
    // No icon in the dialog.
    expect(within(rename).queryByRole("button", { name: /icon/i })).not.toBeInTheDocument();
    const input = within(rename).getByLabelText("Collection name");
    await user.clear(input);
    await user.type(input, "Jobs");
    await user.click(within(rename).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/tables/tbl1")[0]?.body).toEqual({ name: "Jobs" });

    await user.click(screen.getByRole("button", { name: "Collection options for Tasks" }));
    await user.click(await screen.findByRole("menuitem", { name: "Color" }));
    const color = await screen.findByRole("dialog", { name: "Collection color" });
    expect(within(color).getByRole("radio", { name: "Orange" })).toBeChecked();
    await user.click(within(color).getByRole("radio", { name: "Purple" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1")).toHaveLength(2));
    expect(api.callsTo("PATCH /api/tables/tbl1")[1]?.body).toEqual({ color: "purple" });

    await user.click(screen.getByRole("button", { name: "Collection options for Tasks" }));
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/duplicate")).toHaveLength(1));
    await waitFor(() => expect(where()).toBe("/base/app0/tbl8"));

    await user.click(screen.getByRole("button", { name: "Collection options for Tasks" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete collection" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/tables/tbl1")).toHaveLength(1));
  });

  it("imports CSV into a collection of a folder that is not open, loading its properties first", async () => {
    const user = userEvent.setup();
    const api = render({ extra: { "GET /api/bases/app1": makeSchema("owner", { id: "app1", name: "Chores", tables: [{ ...makeSchema("owner").tables[0]!, id: "tbl3", base_id: "app1", name: "Dishes" }] }) } });
    expect(api.callsTo("GET /api/bases/app1")).toHaveLength(0);
    await user.click(await within(menu()).findByRole("button", { name: "Collection options for Dishes" }));
    await user.click(await screen.findByRole("menuitem", { name: "Import CSV" }));
    expect(await screen.findByRole("dialog", { name: "Import CSV into Dishes" })).toBeInTheDocument();
    expect(api.callsTo("GET /api/bases/app1")).toHaveLength(1);
  });

  it("cannot delete the last collection of a folder", async () => {
    const user = userEvent.setup();
    const one = acme();
    one.bases[1]!.tables = [table("tbl3", "Dishes", "cyan", 3)];
    render({ workspaces: [one] });
    await user.click(await within(menu()).findByRole("button", { name: "Collection options for Dishes" }));
    expect(await screen.findByRole("menuitem", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("folder menu (NAV-3)", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>, name = "Chores") => {
    await user.click(await within(menu()).findByRole("button", { name: `Folder options for ${name}` }));
    return screen.findByRole("menu");
  };

  it("holds everything for an owner, in the spec's order", async () => {
    const user = userEvent.setup();
    render();
    const menuEl = await open(user);
    expect(names(menuEl)).toEqual([
      "Rename",
      "Color",
      "New collection",
      "New collection from CSV",
      "Share",
      "Access",
      "Automations",
      "Duplicate",
      "Move up",
      "Move down",
      "Use as top level",
      "Delete",
    ]);
    expect(within(menuEl).getByRole("menuitem", { name: "Access" })).toHaveAttribute("href", "/workspace/wsp1/members");
    expect(within(menuEl).getByRole("menuitem", { name: "Automations" })).toHaveAttribute("href", "/base/app1/automations");
  });

  it("leaves 'Use as top level' and Delete to owners", async () => {
    const user = userEvent.setup();
    render({ workspaces: [acme("creator")] });
    const menuEl = await open(user);
    expect(names(menuEl)).toEqual(["Rename", "Color", "New collection", "New collection from CSV", "Share", "Access", "Automations", "Duplicate", "Move up", "Move down"]);
  });

  it("gives an editor Access alone", async () => {
    const user = userEvent.setup();
    render({ workspaces: [acme("editor")] });
    expect(names(await open(user))).toEqual(["Access"]);
  });

  it("opens with a right-click on the folder's row", async () => {
    render();
    const row = await within(menu()).findByRole("button", { name: "Chores" });
    expect(fireEvent.contextMenu(row)).toBe(false);
    expect(names(await screen.findByRole("menu"))[0]).toBe("Rename");
  });

  it("renames and recolors the folder, with no icon on offer", async () => {
    const user = userEvent.setup();
    const api = render({ extra: { "PATCH /api/bases/app1": { status: 204 } } });
    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename folder" });
    expect(within(dialog).queryByRole("button", { name: /icon/i })).not.toBeInTheDocument();
    const input = within(dialog).getByLabelText("Folder name");
    await user.clear(input);
    await user.type(input, "Home{Enter}");
    await waitFor(() => expect(api.callsTo("PATCH /api/bases/app1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/bases/app1")[0]?.body).toEqual({ name: "Home" });

    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Color" }));
    const color = await screen.findByRole("dialog", { name: "Folder color" });
    expect(within(color).getByRole("radio", { name: "Teal" })).toBeChecked();
    await user.click(within(color).getByRole("radio", { name: "Pink" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/bases/app1")).toHaveLength(2));
    expect(api.callsTo("PATCH /api/bases/app1")[1]?.body).toEqual({ color: "pink" });
  });

  it("makes a collection in the folder, and one from CSV", async () => {
    const user = userEvent.setup();
    const api = render({ extra: { "POST /api/bases/app1/tables": { ...makeSchema("owner").tables[0], id: "tbl7", base_id: "app1", name: "Plants" } } });
    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "New collection" }));
    const dialog = await screen.findByRole("dialog", { name: "New collection" });
    await user.type(within(dialog).getByLabelText("Collection name"), "Plants{Enter}");
    await waitFor(() => expect(api.callsTo("POST /api/bases/app1/tables")).toHaveLength(1));
    expect(api.callsTo("POST /api/bases/app1/tables")[0]?.body).toEqual({ name: "Plants" });

    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "New collection from CSV" }));
    expect(await screen.findByRole("dialog", { name: "New collection from CSV" })).toBeInTheDocument();
  });

  it("shares the folder, and duplicates it", async () => {
    const user = userEvent.setup();
    const api = render({ extra: { "POST /api/bases/app1/duplicate": { id: "app8" } } });
    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Share" }));
    expect(await screen.findByRole("dialog", { name: "Share Chores" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() => expect(api.callsTo("POST /api/bases/app1/duplicate")[0]?.body).toEqual({ name: "Chores copy", include_records: true }));
  });

  it("makes a folder the top level (owners): only the pointer moves", async () => {
    const user = userEvent.setup();
    let list = [acme(), club()];
    const api = render({
      workspaces: [],
      extra: {
        "GET /api/workspaces": () => list,
        "POST /api/workspaces/wsp1/top-level": (call) => {
          const id = (call.body as { base_id: string }).base_id;
          list = [{ ...acme(), root_base_id: id, bases: acme().bases.map((b) => ({ ...b, is_top_level: b.id === id })) }, club()];
          return list[0];
        },
      },
    });
    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Use as top level" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces/wsp1/top-level")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces/wsp1/top-level")[0]?.body).toEqual({ base_id: "app1" });
    // Chores' collections are now the top level's, and the old top level is a folder.
    expect(await within(menu()).findByRole("list", { name: "Collections in Acme" })).toBeInTheDocument();
    expect(within(menu()).queryByRole("button", { name: "Chores" })).not.toBeInTheDocument();
    expect(within(await topLevel()).getAllByRole("link").map((a) => a.textContent)).toEqual(["Dishes3", "Laundry0"]);
  });

  it("deletes a folder after confirming", async () => {
    const user = userEvent.setup();
    let list = [acme(), club()];
    const api = render({
      workspaces: [],
      extra: {
        "GET /api/workspaces": () => list,
        "DELETE /api/bases/app2": () => {
          list = [{ ...acme(), bases: acme().bases.filter((b) => b.id !== "app2") }, club()];
          return { status: 204 };
        },
      },
    });
    await open(user, "CRM");
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveAccessibleName("Delete CRM?");
    await user.click(within(confirm).getByRole("button", { name: "Delete folder" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/bases/app2")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Folder options for CRM" })).not.toBeInTheDocument());
  });

  it("says why when the server refuses to delete the top level, and keeps the folder", async () => {
    const user = userEvent.setup();
    const message = "'Chores' is the top-level folder of its workspace, so it cannot be deleted. Make another folder the top level first, or delete the workspace.";
    render({ extra: { "DELETE /api/bases/app1": apiError(409, "conflict", message) } });
    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Delete folder" }));
    expect(await within(confirm).findByRole("alert")).toHaveTextContent(message);
    // The dialog stays up; nothing left the sidebar.
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(within(menu()).getByRole("button", { name: "Chores", hidden: true })).toBeInTheDocument();
  });
});

describe("workspace switcher (NAV-3, NAV-4, NAV-6)", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await within(menu()).findByRole("button", { name: /^Acme/ }));
    return screen.findByRole("menu");
  };

  it("starts with the OpenBase mark, lists every workspace by mark and name with a check on the open one, then New workspace", async () => {
    const user = userEvent.setup();
    render();
    const menuEl = await open(user);
    // The brand is at the top of the menu, and not in the switcher.
    const brand = within(menuEl).getByTestId("brand");
    expect(brand.querySelector("svg")).not.toBeNull();
    expect(menuEl.firstElementChild).toBe(brand);
    expect(within(await screen.findByRole("button", { name: /^Acme/, hidden: true })).queryByTestId("brand")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Acme/, hidden: true }).querySelector("svg.lucide-chevrons-up-down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Acme/, hidden: true }).querySelector('svg[role="img"]')).toBeNull();

    const radios = within(menuEl).getAllByRole("menuitemradio");
    expect(radios.map((r) => r.textContent)).toEqual(["Acme", "Book club"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    for (const r of radios) expect(r.querySelector(".ob-mark-14")).toHaveClass("ob-solid");
    const items = within(menuEl).getAllByRole("menuitem");
    expect(items[0]).toHaveTextContent("New workspace");
    // The brand, the workspaces, New workspace, and only then the open workspace's actions.
    expect(radios.at(-1)!.compareDocumentPosition(items[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("owns only items, groups and separators: the drag live region sits in a group, not beside the items", async () => {
    const user = userEvent.setup();
    render();
    const menuEl = await open(user);
    // axe: aria-required-children fails on a status that is a direct child of a menu.
    expect(menuEl.querySelector(':scope > [role="status"]')).toBeNull();
    expect(menuEl.querySelector('[role="group"] > [role="status"]')).not.toBeNull();
  });

  it("goes to another workspace's Home and remembers it", async () => {
    const user = userEvent.setup();
    render();
    await open(user);
    await user.click(screen.getByRole("menuitemradio", { name: "Book club" }));
    await waitFor(() => expect(where()).toBe("/workspace/wsp2"));
    expect(localStorage.getItem("ob-last-workspace")).toBe("wsp2");
  });

  it("creates a workspace with a chosen color, and no icon on offer", async () => {
    const user = userEvent.setup();
    const api = render({ extra: { "POST /api/workspaces": { ...acme(), id: "wsp9", name: "Studio", bases: [] } } });
    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "New workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    expect(within(dialog).queryByRole("button", { name: /icon/i })).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Name"), "Studio");
    await user.click(within(dialog).getByRole("radio", { name: "Red" }));
    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces")[0]?.body).toEqual({ name: "Studio", color: "red" });
    await waitFor(() => expect(where()).toBe("/workspace/wsp9"));
  });

  it("sends no color when none was picked, so the server chooses", async () => {
    const user = userEvent.setup();
    const api = render({ extra: { "POST /api/workspaces": { ...acme(), id: "wsp9", name: "Garage", bases: [] } } });
    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "New workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    await user.type(within(dialog).getByLabelText("Name"), "Garage");
    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces")[0]?.body).toEqual({ name: "Garage" }));
  });

  it("holds the open workspace's actions: Rename, Color, Members, Invite people, Settings, History, Trash, Delete", async () => {
    const user = userEvent.setup();
    render();
    const menuEl = await open(user);
    expect(names(menuEl)).toEqual(["New workspace", "Rename", "Color", "Members", "Invite people", "Settings", "History", "Trash", "Delete"]);
    expect(within(menuEl).getByRole("menuitem", { name: "Members" })).toHaveAttribute("href", "/workspace/wsp1/members");
    expect(within(menuEl).getByRole("menuitem", { name: "Settings" })).toHaveAttribute("href", "/workspace/wsp1/settings");
    expect(within(menuEl).getByRole("menuitem", { name: "History" })).toHaveAttribute("href", "/history?workspace=wsp1");
    expect(within(menuEl).getByRole("menuitem", { name: "Trash" })).toHaveAttribute("href", "/trash?workspace=wsp1");
    for (const item of within(menuEl).getAllByRole("menuitem")) expect(item.textContent, "no icon picker").not.toMatch(/icon/i);
  });

  it("gives a non-owner the pages and nothing that changes the workspace", async () => {
    const user = userEvent.setup();
    render({ workspaces: [{ ...acme("editor"), name: "Acme" }, club()] });
    expect(names(await open(user))).toEqual(["New workspace", "Members", "History", "Trash"]);
  });

  it("renames, recolors and deletes the workspace", async () => {
    const user = userEvent.setup();
    const api = render({ extra: { "PATCH /api/workspaces/wsp1": acme(), "DELETE /api/workspaces/wsp1": { ok: true } } });
    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const rename = await screen.findByRole("dialog", { name: "Rename workspace" });
    expect(within(rename).queryByRole("button", { name: /icon/i })).not.toBeInTheDocument();
    await user.clear(within(rename).getByLabelText("Name"));
    await user.type(within(rename).getByLabelText("Name"), "Acme Inc");
    await user.click(within(rename).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1")[0]?.body).toEqual({ name: "Acme Inc" }));

    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Color" }));
    const color = await screen.findByRole("dialog", { name: "Workspace color" });
    expect(within(color).getByRole("radio", { name: "Green" })).toBeChecked();
    await user.click(within(color).getByRole("radio", { name: "Purple" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1")[1]?.body).toEqual({ color: "purple" }));

    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete workspace" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/workspaces/wsp1")).toHaveLength(1));
  });

  it("opens the Share dialog to invite people", async () => {
    const user = userEvent.setup();
    render();
    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Invite people" }));
    expect(await screen.findByRole("dialog", { name: "Share Acme" })).toBeInTheDocument();
  });

  it("is a menu button: the arrow keys walk the workspaces and Escape returns focus to it", async () => {
    const user = userEvent.setup();
    render();
    const trigger = await within(menu()).findByRole("button", { name: /^Acme/ });
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    // Opened from the keyboard, the menu starts on its first row; the brand above it is no stop.
    expect(screen.getByRole("menuitemradio", { name: "Acme" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "Book club" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  describe("reordering", () => {
    const stateful = (initial: WorkspaceSummary[]) => {
      let list = initial;
      return {
        "GET /api/workspaces": () => list,
        "POST /api/workspaces/reorder": (call: { body: unknown }) => {
          const ids = (call.body as { ids: string[] }).ids;
          list = ids.map((id) => list.find((w) => w.id === id)!);
          return { ok: true };
        },
      };
    };

    it("moves the focused workspace with Alt+Down and Alt+Up, sending only the new order", async () => {
      const user = userEvent.setup();
      const api = render({ workspaces: [], extra: stateful([acme(), club()]) });
      await open(user);
      const first = screen.getByRole("menuitemradio", { name: "Acme" });
      expect(first).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
      first.focus();
      fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
      await waitFor(() => expect(api.callsTo("POST /api/workspaces/reorder")).toHaveLength(1));
      expect(api.callsTo("POST /api/workspaces/reorder")[0]?.body).toEqual({ ids: ["wsp2", "wsp1"] });
      await waitFor(() => expect(screen.getAllByRole("menuitemradio").map((r) => r.textContent)).toEqual(["Book club", "Acme"]));
      // It cannot go further down.
      fireEvent.keyDown(screen.getByRole("menuitemradio", { name: "Acme" }), { key: "ArrowDown", altKey: true });
      expect(api.callsTo("POST /api/workspaces/reorder")).toHaveLength(1);
      fireEvent.keyDown(screen.getByRole("menuitemradio", { name: "Acme" }), { key: "ArrowUp", altKey: true });
      await waitFor(() => expect(api.callsTo("POST /api/workspaces/reorder")).toHaveLength(2));
      expect(api.callsTo("POST /api/workspaces/reorder")[1]?.body).toEqual({ ids: ["wsp1", "wsp2"] });
    });

    it("puts the old order back and says so when the server refuses", async () => {
      const user = userEvent.setup();
      render({ workspaces: [], extra: { ...stateful([acme(), club()]), "POST /api/workspaces/reorder": { status: 500, json: { error: { code: "internal", message: "boom" } } } } });
      await open(user);
      fireEvent.keyDown(screen.getByRole("menuitemradio", { name: "Acme" }), { key: "ArrowDown", altKey: true });
      expect(await screen.findByText("Could not reorder the workspaces")).toBeInTheDocument();
      await waitFor(() => expect(screen.getAllByRole("menuitemradio").map((r) => r.textContent)).toEqual(["Acme", "Book club"]));
    });

    it("has nothing to move with a single workspace", async () => {
      const user = userEvent.setup();
      const api = render({ workspaces: [acme()] });
      await open(user);
      const only = screen.getByRole("menuitemradio", { name: "Acme" });
      expect(only).not.toHaveAttribute("aria-keyshortcuts");
      fireEvent.keyDown(only, { key: "ArrowDown", altKey: true });
      expect(api.callsTo("POST /api/workspaces/reorder")).toHaveLength(0);
    });
  });
});

describe("reordering folders and collections (NAV-2)", () => {
  const move = async (user: ReturnType<typeof userEvent.setup>, button: string, item: "Move up" | "Move down") => {
    await user.click(await screen.findByRole("button", { name: button }));
    await user.click(await screen.findByRole("menuitem", { name: item }));
  };
  const orderOf = (list: HTMLElement) => within(list).getAllByRole("link").map((a) => a.textContent!.replace(/\d[\d,]*$/, ""));

  it("moves a collection within its folder, sending the folder's whole order", async () => {
    const user = userEvent.setup();
    let ws = acme();
    const api = render({
      workspaces: [],
      extra: {
        "GET /api/workspaces": () => [ws, club()],
        "POST /api/bases/app1/tables/reorder": (call) => {
          const ids = (call.body as { ids: string[] }).ids;
          ws = { ...ws, bases: ws.bases.map((b) => (b.id === "app1" ? { ...b, tables: ids.map((id) => b.tables.find((t) => t.id === id)!) } : b)) };
          return { ok: true };
        },
      },
    });
    await within(menu()).findByRole("button", { name: "Chores" });
    await move(user, "Collection options for Dishes", "Move down");
    await waitFor(() => expect(api.callsTo("POST /api/bases/app1/tables/reorder")).toHaveLength(1));
    expect(api.callsTo("POST /api/bases/app1/tables/reorder")[0]?.body).toEqual({ ids: ["tbl4", "tbl3"] });
    await waitFor(() => expect(orderOf(screen.getByRole("list", { name: "Collections in Chores" }))).toEqual(["Laundry", "Dishes"]));
    // The top level's own collections were not touched.
    expect(orderOf(screen.getByRole("list", { name: "Collections" }))).toEqual(["Tasks", "People"]);
  });

  it("moves a folder among the folders only: the top level is not in the list that is sent", async () => {
    const user = userEvent.setup();
    let ws = acme();
    const api = render({
      workspaces: [],
      extra: {
        "GET /api/workspaces": () => [ws, club()],
        "POST /api/workspaces/wsp1/bases/reorder": (call) => {
          const ids = (call.body as { ids: string[] }).ids;
          // The server keeps the places the ids held: the top level stays first.
          const folders = ids.map((id) => ws.bases.find((b) => b.id === id)!);
          ws = { ...ws, bases: [ws.bases[0]!, ...folders] };
          return { ok: true };
        },
      },
    });
    await within(menu()).findByRole("button", { name: "Chores" });
    await move(user, "Folder options for Chores", "Move down");
    await waitFor(() => expect(api.callsTo("POST /api/workspaces/wsp1/bases/reorder")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces/wsp1/bases/reorder")[0]?.body).toEqual({ ids: ["app2", "app1"] });
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Folders" })).getAllByRole("button", { name: /^(Chores|CRM)$/ }).map((b) => b.textContent)).toEqual(["CRM", "Chores"]));
  });

  it("offers Move up and Move down only to those who may reorder", async () => {
    const user = userEvent.setup();
    render({ workspaces: [acme("editor")] });
    await user.click(await within(menu()).findByRole("button", { name: "Collection options for Tasks" }));
    expect(names(await screen.findByRole("menu"))).not.toContain("Move down");
    expect(document.querySelector("[data-sortable]")).toBeNull();
  });

  it("makes the tree's rows draggable and the fixed rows not", async () => {
    render();
    await within(menu()).findByRole("button", { name: "Chores" });
    const handles = Array.from(menu().querySelectorAll("[data-drag-handle]"));
    // Two top-level collections, two folders and the two collections of Chores.
    expect(handles).toHaveLength(6);
    for (const name of ["Home", "History", "Trash", "Automations", "Workspace settings"]) expect(within(menu()).getByRole("link", { name }).closest("[data-drag-handle]"), name).toBeNull();
    expect(within(menu()).getByRole("button", { name: "Notifications" }).closest("[data-drag-handle]")).toBeNull();
  });

  it("reorders by dragging a row, and the click that ends the drag follows no link", async () => {
    let ws = acme();
    // jsdom has no layout: stack the rows by hand, 40px apart.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const rows = Array.from(document.querySelectorAll("li[data-sortable]"));
      const i = rows.indexOf(this as HTMLLIElement);
      const top = i < 0 ? 0 : i * 40;
      return { x: 0, y: top, left: 0, top, width: 200, height: 40, right: 200, bottom: top + 40, toJSON: () => ({}) } as DOMRect;
    });
    const api = render({
      workspaces: [],
      extra: {
        "GET /api/workspaces": () => [ws, club()],
        "POST /api/bases/app0/tables/reorder": (call) => {
          const ids = (call.body as { ids: string[] }).ids;
          ws = { ...ws, bases: ws.bases.map((b) => (b.id === "app0" ? { ...b, tables: ids.map((id) => b.tables.find((t) => t.id === id)!) } : b)) };
          return { ok: true };
        },
      },
    });
    const handle = (await within(menu()).findByRole("link", { name: /^Tasks/ })).closest("[data-drag-handle]")!;
    expect(handle).not.toBeNull();
    fireEvent.mouseDown(handle, { button: 0, clientX: 20, clientY: 20 });
    // A move of less than 5px is still a click.
    fireEvent.mouseMove(document, { clientX: 20, clientY: 22 });
    await act(async () => {});
    expect(document.querySelector("[data-dragging]")).toBeNull();
    for (const y of [30, 50, 70]) {
      fireEvent.mouseMove(document, { clientX: 20, clientY: y });
      await act(async () => {});
    }
    expect(document.querySelector("[data-dragging]")).not.toBeNull();
    fireEvent.mouseUp(document, { clientX: 20, clientY: 70 });
    // The click a browser sends after the release is swallowed, default and all: it would otherwise open the collection.
    expect(fireEvent.click(within(menu()).getByRole("link", { name: /^Tasks/ }))).toBe(false);
    await waitFor(() => expect(api.callsTo("POST /api/bases/app0/tables/reorder")).toHaveLength(1));
    expect(api.callsTo("POST /api/bases/app0/tables/reorder")[0]?.body).toEqual({ ids: ["tbl2", "tbl1"] });
  });
});

describe("keeping counts current (BE-9)", () => {
  it("asks for the workspaces again when the window regains focus", async () => {
    let n = 12;
    const api = render({ workspaces: [], extra: { "GET /api/workspaces": () => [{ ...acme(), bases: [{ ...acme().bases[0]!, tables: [table("tbl1", "Tasks", "orange", n)] }] }] } });
    expect(await within(await topLevel()).findByText("12")).toBeInTheDocument();
    const before = api.callsTo("GET /api/workspaces").length;
    n = 13;
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(api.callsTo("GET /api/workspaces").length).toBeGreaterThan(before));
    expect(await within(await topLevel()).findByText("13")).toBeInTheDocument();
  });

  it("asks again every 60 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = render();
    await within(menu()).findByRole("button", { name: /^Acme/ });
    const before = api.callsTo("GET /api/workspaces").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(api.callsTo("GET /api/workspaces").length).toBeGreaterThan(before);
  });
});
