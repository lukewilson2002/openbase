import { Route, Routes } from "react-router";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BasePerson } from "@/api/types";
import { IntroProvider } from "@/onboarding/IntroContext";
import { ADMIN, USER, mockApi, renderWithProviders, stubDesktop } from "@/test/utils";
import { AppShell } from "./AppShell";
import { accentClass, personColors } from "@/lib/colors";
import { BaseAvatars } from "./BaseAvatars";
import { HomeShell } from "./HomeShell";
import { ScreenHeader } from "./ScreenHeader";
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
            <AppShell>
              <ScreenHeader title="Page title" />
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
    expect(within(menu).getByRole("link", { name: "Home" })).toBeInTheDocument();
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

  it("starts the sidebar with Home, then Notifications and its unread count", async () => {
    stubDesktop();
    mockApi({ "GET /api/auth/me": USER, "GET /api/notifications": { notifications: [], unread: 3 } });
    renderWithProviders(<Shell />, "/workspace/wsp1");
    const menu = screen.getByRole("navigation", { name: "Main menu" });
    // Without a workspace of its own the shell's Home is wherever `/` leads (the last workspace's Home).
    const home = within(menu).getByRole("link", { name: "Home" });
    expect(home).toHaveAttribute("href", "/");
    expect(within(menu).queryByRole("link", { name: "Inbox" })).not.toBeInTheDocument();
    const notifications = await within(menu).findByRole("button", { name: "Notifications, 3 unread" });
    expect(notifications).toHaveTextContent("3");
    expect(home.compareDocumentPosition(notifications) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks Home as the page being shown at /", () => {
    stubDesktop();
    routes();
    renderWithProviders(<Shell />, "/");
    expect(within(screen.getByRole("navigation", { name: "Main menu" })).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  });

  it("folds the sidebar with Ctrl+\\ and brings it back, keeping the choice on this device", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderWithProviders(<Shell />);
    expect(screen.getByRole("navigation", { name: "Main menu" })).toBeInTheDocument();
    await user.keyboard("{Control>}\\{/Control}");
    expect(screen.queryByRole("navigation", { name: "Main menu" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(SIDEBAR_KEY)!)).toMatchObject({ collapsed: true });
    await user.keyboard("{Control>}\\{/Control}");
    expect(screen.getByRole("navigation", { name: "Main menu" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(SIDEBAR_KEY)!)).toMatchObject({ collapsed: false });
    // The toggle says so.
    expect(screen.getByRole("button", { name: "Hide menu" })).toHaveAttribute("aria-keyshortcuts", "Control+Backslash Meta+Backslash");
  });

  it("keeps the keyboard's place when folding the sidebar from inside it: focus goes to the header's toggle", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderWithProviders(<Shell />);
    const home = within(screen.getByRole("navigation", { name: "Main menu" })).getByRole("link", { name: "Home" });
    home.focus();
    await user.keyboard("{Control>}\\{/Control}");
    expect(screen.queryByRole("navigation", { name: "Main menu" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show menu" })).toHaveFocus();
  });

  it("ignores unreadable storage", () => {
    stubDesktop();
    localStorage.setItem(SIDEBAR_KEY, "{not json");
    routes();
    renderWithProviders(<Shell />);
    expect(screen.getByRole("separator", { name: "Resize menu" })).toHaveAttribute("aria-valuenow", "256");
  });
});

describe("ProfileMenu", () => {
  it("offers the account settings, an assistant, the intro, the theme and signing out", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes();
    renderWithProviders(<Shell />);
    const trigger = await screen.findByRole("button", { name: "Account menu" });
    // The avatar and the name (NAV-1); the address is in the account settings.
    expect(trigger).toHaveTextContent("Ada Lovelace");
    expect(trigger).not.toHaveTextContent("ada@example.com");
    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Settings", "Connect an assistant", "Replay the intro", "Send feedback", "Appearance: System", "Sign out"]);
    // Every row leads with an icon, like the other menus.
    for (const item of within(menu).getAllByRole("menuitem")) expect(item.querySelector("svg[aria-hidden='true']"), item.textContent ?? "").not.toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Settings" })).toHaveAttribute("href", "/account");
    expect(within(menu).getByRole("menuitem", { name: "Connect an assistant" })).toHaveAttribute("href", "/account?tab=assistants");
    // Feedback goes to the project's GitHub Discussions, in a new tab.
    const feedback = within(menu).getByRole("menuitem", { name: "Send feedback" });
    expect(feedback).toHaveAttribute("href", "https://github.com/lukewilson2002/openbase/discussions");
    expect(feedback).toHaveAttribute("target", "_blank");
    expect(feedback).toHaveAttribute("rel", "noopener noreferrer");
    // The theme is one row that opens its choices, by keyboard as by pointer.
    within(menu).getByRole("menuitem", { name: "Appearance: System" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("menuitemradio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    expect(await screen.findByRole("menuitem", { name: "Appearance: Dark" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Replay the intro" }));
    expect(await screen.findByRole("dialog", { name: "Home catches your ideas" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip the intro" }));
    // Replaying never saves anything: the account had already seen it.
    expect(api.callsTo("PATCH /api/auth/me")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(api.callsTo("POST /api/auth/logout")).toHaveLength(1));
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
  });

  it("paints a picked accent colour at once and saves it on the account", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes();
    api.set("PATCH /api/auth/me", (call) => ({ ...USER, accent: (call.body as { accent: string }).accent || null }));
    renderWithProviders(<Shell />);
    await user.click(await screen.findByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Appearance: System" }));
    const colors = await screen.findByRole("group", { name: "Color" });
    expect(within(colors).getAllByRole("menuitemradio").map((s) => s.getAttribute("aria-label"))).toEqual(["Blue", "Cyan", "Teal", "Green", "Yellow", "Orange", "Red", "Pink", "Purple", "Gray"]);
    expect(within(colors).getByRole("menuitemradio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");

    // A click, not user.click: jsdom has no layout, so a pointer moving into the submenu closes it.
    fireEvent.click(within(colors).getByRole("menuitemradio", { name: "Teal" }));
    expect(document.documentElement).toHaveAttribute("data-accent", "teal");
    expect(localStorage.getItem("ob-accent")).toBe("teal");
    // The menu stays open to try another.
    expect(within(colors).getByRole("menuitemradio", { name: "Teal" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(api.callsTo("PATCH /api/auth/me").map((c) => c.body)).toEqual([{ accent: "teal" }]));

    // Blue, the default, is saved as no colour.
    fireEvent.click(within(colors).getByRole("menuitemradio", { name: "Blue" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/auth/me").map((c) => c.body)).toEqual([{ accent: "teal" }, { accent: "" }]));
    expect(document.documentElement).toHaveAttribute("data-accent", "blue");
  });

  it("goes back to the account's colour when saving one fails", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({ ...USER, accent: "purple" });
    api.set("PATCH /api/auth/me", { status: 500, json: { error: { code: "internal", message: "boom" } } });
    renderWithProviders(<Shell />);
    await user.click(await screen.findByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: /Appearance/ }));
    fireEvent.click(within(await screen.findByRole("group", { name: "Color" })).getByRole("menuitemradio", { name: "Red" }));
    expect(await screen.findByText("Could not save the colour")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-accent", "purple");
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
    // A count in plain text, not a bubble of its own.
    expect(container.querySelector("[data-away]")).not.toHaveClass("bg-subtle");
    expect(container.querySelector("[data-away]")).not.toHaveClass("rounded-full");
    expect(container.querySelector("[data-pending]")).toBeNull();
  });

  it("draws a face for each person viewing, you first, and +N for those who are not", async () => {
    routes();
    const { container } = renderWithProviders(<BaseAvatars people={[alex, me, jordan]} viewers={["usr2", "usr1"]} />);
    const group = await screen.findByRole("img", { name: "2 people viewing now, 1 more can open this project: you and Alex Kim" });
    expect(Array.from(container.querySelectorAll("[data-face] [role=img]")).map((f) => f.getAttribute("title"))).toEqual(["Ada Lovelace", "Alex Kim"]);
    expect(group).toHaveTextContent("+1");
  });

  it("gives another person the colour comments and cells give them (the base's assignment, not a second hash)", async () => {
    routes();
    const { container } = renderWithProviders(<BaseAvatars people={[me, alex]} viewers={["usr1", "usr2"]} />);
    await screen.findByRole("img", { name: "2 people viewing now: you and Alex Kim" });
    const face = container.querySelectorAll<HTMLElement>("[data-face] [role=img]")[1]!;
    const assigned = personColors([{ id: "usr1", name: me.name, email: me.email }, { id: "usr2", name: alex.name, email: alex.email }]).get("usr2")!;
    expect(face.className).toContain(accentClass(assigned, "solid"));
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

describe("HomeShell", () => {
  const project = (id: string, workspace_id: string, name: string, role: string) => ({ id, workspace_id, name, color: "blue", icon: null, role, people: [], tables: [], is_top_level: false });
  const acme = { id: "wsp1", name: "Acme", color: "green", icon: null, role: "owner", bases: [project("app1", "wsp1", "Chores", "owner")], member_count: 1, pending_invite_count: 0 };
  const club = { id: "wsp2", name: "Book club", color: "purple", icon: null, role: "editor", bases: [project("app2", "wsp2", "Reading list", "editor")], member_count: 3, pending_invite_count: 0 };

  function home(route = "/workspace/wsp1", props: { workspaceId?: string } = { workspaceId: "wsp1" }) {
    mockApi({
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
  }

  it("draws the screen's header inside main, with the search as a button in it and no bar across the app", async () => {
    stubDesktop();
    home();
    const main = screen.getByRole("main");
    expect([...document.querySelectorAll("header")].every((h) => h.closest("main"))).toBe(true);
    const header = main.querySelector("header")!;
    expect(within(header).getByRole("button", { name: "Hide menu" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Search everything" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Search everything" })).not.toBeInTheDocument();
  });
});
