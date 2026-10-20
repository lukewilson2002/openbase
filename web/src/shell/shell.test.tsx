import { Route, Routes, useLocation } from "react-router";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BasePerson } from "@/api/types";
import { IntroProvider } from "@/onboarding/IntroContext";
import { ADMIN, USER, makeSchema, mockApi, renderWithProviders, stubDesktop } from "@/test/utils";
import { AppShell } from "./AppShell";
import { BaseAvatars } from "./BaseAvatars";
import { HomeShell } from "./HomeShell";
import { SidebarLink, SidebarSection } from "./Sidebar";
import { SIDEBAR_KEY } from "./sidebarPrefs";

afterEach(() => vi.unstubAllGlobals());

function routes(me = USER) {
  return mockApi({
    "GET /api/auth/me": me,
    "GET /api/notifications": { notifications: [], unread: 0 },
    "POST /api/auth/logout": { ok: true },
    "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false, public_url: "https://base.example.org", passkeys_enabled: true },
  });
}

function Shell() {
  return (
    <IntroProvider>
      <Routes>
        <Route
          path="*"
          element={
            <AppShell
              topBar={<span>Page title</span>}
              sidebar={
                <SidebarSection title="Workspaces">
                  <SidebarLink to="/workspace/wsp1">Acme</SidebarLink>
                </SidebarSection>
              }
            >
              <p>Page body</p>
            </AppShell>
          }
        />
        <Route path="/login" element={<h1>Log in</h1>} />
      </Routes>
    </IntroProvider>
  );
}

describe("AppShell on a desktop", () => {
  it("docks the menu with the profile at the bottom and collapses it with the corner toggle, remembering that", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    const { unmount } = renderWithProviders(<Shell />);
    const menu = screen.getByRole("navigation", { name: "Main menu" });
    expect(within(menu).getByRole("link", { name: "Acme" })).toBeInTheDocument();
    expect(await within(menu).findByRole("button", { name: "Account menu" })).toBeInTheDocument();
    expect(screen.getByText("Page title")).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "Hide menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle);
    expect(screen.queryByRole("navigation", { name: "Main menu" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show menu" })).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(localStorage.getItem(SIDEBAR_KEY)!)).toMatchObject({ collapsed: true });

    // A new page view starts collapsed.
    unmount();
    renderWithProviders(<Shell />);
    expect(screen.getByRole("button", { name: "Show menu" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main menu" })).not.toBeInTheDocument();
  });

  it("resizes with the keyboard within 200 to 400 px and remembers the width", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderWithProviders(<Shell />);
    const handle = screen.getByRole("separator", { name: "Resize menu" });
    expect(handle).toHaveAttribute("aria-valuenow", "256");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    handle.focus();
    await user.keyboard("{ArrowRight}");
    expect(handle).toHaveAttribute("aria-valuenow", "272");
    expect(screen.getByRole("navigation", { name: "Main menu" })).toHaveStyle({ width: "272px" });
    await user.keyboard("{End}{ArrowRight}");
    expect(handle).toHaveAttribute("aria-valuenow", "400");
    await user.keyboard("{Home}{ArrowLeft}");
    expect(handle).toHaveAttribute("aria-valuenow", "200");
    expect(JSON.parse(localStorage.getItem(SIDEBAR_KEY)!)).toEqual({ width: 200, collapsed: false });
  });

  it("starts the menu with the Inbox, a link to /, above Notifications and its unread count", async () => {
    stubDesktop();
    mockApi({ "GET /api/auth/me": USER, "GET /api/notifications": { notifications: [], unread: 3 } });
    renderWithProviders(<Shell />, "/workspace/wsp1");
    const menu = screen.getByRole("navigation", { name: "Main menu" });
    const inbox = within(menu).getByRole("link", { name: "Inbox" });
    expect(inbox).toHaveAttribute("href", "/");
    expect(inbox).not.toHaveAttribute("aria-current", "page");
    const notifications = await within(menu).findByRole("button", { name: "Notifications, 3 unread" });
    expect(notifications).toHaveTextContent("3");
    // Inbox first, Notifications under it, then the page's own menu.
    const order = [inbox, notifications, within(menu).getByRole("link", { name: "Acme" })];
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks the Inbox as the page being shown on /", () => {
    stubDesktop();
    routes();
    renderWithProviders(<Shell />, "/");
    expect(within(screen.getByRole("navigation", { name: "Main menu" })).getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
  });

  it("ignores unreadable storage", () => {
    stubDesktop();
    localStorage.setItem(SIDEBAR_KEY, "{not json");
    routes();
    renderWithProviders(<Shell />);
    expect(screen.getByRole("separator", { name: "Resize menu" })).toHaveAttribute("aria-valuenow", "256");
  });
});

describe("AppShell on a phone", () => {
  it("opens the menu as a drawer and closes it with the corner button, focus back on the toggle", async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<Shell />);
    expect(screen.queryByRole("navigation", { name: "Main menu" })).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Show menu" });
    await user.click(toggle);

    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    expect(within(drawer).getByRole("link", { name: "Acme" })).toBeInTheDocument();
    expect(await within(drawer).findByRole("button", { name: "Account menu" })).toBeInTheDocument();
    expect(drawer).toContainElement(document.activeElement as HTMLElement);

    await user.click(within(drawer).getByRole("button", { name: "Close menu" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Show menu" })).toHaveFocus();
  });

  it("closes the drawer on a tap on the Inbox even when the Inbox is already the page", async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<Shell />, "/");
    await user.click(screen.getByRole("button", { name: "Show menu" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Menu" })).getByRole("link", { name: "Inbox" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument());
  });

  it("closes the drawer with Escape and after following a link", async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<Shell />);
    await user.click(screen.getByRole("button", { name: "Show menu" }));
    await screen.findByRole("dialog", { name: "Menu" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Show menu" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Menu" })).getByRole("link", { name: "Acme" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument());
  });
});

describe("ProfileMenu", () => {
  it("offers the account settings, an assistant, the intro, the theme and signing out", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes();
    renderWithProviders(<Shell />);
    const trigger = await screen.findByRole("button", { name: "Account menu" });
    expect(trigger).toHaveTextContent("Ada Lovelace");
    expect(trigger).toHaveTextContent("ada@example.com");
    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Settings", "Connect an assistant", "Replay the intro", "Appearance: System", "Sign out"]);
    // Every row leads with an icon, like the other menus.
    for (const item of within(menu).getAllByRole("menuitem")) expect(item.querySelector("svg[aria-hidden='true']"), item.textContent ?? "").not.toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Settings" })).toHaveAttribute("href", "/account");
    expect(within(menu).getByRole("menuitem", { name: "Connect an assistant" })).toHaveAttribute("href", "/account?tab=assistants");
    // The theme is one row that opens its choices, by keyboard as by pointer.
    within(menu).getByRole("menuitem", { name: "Appearance: System" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("menuitemradio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    expect(await screen.findByRole("menuitem", { name: "Appearance: Dark" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Replay the intro" }));
    expect(await screen.findByRole("dialog", { name: "A project holds your tables" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip the intro" }));
    // Replaying never saves anything: the account had already seen it.
    expect(api.callsTo("PATCH /api/auth/me")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(api.callsTo("POST /api/auth/logout")).toHaveLength(1));
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
  });

  it("shows Administration to administrators", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes(ADMIN);
    renderWithProviders(<Shell />);
    await user.click(await screen.findByRole("button", { name: "Account menu" }));
    expect(await screen.findByRole("menuitem", { name: "Administration" })).toHaveAttribute("href", "/admin");
  });
});

describe("BaseAvatars", () => {
  const me: BasePerson = { user_id: "usr1", name: "Ada Lovelace", email: "ada@example.com", pending: false, role: "owner" };
  const alex: BasePerson = { user_id: "usr2", name: "Alex Kim", email: "alex@example.com", pending: false, role: "editor" };
  const jordan: BasePerson = { user_id: null, name: "jordan@example.com", email: "jordan@example.com", pending: true, role: "viewer" };

  it("says Only you when nobody else can open the base", async () => {
    routes();
    renderWithProviders(<BaseAvatars people={[me]} />);
    expect(await screen.findByText("Only you")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Who can open/ })).not.toBeInTheDocument();
  });

  it("shows you alone, and everyone else who can open the project as one +N, until others arrive", async () => {
    routes();
    const { container } = renderWithProviders(<BaseAvatars people={[alex, me, jordan]} />);
    const group = await screen.findByRole("img", { name: "1 person viewing now, 2 more can open this project: you" });
    expect(container.querySelectorAll("[data-face]")).toHaveLength(1);
    // The invite that is not accepted yet counts in the +N, with a name in its tooltip.
    expect(group).toHaveTextContent("+2");
    expect(container.querySelector("[data-away]")).toHaveAttribute("title", "Can open this project, not viewing now: Alex Kim and jordan@example.com (invited, not joined yet)");
    expect(container.querySelector("[data-away]")).toHaveClass("bg-subtle");
    expect(container.querySelector("[data-pending]")).toBeNull();
  });

  it("draws a face for each person viewing, you first, and +N for those who are not", async () => {
    routes();
    const { container } = renderWithProviders(<BaseAvatars people={[alex, me, jordan]} viewers={["usr2", "usr1"]} />);
    const group = await screen.findByRole("img", { name: "2 people viewing now, 1 more can open this project: you and Alex Kim" });
    expect(Array.from(container.querySelectorAll("[data-face] [role=img]")).map((f) => f.getAttribute("title"))).toEqual(["Ada Lovelace", "Alex Kim"]);
    expect(group).toHaveTextContent("+1");
  });

  it("has no +N when everyone who can open it is viewing", async () => {
    routes();
    renderWithProviders(<BaseAvatars people={[me, alex]} viewers={["usr1", "usr2"]} />);
    const group = await screen.findByRole("img", { name: "2 people viewing now: you and Alex Kim" });
    expect(group).not.toHaveTextContent("+");
  });

  it("ignores a viewer who is not among the people who can open it", async () => {
    routes();
    const { container } = renderWithProviders(<BaseAvatars people={[me, alex]} viewers={["usr9", "usr2"]} />);
    await screen.findByRole("img", { name: "2 people viewing now: you and Alex Kim" });
    expect(container.querySelectorAll("[data-face]")).toHaveLength(2);
  });

  it("draws at most max faces, and the rest of the viewers go in the +N", async () => {
    routes();
    const many = ["b", "c", "d", "e", "f"].map((x, i): BasePerson => ({ user_id: `u${i}`, name: `${x.toUpperCase()} Person`, email: `${x}@example.com`, pending: false, role: "viewer" }));
    const { container } = renderWithProviders(<BaseAvatars people={[me, ...many]} viewers={many.map((p) => p.user_id!)} max={3} />);
    const group = await screen.findByRole("img", { name: /^6 people viewing now: you, B Person/ });
    expect(container.querySelectorAll("[data-face]")).toHaveLength(3);
    expect(group).toHaveTextContent("+3");
  });

  it("stacks the leftmost face on top, each next one tucked under it", async () => {
    routes();
    const { container } = renderWithProviders(<BaseAvatars people={[me, alex]} viewers={["usr2"]} />);
    await screen.findByRole("img", { name: /^2 people viewing now/ });
    const faces = Array.from(container.querySelectorAll<HTMLElement>("[data-face]"));
    expect(faces).toHaveLength(2);
    expect(Number(faces[0]!.style.zIndex)).toBeGreaterThan(Number(faces[1]!.style.zIndex));
  });
});

/** Shows where the router is, so a test can see that expanding a row did not navigate. */
function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

describe("HomeShell", () => {
  const project = (id: string, workspace_id: string, name: string, role: string) => ({ id, workspace_id, name, color: "blue", icon: null, role, people: [], tables: [] });
  const acme = { id: "wsp1", name: "Acme", icon: null, role: "owner", bases: [project("app1", "wsp1", "Chores", "owner")], member_count: 1, pending_invite_count: 0 };
  const club = { id: "wsp2", name: "Book club", icon: null, role: "editor", bases: [project("app2", "wsp2", "Reading list", "editor")], member_count: 3, pending_invite_count: 0 };

  function home(route = "/workspace/wsp1", props: { workspaceId?: string } = { workspaceId: "wsp1" }, extra: Record<string, unknown> = {}) {
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/notifications": { notifications: [], unread: 0 },
      "GET /api/workspaces": [acme, club],
      "GET /api/search": { results: [] },
      ...extra,
    });
    renderWithProviders(
      <IntroProvider>
        <Routes>
          <Route
            path="*"
            element={
              <HomeShell {...props}>
                <p>Page body</p>
                <Where />
              </HomeShell>
            }
          />
        </Routes>
      </IntroProvider>,
      route,
    );
    return api;
  }
  const where = () => screen.getByTestId("where").textContent;

  it("lists the workspaces under a plain heading, the open one expanded into its projects", async () => {
    stubDesktop();
    const api = home();
    const menu = screen.getByRole("navigation", { name: "Main menu" });
    const section = within(menu).getByRole("region", { name: "Workspaces" });
    expect(within(section).getByRole("heading", { name: "Workspaces" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "New workspace" })).toBeInTheDocument();
    expect(await within(section).findByRole("button", { name: "Collapse Acme" })).toHaveAttribute("aria-expanded", "true");
    const projects = within(section).getByRole("list", { name: "Projects in Acme" });
    // A project's name only folds it: nothing in the list is a link until its tables show.
    expect(within(projects).getByRole("button", { name: "Chores" })).toBeInTheDocument();
    expect(within(projects).queryAllByRole("link")).toHaveLength(0);
    expect(within(section).getByRole("button", { name: "Expand Book club" })).toHaveAttribute("aria-expanded", "false");
    expect(within(section).queryByRole("list", { name: "Projects in Book club" })).not.toBeInTheDocument();
    // A project's tables are fetched when it is opened, not before.
    expect(api.callsTo("GET /api/bases/app1")).toHaveLength(0);
    // Each workspace has its solid colour tile.
    expect(within(section).getByRole("button", { name: "Acme" }).querySelector("[data-entity-tile]")).toHaveClass("ob-solid");
    // The menu ends with the History and the Trash of everything; the pages of a workspace are in its "…" menu.
    expect(within(menu).getAllByRole("link", { name: "History" }).at(-1)).toHaveAttribute("href", "/history");
    expect(within(menu).getAllByRole("link", { name: "Trash" }).at(-1)).toHaveAttribute("href", "/trash");
    expect(within(menu).queryByRole("link", { name: "Members" })).not.toBeInTheDocument();
  });

  it("opens and closes a workspace with its own chevron without navigating, and remembers that on this device", async () => {
    stubDesktop();
    const user = userEvent.setup();
    home();
    await user.click(await screen.findByRole("button", { name: "Expand Book club" }));
    const projects = screen.getByRole("list", { name: "Projects in Book club" });
    expect(within(projects).getByRole("button", { name: "Reading list" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Collapse Acme" }));
    expect(screen.queryByRole("list", { name: "Projects in Acme" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("ob-workspaces-open")!)).toEqual({ wsp2: true, wsp1: false });
    expect(where()).toBe("/workspace/wsp1");
  });

  it("folds a workspace on a tap of its name, without going to the project last opened in it", async () => {
    stubDesktop();
    const user = userEvent.setup();
    localStorage.setItem("ob-last-place", JSON.stringify({ tables: { tbl9: "viw9" }, projects: { app2: "tbl9" }, workspaces: { wsp2: "app2" } }));
    home();
    // Book club remembers its project, but its name is still only a fold, not a link there.
    const club = await screen.findByRole("button", { name: "Book club" });
    expect(screen.queryByRole("link", { name: "Book club" })).not.toBeInTheDocument();
    await user.click(club);
    expect(screen.getByRole("list", { name: "Projects in Book club" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Acme" }));
    expect(screen.queryByRole("list", { name: "Projects in Acme" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Acme" }));
    expect(screen.getByRole("list", { name: "Projects in Acme" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("ob-workspaces-open")!)).toEqual({ wsp2: true, wsp1: true });
    expect(where()).toBe("/workspace/wsp1");
  });

  it("loads a project's tables when a tap on its name unfolds it, without navigating", async () => {
    stubDesktop();
    const user = userEvent.setup();
    localStorage.setItem("ob-last-place", JSON.stringify({ tables: { tbl2: "viw4" }, projects: { app1: "tbl2" }, workspaces: {} }));
    const api = home("/workspace/wsp1", { workspaceId: "wsp1" }, { "GET /api/bases/app1": makeSchema("owner", { name: "Chores" }) });
    const chores = await screen.findByRole("button", { name: "Chores" });
    expect(screen.queryByRole("link", { name: "Chores" })).not.toBeInTheDocument();
    expect(api.callsTo("GET /api/bases/app1")).toHaveLength(0);
    await user.click(chores);
    const tables = await screen.findByRole("list", { name: "Tables in Chores" });
    // A table without a remembered view opens its first (BaseShell picks it); one with opens that.
    expect(within(tables).getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/base/app1/tbl1");
    expect(within(tables).getByRole("link", { name: "People" })).toHaveAttribute("href", "/base/app1/tbl2/viw4");
    expect(api.callsTo("GET /api/bases/app1")).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("ob-projects-open")!)).toEqual({ app1: true });
    expect(where()).toBe("/workspace/wsp1");
  });

  it("puts what the workspace page, the pickers and the footer offered into the row menus", async () => {
    stubDesktop();
    const user = userEvent.setup();
    home();
    await user.click(await screen.findByRole("button", { name: "Workspace options for Acme" }));
    let menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual([
      "New project",
      "Members",
      "Invite people…",
      "History",
      "Trash",
      "Settings",
      "Rename",
      "Change icon…",
      "Change color…",
      "Move up",
      "Move down",
      "Delete workspace",
    ]);
    expect(within(menu).getByRole("menuitem", { name: "Members" })).toHaveAttribute("href", "/workspace/wsp1/members");
    expect(within(menu).getByRole("menuitem", { name: "History" })).toHaveAttribute("href", "/history?workspace=wsp1");
    expect(within(menu).getByRole("menuitem", { name: "Trash" })).toHaveAttribute("href", "/trash?workspace=wsp1");
    expect(within(menu).getByRole("menuitem", { name: "Settings" })).toHaveAttribute("href", "/workspace/wsp1/settings");
    await user.keyboard("{Escape}");

    // An editor makes nothing here and has no settings.
    await user.click(screen.getByRole("button", { name: "Workspace options for Book club" }));
    menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Members", "History", "Trash", "Move up", "Move down"]);
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Project options for Chores" }));
    menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual([
      "Rename project",
      "Change icon…",
      "Change color…",
      "Duplicate project",
      "Share…",
      "Members",
      "History",
      "Trash",
      "Automations",
      "Delete project",
    ]);
    expect(within(menu).getByRole("menuitem", { name: "History" })).toHaveAttribute("href", "/history?base=app1");
    expect(within(menu).getByRole("menuitem", { name: "Trash" })).toHaveAttribute("href", "/trash?base=app1");
    expect(within(menu).getByRole("menuitem", { name: "Automations" })).toHaveAttribute("href", "/base/app1/automations");
  });

  it("gives an editor's project only its members", async () => {
    stubDesktop();
    const user = userEvent.setup();
    home("/workspace/wsp2", { workspaceId: "wsp2" });
    await user.click(await screen.findByRole("button", { name: "Project options for Reading list" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Members", "History"]);
  });

  it("makes a new project from the workspace menu, the dialog living outside the menu", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = home("/workspace/wsp1", { workspaceId: "wsp1" }, { "POST /api/workspaces/wsp1/bases": makeSchema("owner", { id: "app9", name: "Garden" }) });
    await user.click(await screen.findByRole("button", { name: "Workspace options for Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    await user.type(within(dialog).getByLabelText("Project name"), "Garden");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces/wsp1/bases")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces/wsp1/bases")[0]?.body).toEqual({ name: "Garden", empty: true });
    await waitFor(() => expect(where()).toBe("/base/app9"));
  });

  it("opens the workspace whose Trash is showing, and leaves the Trash of everything unmarked", async () => {
    stubDesktop();
    home("/trash?workspace=wsp2", {});
    expect(await screen.findByRole("list", { name: "Projects in Book club" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Main menu" })).getAllByRole("link", { name: "Trash" }).at(-1)).toHaveAttribute("aria-current", "false");
  });

  describe("reordering", () => {
    const labels = (prefix: string) => screen.getAllByRole("button", { name: new RegExp(`^${prefix} `) }).map((b) => b.getAttribute("aria-label")!.slice(prefix.length + 1));
    const move = async (user: ReturnType<typeof userEvent.setup>, button: string, item: "Move up" | "Move down") => {
      await user.click(screen.getByRole("button", { name: button }));
      await user.click(await screen.findByRole("menuitem", { name: item }));
    };
    /** Routes that keep the order a reorder call sent, like the server does (the id lists are whole groups). */
    const stateful = <T extends { id: string }>(initial: T[], key: string, path: string, update: (order: string[]) => void = () => {}) => {
      let list = initial;
      return {
        [`GET ${key}`]: () => list,
        [`POST ${path}`]: (call: { body: unknown }) => {
          const ids = (call.body as { ids: string[] }).ids;
          update(ids);
          list = ids.map((id) => list.find((x) => x.id === id)!);
          return { ok: true };
        },
      };
    };

    it("moves a workspace with its menu: the new order is sent, shown at once and kept", async () => {
      stubDesktop();
      const user = userEvent.setup();
      const api = home("/workspace/wsp1", { workspaceId: "wsp1" }, stateful([acme, club], "/api/workspaces", "/api/workspaces/reorder"));
      await screen.findByRole("button", { name: "Workspace options for Acme" });
      expect(labels("Workspace options for")).toEqual(["Acme", "Book club"]);

      // The first cannot move up.
      await user.click(screen.getByRole("button", { name: "Workspace options for Acme" }));
      expect(await screen.findByRole("menuitem", { name: "Move up" })).toHaveAttribute("aria-disabled", "true");
      await user.click(screen.getByRole("menuitem", { name: "Move down" }));
      await waitFor(() => expect(api.callsTo("POST /api/workspaces/reorder")).toHaveLength(1));
      expect(api.callsTo("POST /api/workspaces/reorder")[0]?.body).toEqual({ ids: ["wsp2", "wsp1"] });
      expect(labels("Workspace options for")).toEqual(["Book club", "Acme"]);
      // Still so once the lists are asked for again.
      await waitFor(() => expect(api.callsTo("GET /api/workspaces").length).toBeGreaterThan(1));
      expect(labels("Workspace options for")).toEqual(["Book club", "Acme"]);

      // Now the last: it cannot move down, and moving up puts them back.
      await user.click(screen.getByRole("button", { name: "Workspace options for Acme" }));
      expect(await screen.findByRole("menuitem", { name: "Move down" })).toHaveAttribute("aria-disabled", "true");
      await user.click(screen.getByRole("menuitem", { name: "Move up" }));
      await waitFor(() => expect(api.callsTo("POST /api/workspaces/reorder")).toHaveLength(2));
      expect(api.callsTo("POST /api/workspaces/reorder")[1]?.body).toEqual({ ids: ["wsp1", "wsp2"] });
      await waitFor(() => expect(labels("Workspace options for")).toEqual(["Acme", "Book club"]));
    });

    it("reorders by dragging a row, and the click that ends the drag neither folds it nor follows a link", async () => {
      stubDesktop();
      // jsdom has no layout: stack the rows by hand, 40px apart.
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        const rows = Array.from(document.querySelectorAll("li[data-sortable]"));
        const i = rows.indexOf(this as HTMLLIElement);
        const top = i < 0 ? 0 : i * 40;
        return { x: 0, y: top, left: 0, top, width: 200, height: 40, right: 200, bottom: top + 40, toJSON: () => ({}) } as DOMRect;
      });
      const api = home("/workspace/wsp1", { workspaceId: "wsp1" }, stateful([acme, club], "/api/workspaces", "/api/workspaces/reorder"));
      const handle = (await screen.findByRole("button", { name: "Acme" })).closest("[data-drag-handle]")!;
      expect(handle).not.toBeNull();
      const wasOpen = screen.getByRole("button", { name: "Collapse Acme" });
      expect(wasOpen).toBeInTheDocument();
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
      // The click a browser sends after the release (on the name, under the pointer) is swallowed,
      // default and all: on a table's or a view's link it would otherwise open the page.
      expect(fireEvent.click(screen.getByRole("button", { name: "Acme" }))).toBe(false);
      await waitFor(() => expect(api.callsTo("POST /api/workspaces/reorder")).toHaveLength(1));
      expect(api.callsTo("POST /api/workspaces/reorder")[0]?.body).toEqual({ ids: ["wsp2", "wsp1"] });
      expect(screen.getByRole("button", { name: "Collapse Acme" })).toHaveAttribute("aria-expanded", "true");
    });

    it("gives every workspace the menu items, whatever its role", async () => {
      stubDesktop();
      const user = userEvent.setup();
      home("/workspace/wsp2", { workspaceId: "wsp2" });
      await user.click(await screen.findByRole("button", { name: "Workspace options for Book club" }));
      const menu = await screen.findByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: "Move up" })).not.toHaveAttribute("aria-disabled");
      expect(within(menu).getByRole("menuitem", { name: "Move down" })).toHaveAttribute("aria-disabled", "true");
    });

    it("has nothing to move in a single workspace", async () => {
      stubDesktop();
      const user = userEvent.setup();
      home("/workspace/wsp1", { workspaceId: "wsp1" }, { "GET /api/workspaces": [acme] });
      await user.click(await screen.findByRole("button", { name: "Workspace options for Acme" }));
      const menu = await screen.findByRole("menu");
      expect(within(menu).queryByRole("menuitem", { name: /^Move/ })).not.toBeInTheDocument();
      expect(document.querySelector("[data-sortable]")).toBeNull();
    });

    it("puts the old order back and says so when the server refuses", async () => {
      stubDesktop();
      const user = userEvent.setup();
      const api = home("/workspace/wsp1", { workspaceId: "wsp1" }, { "POST /api/workspaces/reorder": { status: 500, json: { error: { code: "internal", message: "boom" } } } });
      await screen.findByRole("button", { name: "Workspace options for Acme" });
      await move(user, "Workspace options for Acme", "Move down");
      expect(await screen.findByText("Could not reorder the workspaces")).toBeInTheDocument();
      await waitFor(() => expect(labels("Workspace options for")).toEqual(["Acme", "Book club"]));
      expect(api.callsTo("POST /api/workspaces/reorder")).toHaveLength(1);
    });

    describe("projects", () => {
      const chores = project("app1", "wsp1", "Chores", "owner");
      const garden = project("app3", "wsp1", "Garden", "owner");
      const wsp = (role: string, bases = [chores, garden]) => ({ ...acme, role, bases: bases.map((b) => ({ ...b, role })) });

      it("moves a project within its workspace for those who may edit projects", async () => {
        stubDesktop();
        const user = userEvent.setup();
        let list = [wsp("owner"), club];
        const api = home("/workspace/wsp1", { workspaceId: "wsp1" }, {
          "GET /api/workspaces": () => list,
          "POST /api/workspaces/wsp1/bases/reorder": (call: { body: unknown }) => {
            const ids = (call.body as { ids: string[] }).ids;
            list = list.map((w) => (w.id === "wsp1" ? { ...w, bases: ids.map((id) => w.bases.find((b) => b.id === id)!) } : w));
            return { ok: true };
          },
        });
        await screen.findByRole("button", { name: "Project options for Chores" });
        expect(labels("Project options for")).toEqual(["Chores", "Garden"]);
        await move(user, "Project options for Chores", "Move down");
        await waitFor(() => expect(api.callsTo("POST /api/workspaces/wsp1/bases/reorder")).toHaveLength(1));
        expect(api.callsTo("POST /api/workspaces/wsp1/bases/reorder")[0]?.body).toEqual({ ids: ["app3", "app1"] });
        await waitFor(() => expect(labels("Project options for")).toEqual(["Garden", "Chores"]));
        // Nothing was sent for the other workspace's project.
        expect(api.callsTo("POST /api/workspaces/wsp2/bases/reorder")).toHaveLength(0);
      });

      it("does not offer it to an editor, nor in a workspace with a single project", async () => {
        stubDesktop();
        const user = userEvent.setup();
        home("/workspace/wsp1", { workspaceId: "wsp1" }, { "GET /api/workspaces": [wsp("editor"), club] });
        await user.click(await screen.findByRole("button", { name: "Project options for Chores" }));
        expect(within(await screen.findByRole("menu")).queryByRole("menuitem", { name: /^Move/ })).not.toBeInTheDocument();
        await user.keyboard("{Escape}");
        // Only the workspaces are rows to move: the projects of an editor are not.
        const projects = screen.getByRole("list", { name: "Projects in Acme" });
        expect(projects.querySelector("[data-sortable]")).toBeNull();
        expect(screen.getAllByRole("button", { name: /^Workspace options for / })).toHaveLength(2);
      });
    });

    describe("tables and views", () => {
      const viewNames = (list: HTMLElement) => within(list).getAllByRole("link").map((a) => a.textContent);
      const setup = async (role = "owner", extra: Record<string, unknown> = {}) => {
        stubDesktop();
        const user = userEvent.setup();
        const s = makeSchema(role, { name: "Chores" });
        let current = s;
        const api = home("/workspace/wsp1", { workspaceId: "wsp1" }, {
          "GET /api/bases/app1": () => current,
          "POST /api/bases/app1/tables/reorder": (call: { body: unknown }) => {
            const ids = (call.body as { ids: string[] }).ids;
            current = { ...current, tables: ids.map((id) => current.tables.find((t) => t.id === id)!) };
            return { ok: true };
          },
          "POST /api/tables/tbl1/views/reorder": (call: { body: unknown }) => {
            const ids = (call.body as { ids: string[] }).ids;
            current = { ...current, tables: current.tables.map((t) => (t.id !== "tbl1" ? t : { ...t, views: ids.map((id) => t.views.find((v) => v.id === id)!).concat(t.views.filter((v) => !ids.includes(v.id))) })) };
            return { ok: true };
          },
          ...extra,
        });
        await user.click(await screen.findByRole("button", { name: "Chores" }));
        await screen.findByRole("list", { name: "Tables in Chores" });
        return { user, api };
      };
      const tableNames = () => within(screen.getByRole("list", { name: "Tables in Chores" })).getAllByRole("link").map((a) => a.textContent);

      it("moves a table in its project, in the menu and in the project's tables", async () => {
        const { user, api } = await setup();
        expect(tableNames()).toEqual(["Tasks", "People"]);
        await move(user, "Table options for Tasks", "Move down");
        await waitFor(() => expect(api.callsTo("POST /api/bases/app1/tables/reorder")).toHaveLength(1));
        expect(api.callsTo("POST /api/bases/app1/tables/reorder")[0]?.body).toEqual({ ids: ["tbl2", "tbl1"] });
        await waitFor(() => expect(tableNames()).toEqual(["People", "Tasks"]));
        await user.click(screen.getByRole("button", { name: "Table options for Tasks" }));
        expect(await screen.findByRole("menuitem", { name: "Move down" })).toHaveAttribute("aria-disabled", "true");
      });

      it("moves a shared view among the shared views only, and a lone personal view has no Move", async () => {
        const { user, api } = await setup();
        await user.click(screen.getByRole("button", { name: "Show views of Tasks" }));
        const shared = screen.getByRole("list", { name: "Shared views" });
        expect(viewNames(shared)).toEqual(["All tasks", "Board"]);
        await move(user, "Options for All tasks", "Move down");
        await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/views/reorder")).toHaveLength(1));
        // The personal view is not in the list sent, and neither is any default grid.
        expect(api.callsTo("POST /api/tables/tbl1/views/reorder")[0]?.body).toEqual({ ids: ["viw2", "viw1"] });
        await waitFor(() => expect(viewNames(screen.getByRole("list", { name: "Shared views" }))).toEqual(["Board", "All tasks"]));
        expect(viewNames(screen.getByRole("list", { name: "Personal views" }))).toEqual(["My tasks"]);

        await user.click(screen.getByRole("button", { name: "Options for My tasks" }));
        expect(within(await screen.findByRole("menu")).queryByRole("menuitem", { name: /^Move/ })).not.toBeInTheDocument();
      });

      it("adds the Move items to the view's own actions", async () => {
        const { user } = await setup();
        await user.click(screen.getByRole("button", { name: "Show views of Tasks" }));
        await user.click(screen.getByRole("button", { name: "Options for All tasks" }));
        // This is not the open project, so the dialogs' items (rename, share, delete) are not offered.
        expect(within(await screen.findByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Duplicate view", "Lock view", "Move up", "Move down"]);
      });

      it("makes rows draggable only where the person may reorder them", async () => {
        const { user } = await setup("editor");
        const tables = screen.getByRole("list", { name: "Tables in Chores" });
        // An editor cannot arrange tables or shared views.
        expect(tables.querySelector("[data-sortable]")).toBeNull();
        await user.click(screen.getByRole("button", { name: "Table options for Tasks" }));
        expect(within(await screen.findByRole("menu")).queryByRole("menuitem", { name: /^Move/ })).not.toBeInTheDocument();
        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Show views of Tasks" }));
        expect(screen.getByRole("list", { name: "Shared views" }).querySelector("[data-sortable]")).toBeNull();
      });

      it("keeps the rows the menu has of its own out of the sortable ones", async () => {
        await setup();
        const menu = screen.getByRole("navigation", { name: "Main menu" });
        // The sortable rows are the tree's: workspaces, projects, tables.
        const handles = Array.from(menu.querySelectorAll("[data-drag-handle]"));
        expect(handles.length).toBeGreaterThan(0);
        for (const name of ["Inbox", "History", "Trash", "Automations"]) {
          for (const link of within(menu).getAllByRole("link", { name })) expect(link.closest("[data-drag-handle]"), name).toBeNull();
        }
        expect(within(menu).getByRole("button", { name: /^Notifications/ }).closest("[data-drag-handle]")).toBeNull();
        expect(within(menu).getByRole("region", { name: "Workspaces" })).toContainElement(handles[0] as HTMLElement);
      });
    });
  });

  it("puts Search everything in the middle of the top bar", async () => {
    stubDesktop();
    home();
    expect(within(screen.getByRole("banner")).getByRole("combobox", { name: "Search everything" })).toBeInTheDocument();
  });

  it("on a phone names the open workspace in the top bar, and a tap on it opens the menu", async () => {
    const user = userEvent.setup();
    home();
    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("button", { name: "Search everything" })).toBeInTheDocument();
    await user.click(await within(banner).findByRole("button", { name: "Workspace: Acme. Show menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    expect(within(drawer).getByRole("button", { name: "Collapse Acme" })).toBeInTheDocument();
    // Folding a row in the drawer does not close it: only a navigation does.
    await user.click(within(drawer).getByRole("button", { name: "Expand Book club" }));
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeInTheDocument();
  });
});
