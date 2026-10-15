import { Route, Routes } from "react-router";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BasePerson } from "@/api/types";
import { IntroProvider } from "@/onboarding/IntroContext";
import { ADMIN, USER, mockApi, renderWithProviders, stubDesktop } from "@/test/utils";
import { AppShell } from "./AppShell";
import { BaseAvatars, peopleSummary } from "./BaseAvatars";
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
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Settings", "Connect an assistant", "Replay the intro", "Appearance: System", "Sign out"]);
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
    expect(await screen.findByRole("dialog", { name: "A base holds one project" })).toBeInTheDocument();
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
    renderWithProviders(<BaseAvatars people={[me]} summary />);
    expect(await screen.findByText("Only you")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Who can open/ })).not.toBeInTheDocument();
  });

  it("names everyone, marks invites that are not accepted yet, and draws them dashed", async () => {
    routes();
    const { container } = renderWithProviders(<BaseAvatars people={[alex, me, jordan]} summary />);
    expect(await screen.findByRole("img", { name: "Who can open this base: you, Alex Kim, and jordan@example.com (invited, not joined yet)" })).toBeInTheDocument();
    expect(screen.getByText("You, Alex, jordan (invited)")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-pending]")).toHaveLength(1);
    expect(container.querySelector("[data-pending]")).toHaveClass("border-dashed");
  });

  it("shows at most four circles: three faces, then +N", async () => {
    routes();
    const many = ["b", "c", "d", "e", "f"].map((x, i): BasePerson => ({ user_id: `u${i}`, name: `${x.toUpperCase()} Person`, email: `${x}@example.com`, pending: false, role: "viewer" }));
    renderWithProviders(<BaseAvatars people={[me, ...many]} />);
    const group = await screen.findByRole("img", { name: /^Who can open this base: you, B Person/ });
    expect(group).toHaveTextContent("+3");
    expect(peopleSummary([me, ...many], "usr1")).toBe("You, B, C and 3 more");
  });

  it("stacks the leftmost face on top, each next one tucked under it", async () => {
    routes();
    const { container } = renderWithProviders(<BaseAvatars people={[me, alex, jordan]} />);
    await screen.findByRole("img", { name: /^Who can open this base/ });
    const faces = Array.from(container.querySelectorAll<HTMLElement>("[data-face], [data-pending]"));
    expect(faces).toHaveLength(3);
    const z = faces.map((f) => Number(f.style.zIndex));
    expect(z[0]).toBeGreaterThan(z[1]!);
    expect(z[1]).toBeGreaterThan(z[2]!);
  });
});

describe("HomeShell", () => {
  const acme = { id: "wsp1", name: "Acme", icon: null, role: "owner", bases: [], member_count: 1, pending_invite_count: 0 };
  const club = { id: "wsp2", name: "Book club", icon: null, role: "editor", bases: [], member_count: 3, pending_invite_count: 0 };

  function home(route = "/workspace/wsp1", props: { workspaceId?: string; section?: "bases" | "members" } = { workspaceId: "wsp1" }) {
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/notifications": { notifications: [], unread: 0 },
      "GET /api/workspaces": [acme, club],
      "GET /api/search": { results: [] },
    });
    renderWithProviders(
      <IntroProvider>
        <Routes>
          <Route
            path="*"
            element={
              <HomeShell {...props}>
                <p>Page body</p>
              </HomeShell>
            }
          />
        </Routes>
      </IntroProvider>,
      route,
    );
    return api;
  }

  it("lists the workspaces under a plain heading, the open one expanded into its pages", async () => {
    stubDesktop();
    home();
    const menu = screen.getByRole("navigation", { name: "Main menu" });
    const section = within(menu).getByRole("region", { name: "Workspaces" });
    expect(within(section).getByRole("heading", { name: "Workspaces" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "New workspace" })).toBeInTheDocument();
    expect(await within(section).findByRole("button", { name: "Collapse Acme" })).toHaveAttribute("aria-expanded", "true");
    const pages = within(section).getByRole("group", { name: "Acme" });
    expect(within(pages).getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Bases", "/workspace/wsp1"],
      ["Members", "/workspace/wsp1/members"],
      ["Trash", "/trash?workspace=wsp1"],
      ["Settings", "/workspace/wsp1/settings"],
    ]);
    expect(within(pages).getByRole("link", { name: "Bases" })).toHaveAttribute("aria-current", "page");
    expect(within(section).getByRole("button", { name: "Expand Book club" })).toHaveAttribute("aria-expanded", "false");
    // Each workspace has its solid colour tile.
    expect(within(section).getByRole("link", { name: "Acme" }).querySelector("[data-entity-tile]")).toHaveClass("ob-solid");
    // The menu ends with the Trash of everything; account settings moved into the profile menu.
    expect(within(menu).getAllByRole("link", { name: "Trash" }).at(-1)).toHaveAttribute("href", "/trash");
    expect(within(menu).getAllByRole("link", { name: "Settings" }).map((l) => l.getAttribute("href"))).toEqual(["/workspace/wsp1/settings"]);
  });

  it("opens and closes a workspace with its own chevron and remembers that on this device", async () => {
    stubDesktop();
    const user = userEvent.setup();
    home();
    await user.click(await screen.findByRole("button", { name: "Expand Book club" }));
    const club = screen.getByRole("group", { name: "Book club" });
    // Not an owner: no Settings.
    expect(within(club).getAllByRole("link").map((l) => l.textContent)).toEqual(["Bases", "Members", "Trash"]);
    await user.click(screen.getByRole("button", { name: "Collapse Acme" }));
    expect(screen.queryByRole("group", { name: "Acme" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("ob-workspaces-open")!)).toEqual({ wsp2: true, wsp1: false });
  });

  it("marks a workspace's Trash and the Trash of everything on the one Trash page", async () => {
    stubDesktop();
    home("/trash?workspace=wsp2", {});
    const club = await screen.findByRole("group", { name: "Book club" });
    expect(within(club).getByRole("link", { name: "Trash" })).toHaveAttribute("aria-current", "page");
    expect(within(screen.getByRole("navigation", { name: "Main menu" })).getAllByRole("link", { name: "Trash" }).at(-1)).toHaveAttribute("aria-current", "false");
  });

  it("puts Search everything in the middle of the top bar", async () => {
    stubDesktop();
    home();
    expect(within(screen.getByRole("banner")).getByRole("combobox", { name: "Search everything" })).toBeInTheDocument();
  });

  it("on a phone names the open workspace in the top bar, switching workspace from there", async () => {
    const user = userEvent.setup();
    home();
    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("button", { name: "Search everything" })).toBeInTheDocument();
    await user.click(await within(banner).findByRole("button", { name: "Workspace: Acme. Switch workspace" }));
    const menu = await screen.findByRole("menu", { name: "Workspaces" });
    expect(within(menu).getByRole("menuitemradio", { name: "Acme" })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: "Book club" })).toHaveAttribute("href", "/workspace/wsp2");
    await user.click(within(menu).getByRole("menuitem", { name: "New workspace" }));
    expect(await screen.findByRole("dialog", { name: "New workspace" })).toBeInTheDocument();
  });
});
