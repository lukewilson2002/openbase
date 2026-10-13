import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "@/api/types";
import { ADMIN, USER, apiError, mockApi, renderApp } from "@/test/utils";

afterEach(() => vi.unstubAllGlobals());

const workspaces: WorkspaceSummary[] = [
  {
    id: "wsp1",
    name: "Acme",
    role: "owner",
    bases: [
      { id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", role: "owner" },
      { id: "app2", workspace_id: "wsp1", name: "CRM", color: "blue", role: "owner" },
    ],
  },
  {
    id: "wsp2",
    name: "Shared with me",
    role: null,
    bases: [{ id: "app3", workspace_id: "wsp2", name: "Roadmap", color: "red", role: "viewer" }],
  },
  {
    id: "wsp3",
    name: "Read only space",
    role: "viewer",
    bases: [{ id: "app4", workspace_id: "wsp3", name: "Wiki", color: "gray", role: "viewer" }],
  },
];

describe("home", () => {
  it("lists workspaces with their bases as links", async () => {
    mockApi({ "GET /api/auth/me": USER, "GET /api/workspaces": workspaces });
    renderApp();

    expect(await screen.findByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Shared with me" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Project tracker" })).toHaveAttribute("href", "/base/app1");
    expect(screen.getByRole("link", { name: "CRM" })).toHaveAttribute("href", "/base/app2");
    expect(screen.getByRole("link", { name: "Roadmap" })).toHaveAttribute("href", "/base/app3");
  });

  it("shows an empty state when there are no workspaces", async () => {
    mockApi({ "GET /api/auth/me": USER, "GET /api/workspaces": [] });
    renderApp();
    expect(await screen.findByText("No workspaces yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create a workspace/ })).toBeInTheDocument();
  });

  it("hides actions the workspace role cannot perform", async () => {
    mockApi({ "GET /api/auth/me": USER, "GET /api/workspaces": workspaces });
    renderApp();
    await screen.findByRole("heading", { name: "Acme" });

    // Owner workspace: can add bases and open the workspace menu; the base menu is offered.
    const acme = screen.getByRole("heading", { name: "Acme" }).closest("section")!;
    expect(within(acme).getByRole("button", { name: /New base/ })).toBeInTheDocument();
    expect(within(acme).getByRole("button", { name: "Workspace actions for Acme" })).toBeInTheDocument();
    expect(within(acme).getByRole("button", { name: "Actions for CRM" })).toBeInTheDocument();

    // Viewer workspace: nothing to create or manage, but members can be viewed.
    const ro = screen.getByRole("heading", { name: "Read only space" }).closest("section")!;
    expect(within(ro).queryByRole("button", { name: /New base/ })).not.toBeInTheDocument();
    expect(within(ro).queryByRole("button", { name: "Actions for Wiki" })).not.toBeInTheDocument();
    expect(within(ro).getByRole("button", { name: "Workspace actions for Read only space" })).toBeInTheDocument();

    // Only individual bases shared: no workspace role at all, so no workspace menu.
    const shared = screen.getByRole("heading", { name: "Shared with me" }).closest("section")!;
    expect(within(shared).queryByRole("button", { name: /Workspace actions/ })).not.toBeInTheDocument();
    expect(within(shared).queryByRole("button", { name: /New base/ })).not.toBeInTheDocument();
  });

  it("only offers rename and delete of a workspace to its owner", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /api/auth/me": USER, "GET /api/workspaces": workspaces });
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Workspace actions for Read only space" }));
    expect(await screen.findByRole("menuitem", { name: "Members" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Delete workspace/ })).not.toBeInTheDocument();
  });

  it("offers deleted workspaces for restore and restores one", async () => {
    const user = userEvent.setup();
    let deleted = [{ kind: "workspace", id: "wspOld", name: "Old clients", table_id: null, deleted_at: Date.now() - 3 * 24 * 3600_000 }];
    let list: WorkspaceSummary[] = [];
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/workspaces": () => list,
      "GET /api/trash/workspaces": () => ({ items: deleted }),
      "POST /api/trash/restore": () => {
        deleted = [];
        list = [{ id: "wspOld", name: "Old clients", role: "owner", bases: [] }];
        return { ok: true, restored_field_ids: [] };
      },
    });
    renderApp();
    const section = (await screen.findByRole("heading", { name: "Recently deleted workspaces" })).closest("section")!;
    expect(within(section).getByText("Old clients")).toBeInTheDocument();
    expect(within(section).getByText("Deleted 3 days ago")).toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "Restore Old clients" }));
    await waitFor(() => expect(api.callsTo("POST /api/trash/restore")).toHaveLength(1));
    expect(api.callsTo("POST /api/trash/restore")[0]!.body).toEqual({ kind: "workspace", id: "wspOld" });
    // The workspace is back among the live ones and the section is gone.
    expect(await screen.findByRole("heading", { name: "Old clients" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Recently deleted workspaces" })).not.toBeInTheDocument());
  });

  it("shows no deleted-workspaces section when there are none or the list cannot be loaded", async () => {
    mockApi({ "GET /api/auth/me": USER, "GET /api/workspaces": workspaces, "GET /api/trash/workspaces": { items: [] } });
    const { unmount } = renderApp();
    await screen.findByRole("heading", { name: "Acme" });
    expect(screen.queryByRole("heading", { name: "Recently deleted workspaces" })).not.toBeInTheDocument();
    unmount();

    mockApi({ "GET /api/auth/me": USER, "GET /api/workspaces": workspaces, "GET /api/trash/workspaces": apiError(500, "internal", "boom") });
    renderApp();
    await screen.findByRole("heading", { name: "Acme" });
    expect(screen.queryByRole("heading", { name: "Recently deleted workspaces" })).not.toBeInTheDocument();
  });

  it("lists deleted workspaces even when no workspace is left", async () => {
    mockApi({
      "GET /api/auth/me": USER,
      "GET /api/workspaces": [],
      "GET /api/trash/workspaces": { items: [{ kind: "workspace", id: "wspOld", name: "Old clients", table_id: null, deleted_at: Date.now() - 60_000 }] },
    });
    renderApp();
    expect(await screen.findByText("No workspaces yet")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Restore Old clients" })).toBeInTheDocument();
  });

  it("creates a workspace through the dialog", async () => {
    const user = userEvent.setup();
    let list: WorkspaceSummary[] = [];
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/workspaces": () => list,
      "POST /api/workspaces": (call) => {
        list = [{ id: "wsp9", name: (call.body as { name: string }).name, role: "owner", bases: [] }];
        return list[0];
      },
    });
    renderApp();
    await user.click(await screen.findByRole("button", { name: /New workspace/ }));
    await user.type(await screen.findByLabelText("Name"), "Side projects");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(await screen.findByRole("heading", { name: "Side projects" })).toBeInTheDocument();
    expect(api.callsTo("POST /api/workspaces")[0]?.body).toEqual({ name: "Side projects" });
  });

  it("creates a base with a colour and opens it", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/workspaces": workspaces,
      "POST /api/workspaces/wsp1/bases": { id: "app9", workspace_id: "wsp1", name: "New one", color: "pink", role: "owner" },
    });
    renderApp();
    const acme = (await screen.findByRole("heading", { name: "Acme" })).closest("section")!;
    await user.click(within(acme).getByRole("button", { name: /New base/ }));
    await user.type(await screen.findByLabelText("Name"), "New one");
    await user.click(screen.getByRole("radio", { name: "Pink" }));
    await user.click(screen.getByRole("button", { name: "Create base" }));

    await waitFor(() => expect(api.callsTo("POST /api/workspaces/wsp1/bases")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces/wsp1/bases")[0]?.body).toEqual({ name: "New one", color: "pink" });
    await waitFor(() => expect(api.callsTo("GET /api/bases/app9").length).toBeGreaterThan(0));
  });

  it("deletes a base after confirmation", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/workspaces": workspaces,
      "DELETE /api/bases/app2": { status: 204 },
    });
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Actions for CRM" }));
    await user.click(await screen.findByRole("menuitem", { name: /Delete base/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Delete CRM/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete base" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/bases/app2")).toHaveLength(1));
    expect(api.callsTo("DELETE /api/bases/app2")[0]?.headers.get("X-OpenGrid-CSRF")).toBe("1");
  });

  it("opens the members dialog with role changes and invite creation for an owner", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/workspaces": workspaces,
      "GET /api/workspaces/wsp1/members": [
        { user_id: "usr1", name: "Ada Lovelace", email: "ada@example.com", role: "owner" },
        { user_id: "usr2", name: "Grace Hopper", email: "grace@example.com", role: "editor" },
      ],
      "GET /api/workspaces/wsp1/invites": [],
      "PATCH /api/workspaces/wsp1/members/usr2": { status: 204 },
      "POST /api/workspaces/wsp1/invites": {
        url: "https://og.example.com/invite/secrettoken",
        info: { id: "inv1", workspace_id: "wsp1", base_id: null, email: null, role: "editor", created_at: 1, expires_at: 2, accepted_at: null },
      },
    });
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Workspace actions for Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: /Members and invites/ }));
    const dialog = await screen.findByRole("dialog", { name: "Share Acme" });

    expect(await within(dialog).findByText("Grace Hopper")).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("Role for Grace Hopper"), "creator");
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1/members/usr2")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/workspaces/wsp1/members/usr2")[0]?.body).toEqual({ role: "creator" });

    await user.click(within(dialog).getByRole("button", { name: /Create invite link/ }));
    const link = await within(dialog).findByLabelText("Invite link");
    expect(link).toHaveValue("https://og.example.com/invite/secrettoken");
    expect(api.callsTo("POST /api/workspaces/wsp1/invites")[0]?.body).toEqual({ role: "editor", email: null });
  });

  it("shows the Administration entry in the user menu only to administrators", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /api/auth/me": ADMIN, "GET /api/workspaces": [] });
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Account menu" }));
    expect(await screen.findByRole("menuitem", { name: /Administration/ })).toBeInTheDocument();
  });

  it("hides the Administration entry from regular users", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /api/auth/me": USER, "GET /api/workspaces": [] });
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Account menu" }));
    expect(await screen.findByRole("menuitem", { name: /Account settings/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Administration/ })).not.toBeInTheDocument();
  });
});

describe("home icons", () => {
  const withIcons: WorkspaceSummary[] = [
    {
      id: "wsp1",
      name: "Acme",
      icon: "briefcase",
      role: "owner",
      bases: [
        { id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", icon: "truck", role: "owner" },
        { id: "app2", workspace_id: "wsp1", name: "CRM", color: "blue", role: "owner" },
      ],
    },
    { id: "wsp3", name: "Read only space", icon: "star", role: "viewer", bases: [{ id: "app4", workspace_id: "wsp3", name: "Wiki", color: "gray", icon: "folder", role: "viewer" }] },
  ];
  const tileOf = (el: HTMLElement) => el.querySelector("[data-entity-tile]")!;

  it("replaces the letters with the workspace and base icons, and keeps the letter without an icon", async () => {
    mockApi({ "GET /api/auth/me": USER, "GET /api/workspaces": withIcons });
    renderApp();
    const acme = (await screen.findByRole("heading", { name: "Acme" })).closest("section")!;
    expect(tileOf(acme)).toContainElement(acme.querySelector("svg.lucide-briefcase"));
    expect(tileOf(acme)).not.toHaveTextContent("A");
    const tracker = screen.getByRole("link", { name: "Project tracker" }).closest("li")!;
    expect(tileOf(tracker).querySelector("svg.lucide-truck")).toBeInTheDocument();
    expect(tileOf(tracker)).not.toHaveTextContent("P");
    const crm = screen.getByRole("link", { name: "CRM" }).closest("li")!;
    expect(tileOf(crm)).toHaveTextContent("C");
    expect(tileOf(crm).querySelector("svg")).toBeNull();
  });

  it("lets only the workspace owner change the workspace icon from its tile", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /api/auth/me": USER, "GET /api/workspaces": withIcons, "PATCH /api/workspaces/wsp1": { id: "wsp1", name: "Acme", role: "owner", bases: [] } });
    renderApp();
    const ro = (await screen.findByRole("heading", { name: "Read only space" })).closest("section")!;
    expect(within(ro).queryByRole("button", { name: /Change icon/ })).not.toBeInTheDocument();
    expect(ro.querySelector("svg.lucide-star")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Change icon of Acme" }));
    await user.click(await screen.findByRole("button", { name: "Heart" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/workspaces/wsp1")[0]?.body).toEqual({ icon: "heart" });
  });

  it("creates a workspace with an icon", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/workspaces": [],
      "POST /api/workspaces": { id: "wsp9", name: "Studio", icon: "store", role: "owner", bases: [] },
    });
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Create a workspace/ }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    await user.type(within(dialog).getByLabelText("Name"), "Studio");
    await user.click(within(dialog).getByRole("button", { name: "Choose icon" }));
    await user.click(await screen.findByRole("button", { name: "Store" }));
    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces")[0]?.body).toEqual({ name: "Studio", icon: "store" });
  });

  it("creates a base with an icon", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/workspaces": withIcons,
      "POST /api/workspaces/wsp1/bases": { id: "app9", workspace_id: "wsp1", name: "Fresh", color: "blue_dark", icon: "wallet", role: "owner" },
    });
    renderApp();
    const acme = (await screen.findByRole("heading", { name: "Acme" })).closest("section")!;
    await user.click(within(acme).getByRole("button", { name: /New base/ }));
    const dialog = await screen.findByRole("dialog", { name: "New base" });
    await user.type(within(dialog).getByLabelText("Name"), "Fresh");
    await user.click(within(dialog).getByRole("button", { name: "Choose icon" }));
    await user.click(await screen.findByRole("button", { name: "Wallet" }));
    await user.click(within(dialog).getByRole("button", { name: "Create base" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces/wsp1/bases")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces/wsp1/bases")[0]?.body).toEqual({ name: "Fresh", color: "blue_dark", icon: "wallet" });
  });

  it("edits a base: the icon is only sent when it changed", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /api/auth/me": USER, "GET /api/workspaces": withIcons, "PATCH /api/bases/app1": { status: 204 } });
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Actions for Project tracker" }));
    await user.click(await screen.findByRole("menuitem", { name: /Rename or recolour/ }));
    const dialog = await screen.findByRole("dialog", { name: "Edit base" });
    expect(within(dialog).getByRole("button", { name: "Change icon" })).toBeInTheDocument();
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Tracker");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/bases/app1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/bases/app1")[0]?.body).toEqual({ name: "Tracker", color: "green_dark" });
  });

  it("changes a base icon from the card menu, and offers viewers nothing", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /api/auth/me": USER, "GET /api/workspaces": withIcons, "PATCH /api/bases/app2": { status: 204 } });
    renderApp();
    await screen.findByRole("heading", { name: "Acme" });
    expect(screen.queryByRole("button", { name: "Actions for Wiki" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Actions for CRM" }));
    await user.click(await screen.findByRole("menuitem", { name: /Change icon/ }));
    const dialog = await screen.findByRole("dialog", { name: "Base icon" });
    await user.click(await within(dialog).findByRole("button", { name: "Users" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/bases/app2")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/bases/app2")[0]?.body).toEqual({ icon: "users" });
  });

  it("shows the icon of a deleted workspace in the recently deleted list", async () => {
    mockApi({
      "GET /api/auth/me": USER,
      "GET /api/workspaces": [],
      "GET /api/trash/workspaces": { items: [{ kind: "workspace", id: "wspOld", name: "Old clients", icon: "users", table_id: null, deleted_at: Date.now() - 60_000 }] },
    });
    renderApp();
    const section = (await screen.findByRole("heading", { name: "Recently deleted workspaces" })).closest("section")!;
    expect(section.querySelector("svg.lucide-users")).toBeInTheDocument();
  });
});
