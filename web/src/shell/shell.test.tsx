import { Route, Routes } from "react-router";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BasePerson } from "@/api/types";
import { IntroProvider } from "@/onboarding/IntroContext";
import { ADMIN, USER, mockApi, renderWithProviders, stubDesktop } from "@/test/utils";
import { AppShell } from "./AppShell";
import { BaseAvatars, peopleSummary } from "./BaseAvatars";
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
  it("offers the account pages, the intro, the theme and logging out", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes();
    renderWithProviders(<Shell />);
    const trigger = await screen.findByRole("button", { name: "Account menu" });
    expect(trigger).toHaveTextContent("Ada Lovelace");
    expect(trigger).toHaveTextContent("ada@example.com");
    await user.click(trigger);
    expect(await screen.findByRole("menuitem", { name: "Account settings" })).toHaveAttribute("href", "/account");
    expect(screen.getByRole("menuitem", { name: "Connect an assistant" })).toHaveAttribute("href", "/account?tab=assistants");
    expect(screen.getByRole("menuitemradio", { name: "System" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Dark" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Administration" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Replay the intro" }));
    expect(await screen.findByRole("dialog", { name: "A base holds one project" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip the intro" }));
    // Replaying never saves anything: the account had already seen it.
    expect(api.callsTo("PATCH /api/auth/me")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Log out" }));
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
});
