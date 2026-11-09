/**
 * The phone shell (NAV-7, NAV-8, PH-1, PH-2): the bottom navigation, the 56 px header, the workspace switcher and the
 * profile menu as sheets, and the Collections and Notifications screens. Every test runs with a phone-width
 * media query (`stubPhone`).
 */
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Bell, History, Settings, Star } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BasePerson, BaseSummary, TableSummary, WorkspaceSummary } from "@/api/types";
import { Providers, createQueryClient } from "@/providers";
import { ADMIN, USER, makeSchema, mockApi, renderApp, stubPhone, type Handler } from "@/test/utils";
import { AppShell } from "./AppShell";
import { isRecordPath, tabOf, useHideBottomNav } from "./bottomNav";
import { NavDialogsProvider } from "./NavDialogs";
import { PHONE_HEADER_SLOTS, PhoneBackLink, PhoneHeader, splitActions, type PhoneAction } from "./PhoneHeader";

vi.mock("@/views/grid/GridView", async () => {
  const { PlaceholderView } = await import("@/views/PlaceholderView");
  return { default: PlaceholderView };
});

beforeEach(() => stubPhone());
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("--bottom-nav-height");
});

const me: BasePerson = { user_id: "usr1", name: "Ada Lovelace", email: "ada@example.com", pending: false, role: "owner" };
const table = (id: string, name: string, color: string, record_count: number): TableSummary => ({ id, name, color, record_count, body_field_id: null, home_date_field_id: null, done_field_id: null, record_noun: "" });
const base = (id: string, name: string, over: Partial<BaseSummary> = {}): BaseSummary => ({ id, workspace_id: "wsp1", name, color: "green", role: "owner", is_top_level: false, people: [me], tables: [], ...over });

function workspace(over: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "wsp1",
    name: "Acme",
    color: "blue",
    role: "owner",
    root_base_id: "app0",
    member_count: 1,
    pending_invite_count: 0,
    bases: [
      base("app0", "Acme", { is_top_level: true, tables: [table("tbl1", "Tasks", "orange", 12), table("tbl2", "Clients", "pink", 3)] }),
      base("app1", "Consulting", { color: "teal", tables: [table("tbl3", "Projects", "cyan", 2)] }),
    ],
    ...over,
  };
}
const household = (): WorkspaceSummary => workspace({ id: "wsp2", name: "Household", color: "teal", root_base_id: null, bases: [] });

function routes(extra: Record<string, Handler> = {}) {
  return mockApi({
    "GET /api/auth/me": USER,
    "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false, public_url: "https://base.example.org", passkeys_enabled: true },
    "GET /api/workspaces": [workspace(), household()],
    "GET /api/notifications": { notifications: [], unread: 0 },
    "GET /api/inbox": [],
    "GET /api/bases/app0": makeSchema("owner", { id: "app0", name: "Acme", is_top_level: true, workspace_id: "wsp1" }),
    "POST /api/auth/logout": { ok: true },
    ...extra,
  });
}

const tabs = () => screen.findByRole("navigation", { name: "Main menu" });

describe("bottom navigation (PH-1)", () => {
  it("is the phone's main menu: Home, Collections and Notifications, with no drawer to open", async () => {
    routes();
    renderApp({ route: "/workspace/wsp1" });
    const nav = await tabs();
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Home", "Collections", "Notifications"]);
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/workspace/wsp1");
    expect(within(nav).getByRole("link", { name: "Collections" })).toHaveAttribute("href", "/workspace/wsp1/collections");
    expect(within(nav).getByRole("link", { name: "Notifications" })).toHaveAttribute("href", "/notifications");
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Collections" })).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("button", { name: /Show menu|Hide menu/ })).not.toBeInTheDocument();
  });

  it("draws 22 px icons over 12 px labels in a 64 px bar above the home indicator, the current tab in the accent at 600", async () => {
    routes();
    renderApp({ route: "/workspace/wsp1" });
    const nav = await tabs();
    expect(nav.className).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(within(nav).getByRole("list")).toHaveClass("h-[var(--bottom-nav-size)]");
    const home = within(nav).getByRole("link", { name: "Home" });
    expect(home).toHaveClass("text-meta", "font-semibold", "text-primary-text");
    expect(home.querySelector("svg")).toHaveClass("size-5.5");
    expect(within(nav).getByRole("link", { name: "Collections" })).toHaveClass("text-meta", "font-medium", "text-muted");
  });

  it("follows the screen: Collections for the tab and for a collection, Notifications for its screen", async () => {
    routes();
    const first = renderApp({ route: "/workspace/wsp1/collections" });
    expect(within(await tabs()).getByRole("link", { name: "Collections" })).toHaveAttribute("aria-current", "page");
    first.unmount();
    const second = renderApp({ route: "/notifications" });
    expect(within(await tabs()).getByRole("link", { name: "Notifications" })).toHaveAttribute("aria-current", "page");
    second.unmount();
    renderApp({ route: "/base/app0/tbl1" });
    expect(within(await tabs()).getByRole("link", { name: "Collections" })).toHaveAttribute("aria-current", "page");
  });

  it("counts the unread notifications on its tab", async () => {
    routes({ "GET /api/notifications": { notifications: [], unread: 3 } });
    renderApp({ route: "/workspace/wsp1" });
    const nav = await tabs();
    expect(await within(nav).findByRole("link", { name: /^Notifications ?3 ?unread$/ })).toBeInTheDocument();
    expect(within(nav).getByTestId("notifications-badge")).toHaveTextContent("3");
  });

  it("goes to the workspace used last from screens that belong to none", async () => {
    routes();
    renderApp({ route: "/account" });
    expect(within(await tabs()).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/workspace/wsp1");
  });

  it("stands the toasts and floating buttons above itself while it shows", async () => {
    routes();
    renderApp({ route: "/workspace/wsp1" });
    await tabs();
    expect(document.documentElement.style.getPropertyValue("--bottom-nav-height")).toBe("var(--bottom-nav-size)");
  });

  it("is not drawn for someone with no workspace yet", async () => {
    routes({ "GET /api/workspaces": [] });
    renderApp({ route: "/" });
    await screen.findByRole("heading", { name: "Create your first workspace" });
    expect(screen.queryByRole("navigation", { name: "Main menu" })).not.toBeInTheDocument();
  });

  it("leaves someone with no workspace the avatar, so Sign out and the rest stay reachable", async () => {
    const user = userEvent.setup();
    const api = routes({ "GET /api/workspaces": [] });
    renderApp({ route: "/" });
    await screen.findByRole("heading", { name: "Create your first workspace" });
    await user.click(await screen.findByRole("button", { name: /^Account menu/ }));
    await user.click(within(await screen.findByRole("dialog", { name: "Account" })).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(api.callsTo("POST /api/auth/logout")).toHaveLength(1));
  });

  it("knows a record page by its address, with or without the view", () => {
    expect(isRecordPath("/base/app1/tbl1/viw1/r/rec1")).toBe(true);
    expect(isRecordPath("/base/app1/tbl1/r/rec1")).toBe(true);
    expect(isRecordPath("/base/app1/tbl1/viw1")).toBe(false);
    expect(isRecordPath("/base/app1/tbl1")).toBe(false);
    expect(isRecordPath("/workspace/wsp1")).toBe(false);
  });

  it("belongs the right screens to the right tabs", () => {
    expect(tabOf("/workspace/w", "w")).toBe("home");
    expect(tabOf("/workspace/w/collections", "w")).toBe("collections");
    expect(tabOf("/base/a/t/v", "w")).toBe("collections");
    expect(tabOf("/notifications", "w")).toBe("notifications");
    expect(tabOf("/workspace/w/members", "w")).toBeNull();
    expect(tabOf("/workspace/other", "w")).toBeNull();
  });

  describe("hiding", () => {
    function Editor() {
      useHideBottomNav();
      return <p>Full-screen editor</p>;
    }
    function Harness() {
      const [editing, setEditing] = useState(false);
      return (
        <Providers client={createQueryClient()}>
          <MemoryRouter initialEntries={["/workspace/wsp1"]}>
            <NavDialogsProvider>
              <AppShell workspaceId="wsp1">
                <button onClick={() => setEditing((e) => !e)}>Toggle editor</button>
                {editing && <Editor />}
              </AppShell>
            </NavDialogsProvider>
          </MemoryRouter>
        </Providers>
      );
    }

    it("goes while a screen asks for it with useHideBottomNav, and comes back after", async () => {
      routes();
      const user = userEvent.setup();
      render(<Harness />);
      await tabs();
      await user.click(screen.getByRole("button", { name: "Toggle editor" }));
      expect(screen.queryByRole("navigation", { name: "Main menu" })).not.toBeInTheDocument();
      expect(document.documentElement.style.getPropertyValue("--bottom-nav-height")).toBe("");
      await user.click(screen.getByRole("button", { name: "Toggle editor" }));
      expect(await tabs()).toBeInTheDocument();
    });
  });
});

describe("the header (PH-2)", () => {
  const actions = (n: number): PhoneAction[] => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, label: `Action ${i}`, icon: Star, onSelect: vi.fn() }));

  it("keeps the search and up to two more buttons; the rest go behind More, which takes the third place", () => {
    expect(PHONE_HEADER_SLOTS).toBe(3);
    expect(splitActions([1, 2], true)).toEqual({ shown: [1, 2], more: [] });
    expect(splitActions([1, 2, 3], true)).toEqual({ shown: [1], more: [2, 3] });
    expect(splitActions([1, 2, 3], false)).toEqual({ shown: [1, 2, 3], more: [] });
    expect(splitActions([1, 2, 3, 4], false)).toEqual({ shown: [1, 2], more: [3, 4] });
  });

  function renderHeader(n: number, props: Partial<Parameters<typeof PhoneHeader>[0]> = {}) {
    routes();
    return render(
      <Providers client={createQueryClient()}>
        <MemoryRouter initialEntries={["/workspace/wsp1/members"]}>
          <NavDialogsProvider>
            <AppShell workspaceId="wsp1">
              <PhoneHeader title="Members" actions={actions(n)} {...props} />
            </AppShell>
          </NavDialogsProvider>
        </MemoryRouter>
      </Providers>,
    );
  }

  it("is 56 px, with the title as the screen's one heading", async () => {
    renderHeader(0);
    const header = screen.getByRole("banner");
    expect(header).toHaveClass("min-h-[calc(3.5rem+env(safe-area-inset-top))]");
    expect(within(header).getByRole("heading", { level: 1, name: "Members" })).toBeInTheDocument();
  });

  it("draws every button 44 px", async () => {
    renderHeader(1);
    const header = screen.getByRole("banner");
    for (const b of within(header).getAllByRole("button")) expect(b.className, b.getAttribute("aria-label") ?? "").toMatch(/size-control-touch|size-11/);
  });

  it("shows one action with the search, and two actions with the search too", () => {
    renderHeader(2);
    const header = screen.getByRole("banner");
    expect(within(header).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Action 0", "Action 1", "Search everything"]);
    expect(within(header).queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });

  it("puts the rest in a More sheet when there are more than fit", async () => {
    const user = userEvent.setup();
    const all = actions(4);
    renderHeader(4);
    const header = screen.getByRole("banner");
    expect(within(header).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Action 0", "More", "Search everything"]);
    await user.click(within(header).getByRole("button", { name: "More" }));
    const sheet = await screen.findByRole("dialog", { name: "More" });
    expect(within(sheet).getAllByRole("button").map((b) => b.textContent)).toEqual(expect.arrayContaining(["Action 1", "Action 2", "Action 3"]));
    await user.click(within(sheet).getByRole("button", { name: "Action 2" }));
    expect(all[2]!.onSelect).not.toHaveBeenCalled(); // the rendered actions are the header's own copies
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "More" })).not.toBeInTheDocument());
    // Escape returned focus to the More button when closed by a choice or by Escape.
    expect(within(header).getByRole("button", { name: "More" })).toHaveFocus();
  });

  it("runs the action chosen in the More sheet", async () => {
    const user = userEvent.setup();
    const picked = vi.fn();
    routes();
    render(
      <Providers client={createQueryClient()}>
        <MemoryRouter>
          <NavDialogsProvider>
            <AppShell workspaceId="wsp1">
              <PhoneHeader
                title="Clients"
                actions={[
                  { id: "a", label: "Share", icon: Star, onSelect: vi.fn() },
                  { id: "b", label: "History", icon: History, to: "/history" },
                  { id: "c", label: "Settings", icon: Settings, onSelect: picked },
                ]}
              />
            </AppShell>
          </NavDialogsProvider>
        </MemoryRouter>
      </Providers>,
    );
    await user.click(screen.getByRole("button", { name: "More" }));
    const sheet = await screen.findByRole("dialog", { name: "More" });
    expect(within(sheet).getByRole("link", { name: "History" })).toHaveAttribute("href", "/history");
    await user.click(within(sheet).getByRole("button", { name: "Settings" }));
    expect(picked).toHaveBeenCalledTimes(1);
  });

  it("makes an action with a destination a link", () => {
    renderHeader(0, { actions: [{ id: "m", label: "Members", icon: Bell, to: "/workspace/wsp1/members" }] });
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "Members" })).toHaveAttribute("href", "/workspace/wsp1/members");
  });

  it("can leave the search out", () => {
    renderHeader(1, { search: false });
    expect(screen.queryByRole("button", { name: "Search everything" })).not.toBeInTheDocument();
  });

  it("names the screen a back link leads to, for people who hear it", () => {
    renderHeader(0, { leading: <PhoneBackLink to="/workspace/wsp1/collections" label="Consulting" /> });
    const link = screen.getByRole("link", { name: "Back to Consulting" });
    expect(link).toHaveAttribute("href", "/workspace/wsp1/collections");
    expect(link).toHaveTextContent("Consulting");
    expect(link).toHaveClass("min-h-control-touch");
  });

  it("opens the search from its button", async () => {
    const user = userEvent.setup();
    renderHeader(0);
    await user.click(within(screen.getByRole("banner")).getByRole("button", { name: "Search everything" }));
    expect(await screen.findByRole("dialog", { name: "Search everything" })).toBeInTheDocument();
  });
});

describe("Home on a phone (NAV-8)", () => {
  /** The screen's own header (Home's body has a `header` of its own, so the banner role is not unique). */
  async function homeHeader(): Promise<HTMLElement> {
    const header = (await screen.findByRole("main")).querySelector("header")!;
    await within(header).findByRole("button", { name: /Acme|Household/ });
    return header;
  }
  async function home() {
    const api = routes();
    renderApp({ route: "/workspace/wsp1" });
    return { api, header: await homeHeader() };
  }

  it("holds the workspace switcher, the avatar and the search, and no menu button", async () => {
    const { header } = await home();
    expect(within(header).getByRole("button", { name: /Acme/ })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: /^Account menu/ })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Search everything" })).toBeInTheDocument();
    expect(within(header).queryByRole("button", { name: "Show menu" })).not.toBeInTheDocument();
  });

  it("opens the switcher as a sheet: the brand, every workspace with a check on this one, and New workspace", async () => {
    const user = userEvent.setup();
    const { header } = await home();
    await user.click(await within(header).findByRole("button", { name: /Acme/ }));
    const sheet = await screen.findByRole("dialog", { name: "Switch workspace" });
    expect(within(sheet).getByTestId("brand")).toBeInTheDocument();
    const list = within(sheet).getAllByRole("button").map((b) => b.textContent);
    expect(list).toEqual(expect.arrayContaining(["Acme", "Household", "New workspace"]));
    expect(within(sheet).getByRole("button", { name: "Acme" })).toHaveAttribute("aria-current", "true");
    expect(within(sheet).getByRole("button", { name: "Household" })).not.toHaveAttribute("aria-current");
    // The open workspace's own actions, as in the desktop menu.
    for (const name of ["Rename", "Color", "Invite people", "Delete"]) expect(within(sheet).getByRole("button", { name })).toBeInTheDocument();
    for (const name of ["Members", "Settings", "History", "Trash"]) expect(within(sheet).getByRole("link", { name })).toBeInTheDocument();
    // Every tap target is 44 px.
    for (const el of within(sheet).getAllByRole("button").filter((b) => b.textContent !== "Done")) expect(el).toHaveClass("min-h-control-touch");
  });

  it("goes to another workspace's Home and closes the sheet", async () => {
    const user = userEvent.setup();
    const { header } = await home();
    await user.click(await within(header).findByRole("button", { name: /Acme/ }));
    await user.click(await screen.findByRole("button", { name: "Household" }));
    // Household's Home names it in the header, and the sheet is gone.
    await waitFor(() => expect(within(header).getByRole("button", { name: /Household/ })).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Switch workspace" })).not.toBeInTheDocument());
  });

  it("gives a non-owner the pages and nothing that changes the workspace", async () => {
    const user = userEvent.setup();
    routes({ "GET /api/workspaces": [workspace({ role: "editor" })] });
    renderApp({ route: "/workspace/wsp1" });
    await user.click(await within(await homeHeader()).findByRole("button", { name: /Acme/ }));
    const sheet = await screen.findByRole("dialog", { name: "Switch workspace" });
    expect(within(sheet).queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "Members" })).toBeInTheDocument();
  });

  it("opens the profile menu as a sheet from the avatar, with the same actions as the desktop menu", async () => {
    const user = userEvent.setup();
    const { header } = await home();
    await user.click(await within(header).findByRole("button", { name: /^Account menu/ }));
    const sheet = await screen.findByRole("dialog", { name: "Account" });
    expect(within(sheet).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(sheet).getByText("ada@example.com")).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/account");
    expect(within(sheet).getByRole("link", { name: "Connect an assistant" })).toHaveAttribute("href", "/account?tab=assistants");
    expect(within(sheet).getByRole("button", { name: "Replay the intro" })).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "Send feedback" })).toHaveAttribute("target", "_blank");
    expect(within(sheet).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("link", { name: "Administration" })).not.toBeInTheDocument();
    expect(within(sheet).getByRole("radiogroup", { name: "Color" })).toBeInTheDocument();
  });

  it("offers administration to administrators, and keeps the sheet open while the theme is tried", async () => {
    const user = userEvent.setup();
    routes({ "GET /api/auth/me": ADMIN });
    renderApp({ route: "/workspace/wsp1" });
    await user.click(await within(await homeHeader()).findByRole("button", { name: /^Account menu/ }));
    const sheet = await screen.findByRole("dialog", { name: "Account" });
    expect(within(sheet).getByRole("link", { name: "Administration" })).toHaveAttribute("href", "/admin");
    await user.click(within(sheet).getByRole("button", { name: "Dark" }));
    expect(within(sheet).getByRole("button", { name: "Dark" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("dialog", { name: "Account" })).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "System" }));
  });

  it("signs out from the sheet", async () => {
    const user = userEvent.setup();
    const { api, header } = await home();
    await user.click(await within(header).findByRole("button", { name: /^Account menu/ }));
    await user.click(within(await screen.findByRole("dialog", { name: "Account" })).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(api.callsTo("POST /api/auth/logout")).toHaveLength(1));
  });

  it("closes the profile sheet with Escape and gives the avatar its focus back", async () => {
    const user = userEvent.setup();
    const { header } = await home();
    const avatar = await within(header).findByRole("button", { name: /^Account menu/ });
    await user.click(avatar);
    await screen.findByRole("dialog", { name: "Account" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Account" })).not.toBeInTheDocument());
    expect(avatar).toHaveFocus();
  });
});

describe("the Collections tab (NAV-7)", () => {
  async function open() {
    const api = routes();
    renderApp({ route: "/workspace/wsp1/collections" });
    const main = await screen.findByRole("main");
    await within(main).findByRole("list", { name: "Collections" });
    return { api, main };
  }

  it("holds the switcher, the collections and folders, and the footer links, under a header with the title and the search", async () => {
    const { main } = await open();
    const header = within(main).getByRole("banner");
    expect(within(header).getByRole("heading", { level: 1, name: "Collections" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Search everything" })).toBeInTheDocument();
    expect(within(header).queryByRole("button", { name: "Show menu" })).not.toBeInTheDocument();
    expect(within(main).getByRole("button", { name: /^Acme/ })).toBeInTheDocument();
    const top = within(main).getByRole("list", { name: "Collections" });
    expect(within(top).getByRole("link", { name: /^Tasks/ })).toHaveAttribute("href", expect.stringContaining("/base/app0/tbl1"));
    expect(within(top).getByRole("link", { name: /^Clients/ })).toBeInTheDocument();
    expect(await within(main).findByRole("list", { name: "Collections in Consulting" })).toBeInTheDocument();
    expect(within(main).getByRole("link", { name: "History" })).toHaveAttribute("href", "/history?workspace=wsp1");
    expect(within(main).getByRole("link", { name: "Trash" })).toHaveAttribute("href", "/trash?workspace=wsp1");
    expect(within(main).getByRole("link", { name: "Workspace settings" })).toHaveAttribute("href", "/workspace/wsp1/settings");
    expect(within(main).getByRole("link", { name: "Automations" })).toHaveAttribute("href", "/workspace/wsp1/automations");
    expect(within(main).getByRole("button", { name: /^Account menu/ })).toBeInTheDocument();
  });

  it("leaves out what the bar and the header already have: Home, Notifications and the search row", async () => {
    const { main } = await open();
    expect(within(main).queryByRole("link", { name: "Home" })).not.toBeInTheDocument();
    expect(within(main).queryByRole("link", { name: /^Notifications/ })).not.toBeInTheDocument();
    expect(within(main).queryByText("Search everything")).not.toBeInTheDocument();
  });

  it("opens the switcher as a sheet, and the account row as the profile sheet", async () => {
    const user = userEvent.setup();
    const { main } = await open();
    await user.click(within(main).getByRole("button", { name: /^Acme/ }));
    expect(await screen.findByRole("dialog", { name: "Switch workspace" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Switch workspace" })).not.toBeInTheDocument());
    await user.click(within(main).getByRole("button", { name: /^Account menu/ }));
    expect(await screen.findByRole("dialog", { name: "Account" })).toBeInTheDocument();
  });

  it("is a 44 px row everywhere", async () => {
    const { main } = await open();
    const top = within(main).getByRole("list", { name: "Collections" });
    expect(within(top).getByRole("link", { name: /^Tasks/ })).toHaveClass("max-md:h-control-touch");
    for (const name of ["History", "Trash"]) expect(within(main).getByRole("link", { name })).toHaveClass("max-md:h-control-touch");
  });

  it("opens a collection from its row, and the bar follows", async () => {
    const user = userEvent.setup();
    const { main } = await open();
    await user.click(within(within(main).getByRole("list", { name: "Collections" })).getByRole("link", { name: /^Tasks/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();
    expect(within(await tabs()).getByRole("link", { name: "Collections" })).toHaveAttribute("aria-current", "page");
  });

  it("opens a collection's row menu as a bottom sheet named for it, whose rows act and close it", async () => {
    const user = userEvent.setup();
    const { main } = await open();
    const more = await within(main).findByRole("button", { name: "Collection options for Tasks" });
    expect(more).toHaveAttribute("aria-haspopup", "dialog");
    await user.click(more);
    // A sheet, not a popover.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const sheet = await screen.findByRole("dialog", { name: "Tasks" });
    expect(within(sheet).getAllByRole("button").map((b) => b.textContent)).toEqual(expect.arrayContaining(["Rename", "Color", "Duplicate", "Import CSV", "Move up", "Move down", "Delete"]));
    await user.click(within(sheet).getByRole("button", { name: "Rename" }));
    expect(await screen.findByRole("dialog", { name: "Rename collection" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Tasks" })).not.toBeInTheDocument();
  });

  it("opens a folder's menu as a sheet too, with its links as links", async () => {
    const user = userEvent.setup();
    const { main } = await open();
    await user.click(await within(main).findByRole("button", { name: "Folder options for Consulting" }));
    const sheet = await screen.findByRole("dialog", { name: "Consulting" });
    expect(within(sheet).getByRole("link", { name: "Automations" })).toHaveAttribute("href", "/base/app1/automations");
    expect(within(sheet).getByRole("link", { name: "Access" })).toHaveAttribute("href", "/workspace/wsp1/members");
  });

  it("opens the + beside Collections as a sheet, and Escape closes it", async () => {
    const user = userEvent.setup();
    const { main } = await open();
    await user.click(within(main).getByRole("button", { name: "Add a collection or folder" }));
    const sheet = await screen.findByRole("dialog", { name: "Add" });
    expect(within(sheet).getAllByRole("button").map((b) => b.textContent)).toEqual(expect.arrayContaining(["New collection", "New collection from CSV", "New folder"]));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add" })).not.toBeInTheDocument());
  });

  it("follows the workspace's live stream (BE-9)", async () => {
    const urls: string[] = [];
    class Stream {
      onopen = null;
      onerror = null;
      constructor(url: string) {
        urls.push(url);
      }
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal("EventSource", Stream);
    await open();
    expect(urls).toContain("/api/workspaces/wsp1/events");
  });

  it("shows Automations only to creators", async () => {
    routes({ "GET /api/workspaces": [workspace({ role: "editor" })] });
    renderApp({ route: "/workspace/wsp1/collections" });
    const main = await screen.findByRole("main");
    await within(main).findByRole("list", { name: "Collections" });
    expect(within(main).queryByRole("link", { name: "Automations" })).not.toBeInTheDocument();
    expect(within(main).queryByRole("link", { name: "Workspace settings" })).not.toBeInTheDocument();
  });
});

describe("the Notifications screen (PH-1)", () => {
  const now = Date.now();
  const listing = {
    unread: 2,
    notifications: [
      { id: "n1", kind: "mention", payload: { base_id: "app0", table_id: "tbl2", table_name: "Clients", record_id: "rec1", record_name: "Launch plan", snippet: "please review", author_name: "Grace" }, read_at: null, created_at: now - 3600_000 },
      { id: "n2", kind: "automation", payload: { message: "Weekly digest sent" }, read_at: now, created_at: now - 2 * 86400_000 },
    ],
  };

  it("lists the notifications with Mark all read at the top, and the tab bar below", async () => {
    const user = userEvent.setup();
    const api = routes({ "GET /api/notifications": listing, "POST /api/notifications/read": { ok: true } });
    renderApp({ route: "/notifications" });
    const main = await screen.findByRole("main");
    expect(within(main).getByRole("heading", { level: 1, name: "Notifications" })).toBeInTheDocument();
    const list = await within(main).findByRole("list", { name: "Notifications" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // Avatar, one sentence, a chip for the record, and the time.
    expect(within(rows[0]!).getByRole("img", { name: "Grace", hidden: true })).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Grace mentioned you in Launch plan")).toBeInTheDocument();
    expect(within(rows[0]!).getByRole("button", { name: "Launch plan" })).toBeInTheDocument();
    expect(within(rows[0]!).getByText("1 hour ago")).toBeInTheDocument();
    // The top of the screen, before the first row.
    const markAll = within(main).getByRole("button", { name: "Mark all read" });
    expect(markAll.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(markAll).toHaveClass("max-md:min-h-control-touch");
    await user.click(markAll);
    await waitFor(() => expect(api.callsTo("POST /api/notifications/read")).toHaveLength(1));
    expect(within(await tabs()).getByRole("link", { name: /^Notifications/ })).toHaveAttribute("aria-current", "page");
  });

  it("opens the record from its chip and from the sentence, marking the notification read", async () => {
    const user = userEvent.setup();
    const api = routes({ "GET /api/notifications": listing, "POST /api/notifications/read": { ok: true } });
    renderApp({ route: "/notifications" });
    const list = await screen.findByRole("list", { name: "Notifications" });
    await user.click(within(list).getByRole("button", { name: "Launch plan" }));
    await waitFor(() => expect(api.callsTo("POST /api/notifications/read")[0]?.body).toEqual({ ids: ["n1"] }));
  });

  it("says when there is nothing, and disables Mark all read", async () => {
    routes();
    renderApp({ route: "/notifications" });
    expect(await screen.findByText("Nothing yet. Mentions, assignments and automation alerts will show up here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled();
  });

  it("counts the unread ones in a polite status line", async () => {
    routes({ "GET /api/notifications": listing });
    renderApp({ route: "/notifications" });
    expect((await screen.findByText("2 unread")).closest("[role=status]")).not.toBeNull();
  });
});

describe("other screens on a phone", () => {
  it("name the screen they came from in a back link: Collections from a workspace page, Home from the account", async () => {
    routes();
    const first = renderApp({ route: "/workspace/wsp1/members" });
    expect(await screen.findByRole("link", { name: "Back to Collections" })).toHaveAttribute("href", "/workspace/wsp1/collections");
    first.unmount();
    renderApp({ route: "/account" });
    expect(await screen.findByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/");
  });

  it("have no menu button and no drawer", async () => {
    routes();
    renderApp({ route: "/workspace/wsp1/members" });
    await screen.findByRole("link", { name: "Back to Collections" });
    expect(screen.queryByRole("button", { name: /Show menu|Hide menu/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument();
  });

  it("keep their folder-making tools: the + beside Collections is still on the Collections tab", async () => {
    routes();
    renderApp({ route: "/workspace/wsp1/collections" });
    const main = await screen.findByRole("main");
    expect(await within(main).findByRole("button", { name: "Add a collection or folder" })).toBeInTheDocument();
  });
});
