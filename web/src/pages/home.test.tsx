import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "@/api/types";
import { ADMIN, USER, mockApi, renderApp } from "@/test/utils";

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
