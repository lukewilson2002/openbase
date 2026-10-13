import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GrantInfo } from "@/api/types";
import { ADMIN, USER, apiError, mockApi, renderApp } from "@/test/utils";

afterEach(() => vi.unstubAllGlobals());

const SETUP = { needs_setup: false, open_signup: false, email_enabled: false, public_url: "https://base.example.org" };
const NOW = 1_800_000_000_000;
const GRANTS: GrantInfo[] = [
  {
    id: "grt1",
    client_name: "Claude",
    client_source: "preregistered",
    redirect_host: "claude.ai",
    write: true,
    manage: false,
    bases: [
      { id: "app1", name: "CRM" },
      { id: "app2", name: "Notes" },
    ],
    created_at: NOW - 5 * 86_400_000,
    last_used_at: NOW - 3_600_000,
    expires_at: NOW + 20 * 86_400_000,
    user_email: null,
    user_name: null,
  },
  {
    id: "grt2",
    client_name: "Claude Code",
    client_source: "dcr",
    redirect_host: "127.0.0.1:53124",
    write: true,
    manage: true,
    bases: null,
    created_at: NOW - 86_400_000,
    last_used_at: null,
    expires_at: NOW + 29 * 86_400_000,
    user_email: null,
    user_name: null,
  },
  {
    id: "grt3",
    client_name: "Read Helper",
    client_source: "cimd",
    redirect_host: "helper.example.org",
    write: false,
    manage: false,
    bases: null,
    created_at: NOW - 86_400_000,
    last_used_at: null,
    expires_at: NOW + 29 * 86_400_000,
    user_email: null,
    user_name: null,
  },
];

describe("account: connected apps", () => {
  it("lists each app with its access, bases and where it connects from", async () => {
    mockApi({ "GET /api/auth/me": USER, "GET /api/setup": SETUP, "GET /api/tokens": [], "GET /api/oauth/grants": GRANTS });
    renderApp({ route: "/account?tab=assistants" });
    const list = await screen.findByRole("list", { name: "Connected apps" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);

    expect(items[0]).toHaveTextContent("Claude");
    expect(items[0]).toHaveTextContent("Read & edit");
    expect(items[0]).toHaveTextContent("Connects from claude.ai");
    expect(items[0]).toHaveTextContent("2 bases: CRM, Notes");
    expect(items[0]).toHaveTextContent(/last used/);

    expect(items[1]).toHaveTextContent("Claude Code");
    expect(items[1]).toHaveTextContent("Full control");
    expect(items[1]).toHaveTextContent("Connects from 127.0.0.1:53124");
    expect(items[1]).toHaveTextContent("all bases");
    expect(items[1]).toHaveTextContent("never used");

    expect(items[2]).toHaveTextContent("Read only");
  });

  it("shows an empty state when nothing is connected", async () => {
    mockApi({ "GET /api/auth/me": USER, "GET /api/setup": SETUP, "GET /api/tokens": [], "GET /api/oauth/grants": [] });
    renderApp({ route: "/account?tab=assistants" });
    expect(await screen.findByText("No connected apps yet.")).toBeInTheDocument();
  });

  it("revokes an app after confirmation and refreshes the list", async () => {
    const user = userEvent.setup();
    let grants = GRANTS;
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/setup": SETUP,
      "GET /api/tokens": [],
      "GET /api/oauth/grants": () => grants,
      "DELETE /api/oauth/grants/grt2": () => {
        grants = grants.filter((g) => g.id !== "grt2");
        return { status: 204 };
      },
    });
    renderApp({ route: "/account?tab=assistants" });
    await user.click(await screen.findByRole("button", { name: "Revoke Claude Code" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Revoke Claude Code?");
    expect(dialog).toHaveTextContent("stops working immediately");
    expect(api.callsTo("DELETE /api/oauth/grants/grt2")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Revoke access" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/oauth/grants/grt2")).toHaveLength(1));
    expect(api.callsTo("DELETE /api/oauth/grants/grt2")[0]?.headers.get("X-OpenBase-CSRF")).toBe("1");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Connected apps" })).queryByText("Claude Code")).not.toBeInTheDocument());
    expect(within(screen.getByRole("list", { name: "Connected apps" })).getByText("Claude")).toBeInTheDocument();
  });

  it("does not revoke when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /api/auth/me": USER, "GET /api/setup": SETUP, "GET /api/tokens": [], "GET /api/oauth/grants": GRANTS });
    renderApp({ route: "/account?tab=assistants" });
    await user.click(await screen.findByRole("button", { name: "Revoke Claude" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(api.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("shows the server's error when the list cannot be loaded", async () => {
    mockApi({ "GET /api/auth/me": USER, "GET /api/setup": SETUP, "GET /api/tokens": [], "GET /api/oauth/grants": apiError(500, "internal", "Something went wrong.") });
    renderApp({ route: "/account?tab=assistants" });
    expect(await screen.findByText("Something went wrong.")).toBeInTheDocument();
  });
});

describe("admin: connected apps", () => {
  const ALL: GrantInfo[] = GRANTS.map((g, i) => ({ ...g, user_email: i === 0 ? "ada@example.com" : "bob@example.com", user_name: i === 0 ? "Ada Lovelace" : "Bob" }));

  it("lists every user's apps and revokes one", async () => {
    const user = userEvent.setup();
    let grants = ALL;
    const api = mockApi({
      "GET /api/auth/me": ADMIN,
      "GET /api/admin/oauth/grants": () => grants,
      "DELETE /api/admin/oauth/grants/grt1": () => {
        grants = grants.filter((g) => g.id !== "grt1");
        return { status: 204 };
      },
    });
    renderApp({ route: "/admin?tab=apps" });
    const list = await screen.findByRole("list", { name: "Connected apps" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Ada Lovelace (ada@example.com)");
    expect(items[1]).toHaveTextContent("Bob (bob@example.com)");

    await user.click(screen.getByRole("button", { name: "Revoke Claude for ada@example.com" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("stops working immediately for ada@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Revoke access" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/admin/oauth/grants/grt1")).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Connected apps" })).getAllByRole("listitem")).toHaveLength(2));
  });

  it("is not reachable for regular users", async () => {
    const api = mockApi({ "GET /api/auth/me": USER });
    renderApp({ route: "/admin?tab=apps" });
    expect(await screen.findByText("Administrators only")).toBeInTheDocument();
    expect(api.callsTo("GET /api/admin/oauth/grants")).toHaveLength(0);
  });
});
