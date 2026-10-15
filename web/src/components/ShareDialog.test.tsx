import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShareLink, WorkspaceSummary } from "@/api/types";
import { USER, makeSchema, makeView, makeWorkspace, mockApi, renderWithProviders, type Handler } from "@/test/utils";
import { ShareDialog } from "./ShareDialog";

afterEach(() => vi.unstubAllGlobals());

const bases = [
  { id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", role: "owner", people: [], tables: [] },
  { id: "app2", workspace_id: "wsp1", name: "CRM", color: "blue", role: "owner", people: [], tables: [] },
];
const created = (over: object = {}) => ({
  url: "https://base.example.org/invite/tok",
  info: { id: "inv9", workspace_id: "wsp1", base_id: null, email: null, role: "editor", created_at: 1, expires_at: 2, accepted_at: null, all_bases: false, base_ids: ["app1"], ...over },
});

function routes(role: string, extra: Record<string, Handler> = {}) {
  const ws: WorkspaceSummary = { ...makeWorkspace(role, bases.map((b) => ({ ...b, role }))) };
  return mockApi({
    "GET /api/auth/me": USER,
    "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false, public_url: "https://base.example.org", passkeys_enabled: true },
    "GET /api/workspaces": [ws],
    "POST /api/bases/app1/invites": created(),
    "POST /api/workspaces/wsp1/invites": created({ all_bases: true, base_ids: [] }),
    ...extra,
  });
}

function fromBase(role: string) {
  const schema = makeSchema(role);
  const table = schema.tables[0]!;
  return renderWithProviders(<ShareDialog open onOpenChange={() => {}} scope="base" base={schema} workspaceName="Acme" table={table} view={table.views[1]} />);
}

describe("Share dialog: invite people", () => {
  it("from a base, picks that base and sends the invite to the base endpoint", async () => {
    const user = userEvent.setup();
    const api = routes("creator");
    fromBase("creator");
    const dialog = await screen.findByRole("dialog", { name: "Share Project tracker" });
    expect(within(dialog).getByText(/People you invite join the/)).toHaveTextContent("People you invite join the Acme workspace. Choose which of its bases they can open.");
    expect(within(dialog).getByRole("radio", { name: "Only the bases I pick" })).toBeChecked();
    expect(await within(dialog).findByRole("checkbox", { name: "Project tracker" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "CRM" })).not.toBeChecked();
    // A creator can neither open everything up nor make owners.
    expect(within(dialog).queryByRole("radio", { name: /All bases in Acme/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("option", { name: "Owner" })).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual(["Editor", "Commenter", "Viewer", "Creator"]);

    await user.type(within(dialog).getByLabelText("Email"), "jordan@example.com");
    await user.selectOptions(within(dialog).getByLabelText("Role"), "commenter");
    await user.click(within(dialog).getByRole("checkbox", { name: "CRM" }));
    await user.click(within(dialog).getByRole("button", { name: /Send invite/ }));
    await waitFor(() => expect(api.callsTo("POST /api/bases/app1/invites")).toHaveLength(1));
    expect(api.callsTo("POST /api/bases/app1/invites")[0]!.body).toEqual({ email: "jordan@example.com", role: "commenter", all_bases: false, base_ids: ["app1", "app2"] });
    expect(await within(dialog).findByLabelText("Invite link")).toHaveValue("https://base.example.org/invite/tok");
    expect(within(dialog).getByLabelText("Email")).toHaveValue("");
    expect(within(dialog).getByRole("link", { name: "Manage all members" })).toHaveAttribute("href", "/workspace/wsp1/members");
  });

  it.each(["viewer", "commenter", "editor"])("from a base, tells a %s whom to ask instead of showing the form", async (role) => {
    const api = routes(role);
    fromBase(role);
    const dialog = await screen.findByRole("dialog", { name: "Share Project tracker" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Only creators and owners can invite people. Ask one of them, or share a view.");
    expect(within(dialog).queryByRole("form", { name: "Invite people" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Send invite/ })).not.toBeInTheDocument();
    expect(api.callsTo("POST /api/bases/app1/invites")).toHaveLength(0);
  });

  it("will not send an invite to no base at all", async () => {
    const user = userEvent.setup();
    routes("creator");
    fromBase("creator");
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("checkbox", { name: "Project tracker" }));
    expect(within(dialog).getByText("Pick at least one base.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Send invite/ })).toBeDisabled();
  });

  it("lets an owner invite to every base, including later ones, and make owners", async () => {
    const user = userEvent.setup();
    const api = routes("owner");
    fromBase("owner");
    const dialog = await screen.findByRole("dialog");
    const all = within(dialog).getByRole("radio", { name: "All bases in Acme" });
    expect(all).toHaveAccessibleDescription("Including bases made later");
    await user.click(all);
    expect(within(dialog).queryByRole("checkbox", { name: "CRM" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Send invite/ }));
    await waitFor(() => expect(api.callsTo("POST /api/bases/app1/invites")[0]?.body).toEqual({ email: null, role: "editor", all_bases: true }));

    await user.selectOptions(within(dialog).getByLabelText("Role"), "owner");
    expect(within(dialog).getByText("Owners can always open every base in Acme.")).toBeInTheDocument();
  });

  it("from the workspace page, has no view tab and defaults an owner to every base", async () => {
    const user = userEvent.setup();
    const api = routes("owner");
    renderWithProviders(<ShareDialog open onOpenChange={() => {}} scope="workspace" workspace={makeWorkspace("owner")} />);
    const dialog = await screen.findByRole("dialog", { name: "Share Acme" });
    expect(within(dialog).queryByRole("tab")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "All bases in Acme" })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: /Send invite/ }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces/wsp1/invites")[0]?.body).toEqual({ email: null, role: "editor", all_bases: true }));
    expect(await within(dialog).findByText("Anyone with this link can join. Send it to the person you are inviting:")).toBeInTheDocument();
  });

  it("shows each base with its tile in the list to pick from", async () => {
    routes("creator");
    fromBase("creator");
    const dialog = await screen.findByRole("dialog");
    const list = within(dialog).getByRole("group", { name: "Bases" });
    await within(list).findByRole("checkbox", { name: "CRM" });
    expect(list.querySelectorAll("[data-entity-tile]")).toHaveLength(2);
  });

  it("from the workspace, tells someone who is not an owner how else to share", async () => {
    const api = routes("creator");
    renderWithProviders(<ShareDialog open onOpenChange={() => {}} scope="workspace" workspace={makeWorkspace("creator")} />);
    const dialog = await screen.findByRole("dialog", { name: "Share Acme" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Only owners can invite people to the whole workspace. Open a base to invite people to it, or share a view.");
    expect(within(dialog).queryByRole("button", { name: /Send invite/ })).not.toBeInTheDocument();
    expect(api.callsTo("POST /api/workspaces/wsp1/invites")).toHaveLength(0);
  });

  it("only invites from a base for viewers and editors, who have no view tab", async () => {
    routes("editor");
    fromBase("editor");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("tab")).not.toBeInTheDocument();
  });
});

describe("Share dialog: share a view", () => {
  const link = (over: Partial<ShareLink> = {}): ShareLink => ({ id: "shr1", view_id: "viw2", kind: "view", token: "tok1", path: "/s/tok1", url: "https://base.example.org/s/tok1", enabled: true, has_password: false, created_by: "usr1", created_at: 1, ...over });

  it("explains what the link shows and makes it on demand for the view on screen", async () => {
    const user = userEvent.setup();
    let links: ShareLink[] = [];
    const api = routes("creator", {
      "GET /api/views/viw2/shares": () => links,
      "POST /api/views/viw2/shares": () => {
        links = [link()];
        return links[0];
      },
    });
    fromBase("creator");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("tab", { name: "Share a view" }));
    const select = within(dialog).getByLabelText("View");
    expect(select).toHaveValue("viw2");
    // Personal views cannot be shared, so they are not offered.
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["All tasks", "Board"]);
    expect(
      within(dialog).getByText("Anyone with the link sees only what this view shows: its records and fields, now and as they change later. They can't edit anything or open the rest of the base."),
    ).toBeInTheDocument();

    await user.click(await within(dialog).findByRole("button", { name: /Create link/ }));
    await waitFor(() => expect(api.callsTo("POST /api/views/viw2/shares")[0]?.body).toEqual({ kind: "view" }));
    expect(await within(dialog).findByLabelText("View link")).toHaveValue("https://base.example.org/share/tok1");
    expect(within(dialog).getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("creates the link with a password, and sets or removes one on an existing link", async () => {
    const user = userEvent.setup();
    let current = link();
    const api = routes("creator", {
      "GET /api/views/viw1/shares": [],
      "POST /api/views/viw1/shares": link({ view_id: "viw1", has_password: true }),
      "GET /api/views/viw2/shares": () => [current],
      "PATCH /api/shares/shr1": (call) => {
        current = { ...current, has_password: (call.body as { password: string | null }).password !== null };
        return current;
      },
    });
    fromBase("creator");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("tab", { name: "Share a view" }));

    // An existing link: a password is set with its own button, and unticking removes it.
    await within(dialog).findByLabelText("View link");
    await user.click(within(dialog).getByRole("checkbox", { name: "Require a password" }));
    await user.type(within(dialog).getByLabelText("Password"), "garden party");
    await user.click(within(dialog).getByRole("button", { name: "Save password" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/shares/shr1")[0]?.body).toEqual({ password: "garden party" }));
    expect(await within(dialog).findByText("Visitors type the password once per visit.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: "Require a password" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/shares/shr1")[1]?.body).toEqual({ password: null }));

    // Another view without a link: the password goes with the new link, and a short one is refused first.
    await user.selectOptions(within(dialog).getByLabelText("View"), "viw1");
    await user.click(await within(dialog).findByRole("checkbox", { name: "Require a password" }));
    await user.type(within(dialog).getByLabelText("Password"), "ab");
    await user.click(within(dialog).getByRole("button", { name: /Create link/ }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(api.callsTo("POST /api/views/viw1/shares")).toHaveLength(0);
    await user.type(within(dialog).getByLabelText("Password"), "cdefgh");
    await user.click(within(dialog).getByRole("button", { name: /Create link/ }));
    await waitFor(() => expect(api.callsTo("POST /api/views/viw1/shares")[0]?.body).toEqual({ kind: "view", password: "abcdefgh" }));
  });

  it("from the workspace, offers the views of every base it may share, named after their base", async () => {
    const user = userEvent.setup();
    const tracker = makeSchema("creator");
    // A table named like its base is not named again; personal views and bases below creator stay out.
    const crm = makeSchema("creator", { id: "app2", name: "CRM", tables: [{ ...tracker.tables[1]!, id: "tbl9", base_id: "app2", name: "CRM", views: [makeView({ id: "viw9", name: "Pipeline" })] }] });
    routes("creator", { "GET /api/bases/app1": tracker, "GET /api/bases/app2": crm, "GET /api/views/viw1/shares": [] });
    const ws = makeWorkspace("creator", [
      { ...bases[0]!, role: "creator" },
      { ...bases[1]!, role: "creator" },
      { id: "app3", workspace_id: "wsp1", name: "Payroll", color: "red", role: "viewer", people: [], tables: [] },
    ]);
    renderWithProviders(<ShareDialog open onOpenChange={() => {}} scope="workspace" workspace={ws} />);
    const dialog = await screen.findByRole("dialog", { name: "Share Acme" });
    await user.click(within(dialog).getByRole("tab", { name: "Share a view" }));
    const select = await within(dialog).findByLabelText("View");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Project tracker › Tasks › All tasks", "Project tracker › Tasks › Board", "Project tracker › People › Everyone", "CRM › Pipeline"]);
    expect(await within(dialog).findByRole("button", { name: /Create link/ })).toBeInTheDocument();
  });

  it("offers to switch a link back on", async () => {
    const user = userEvent.setup();
    const api = routes("creator", { "GET /api/views/viw2/shares": [link({ enabled: false })], "PATCH /api/shares/shr1": link() });
    fromBase("creator");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("tab", { name: "Share a view" }));
    await user.click(await within(dialog).findByRole("button", { name: "Turn the link on" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/shares/shr1")[0]?.body).toEqual({ enabled: true }));
  });
});
