import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InviteInfo, Member, WorkspaceSummary } from "@/api/types";
import { USER, mockApi, renderApp, type Handler } from "@/test/utils";

afterEach(() => vi.unstubAllGlobals());

const bases = [
  { id: "app1", workspace_id: "wsp1", name: "Chores", color: "teal", role: "owner", people: [] },
  { id: "app2", workspace_id: "wsp1", name: "Budget", color: "blue", role: "owner", people: [] },
  { id: "app3", workspace_id: "wsp1", name: "Recipes", color: "red", role: "owner", people: [] },
];
const ws: WorkspaceSummary = { id: "wsp1", name: "Household", role: "owner", member_count: 4, pending_invite_count: 1, bases };
const members: Member[] = [
  { user_id: "usr1", name: "Ada Lovelace", email: "ada@example.com", role: "owner", all_bases: true, base_ids: [] },
  { user_id: "usr2", name: "Tori Smith", email: "tori@example.com", role: "editor", all_bases: false, base_ids: ["app1"] },
  { user_id: "usr3", name: "Sam Lee", email: "sam@example.com", role: "viewer", all_bases: true, base_ids: [] },
  { user_id: "usr4", name: "Kim Park", email: "kim@example.com", role: "commenter", all_bases: false, base_ids: ["app1", "app3"] },
];
const invite: InviteInfo = { id: "inv1", workspace_id: "wsp1", base_id: null, email: "jordan@example.com", role: "viewer", created_at: 1, expires_at: 2, accepted_at: null, all_bases: false, base_ids: ["app2"] };

function routes(extra: Record<string, Handler> = {}) {
  return mockApi({
    "GET /api/auth/me": USER,
    "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false, public_url: "https://base.example.org", passkeys_enabled: true },
    "GET /api/notifications": { notifications: [], unread: 0 },
    "GET /api/workspaces": [ws],
    "GET /api/workspaces/wsp1/members": members,
    "GET /api/workspaces/wsp1/invites": [invite],
    ...extra,
  });
}

const row = async (name: string) => (await screen.findByText(name)).closest("li")!;

describe("members page", () => {
  it("lists each member's bases and role, and the invites still waiting", async () => {
    routes();
    renderApp({ route: "/workspace/wsp1/members" });
    expect(await screen.findByRole("heading", { level: 1, name: "Members" })).toBeInTheDocument();
    expect(screen.getByText("Everyone here has one role. You choose which bases each person can open.")).toBeInTheDocument();

    const ada = await row("Ada Lovelace");
    expect(ada).toHaveTextContent("(you)");
    expect(within(ada).getByText("All bases")).toBeInTheDocument();
    expect(within(ada).getByText("Owner")).toBeInTheDocument();
    expect(within(ada).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(await row("Tori Smith")).getByRole("button", { name: "Bases Tori Smith can open: Chores only" })).toBeInTheDocument();
    expect(within(await row("Sam Lee")).getByRole("button", { name: "Bases Sam Lee can open: All bases, incl. new" })).toBeInTheDocument();
    expect(within(await row("Kim Park")).getByRole("button", { name: "Bases Kim Park can open: 2 of 3 bases" })).toBeInTheDocument();

    const pending = screen.getByRole("listitem", { name: "jordan@example.com, invited" });
    expect(within(pending).getByText("Invited")).toBeInTheDocument();
    expect(within(pending).getByText(/Not joined yet/)).toBeInTheDocument();
    expect(within(pending).getByText("Budget only")).toBeInTheDocument();
    expect(pending.querySelector("[data-pending]")).toHaveClass("border-dashed");
    expect(screen.getByText(/Want someone outside the workspace to see a few records\? Share a view instead\./)).toBeInTheDocument();
  });

  it("edits which bases a member can open", async () => {
    const user = userEvent.setup();
    const api = routes({ "PATCH /api/workspaces/wsp1/members/usr2": { ok: true }, "PATCH /api/workspaces/wsp1/members/usr3": { ok: true } });
    renderApp({ route: "/workspace/wsp1/members" });
    const tori = await row("Tori Smith");
    const toggle = within(tori).getByRole("button", { name: /Bases Tori Smith can open/ });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const editor = within(tori).getByRole("group", { name: "Bases Tori Smith can open" });
    expect(within(editor).getByRole("checkbox", { name: "Chores" })).toBeChecked();
    await user.click(within(editor).getByRole("checkbox", { name: "Recipes" }));
    await user.click(within(editor).getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1/members/usr2")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/workspaces/wsp1/members/usr2")[0]!.body).toEqual({ all_bases: false, base_ids: ["app1", "app3"] });
    await waitFor(() => expect(within(tori).queryByRole("group", { name: "Bases Tori Smith can open" })).not.toBeInTheDocument());

    // Ticking "All bases" locks the list; unticking it on someone with every base starts from none.
    const sam = await row("Sam Lee");
    await user.click(within(sam).getByRole("button", { name: /Bases Sam Lee can open/ }));
    const samEditor = within(sam).getByRole("group", { name: "Bases Sam Lee can open" });
    const all = within(samEditor).getByRole("checkbox", { name: "All bases, including new ones" });
    expect(all).toBeChecked();
    expect(within(samEditor).getByRole("checkbox", { name: "Budget" })).toBeDisabled();
    await user.click(all);
    await user.click(within(samEditor).getByRole("checkbox", { name: "Budget" }));
    await user.click(within(samEditor).getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1/members/usr3")[0]?.body).toEqual({ all_bases: false, base_ids: ["app2"] }));
  });

  it("will not save access to no base at all", async () => {
    const user = userEvent.setup();
    const api = routes();
    renderApp({ route: "/workspace/wsp1/members" });
    const tori = await row("Tori Smith");
    await user.click(within(tori).getByRole("button", { name: /Bases Tori Smith can open/ }));
    await user.click(within(tori).getByRole("checkbox", { name: "Chores" }));
    expect(within(tori).getByText("Pick at least one base, or remove them from the workspace.")).toBeInTheDocument();
    expect(within(tori).getByRole("button", { name: "Save access" })).toBeDisabled();
    // "All bases" is a valid choice again.
    await user.click(within(tori).getByRole("checkbox", { name: "All bases, including new ones" }));
    expect(within(tori).getByRole("button", { name: "Save access" })).toBeEnabled();
    expect(api.callsTo("PATCH /api/workspaces/wsp1/members/usr2")).toHaveLength(0);
  });

  it("gives every base, including new ones", async () => {
    const user = userEvent.setup();
    const api = routes({ "PATCH /api/workspaces/wsp1/members/usr4": { ok: true } });
    renderApp({ route: "/workspace/wsp1/members" });
    const kim = await row("Kim Park");
    await user.click(within(kim).getByRole("button", { name: /Bases Kim Park can open/ }));
    await user.click(within(kim).getByRole("checkbox", { name: "All bases, including new ones" }));
    await user.click(within(kim).getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1/members/usr4")[0]?.body).toEqual({ all_bases: true }));
  });

  it("keeps the editor open and says so when saving fails", async () => {
    const user = userEvent.setup();
    routes({ "PATCH /api/workspaces/wsp1/members/usr2": { status: 403, json: { error: { code: "forbidden", message: "Only owners can change access" } } } });
    renderApp({ route: "/workspace/wsp1/members" });
    const tori = await row("Tori Smith");
    await user.click(within(tori).getByRole("button", { name: /Bases Tori Smith can open/ }));
    await user.click(within(tori).getByRole("button", { name: "Save access" }));
    expect(await screen.findByText("Only owners can change access")).toBeInTheDocument();
    expect(within(tori).getByRole("group", { name: "Bases Tori Smith can open" })).toBeInTheDocument();
  });

  it("changes a role", async () => {
    const user = userEvent.setup();
    const api = routes({ "PATCH /api/workspaces/wsp1/members/usr2": { ok: true } });
    renderApp({ route: "/workspace/wsp1/members" });
    await user.selectOptions(await screen.findByLabelText("Role for Tori Smith"), "creator");
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1/members/usr2")[0]?.body).toEqual({ role: "creator" }));
  });

  it("removes a member after confirming", async () => {
    const user = userEvent.setup();
    const api = routes({ "DELETE /api/workspaces/wsp1/members/usr3": { ok: true } });
    renderApp({ route: "/workspace/wsp1/members" });
    await user.click(await screen.findByRole("button", { name: "Actions for Sam Lee" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from workspace" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Remove Sam Lee?");
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/workspaces/wsp1/members/usr3")).toHaveLength(1));
  });

  it("resends an invite as a new one with the same terms, then shows its link", async () => {
    const user = userEvent.setup();
    const api = routes({
      "POST /api/workspaces/wsp1/invites": { url: "https://base.example.org/invite/newtoken", info: { ...invite, id: "inv2" } },
      "DELETE /api/invites/inv1": { status: 204 },
    });
    renderApp({ route: "/workspace/wsp1/members" });
    const pending = await screen.findByRole("listitem", { name: "jordan@example.com, invited" });
    api.set("GET /api/workspaces/wsp1/invites", () => (api.callsTo("DELETE /api/invites/inv1").length ? [{ ...invite, id: "inv2" }] : [invite]));
    await user.click(within(pending).getByRole("button", { name: "Resend" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/invites/inv1")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces/wsp1/invites")[0]!.body).toEqual({ email: "jordan@example.com", role: "viewer", all_bases: false, base_ids: ["app2"] });
    // Email is off on this server, so the new link is the way to reach them.
    expect(await screen.findByLabelText("Invite link")).toHaveValue("https://base.example.org/invite/newtoken");
    expect(screen.getByText("Email is not set up on this server, so send jordan@example.com this link yourself:")).toBeInTheDocument();
  });

  it("leaves trashed bases off a resent invite, and cannot resend one whose bases are all gone", async () => {
    const user = userEvent.setup();
    const partly: InviteInfo = { ...invite, base_ids: ["app2", "appGone"] };
    const gone: InviteInfo = { ...invite, id: "inv3", email: "gone@example.com", base_ids: ["appGone"] };
    const api = routes({
      "GET /api/workspaces/wsp1/invites": [partly, gone],
      "POST /api/workspaces/wsp1/invites": { url: "https://base.example.org/invite/newtoken", info: { ...invite, id: "inv2" } },
      "DELETE /api/invites/inv1": { status: 204 },
    });
    renderApp({ route: "/workspace/wsp1/members" });
    const goneRow = await screen.findByRole("listitem", { name: "gone@example.com, invited" });
    const goneResend = within(goneRow).getByRole("button", { name: "Resend" });
    expect(goneResend).toBeDisabled();
    expect(goneResend).toHaveAttribute("title", "Its bases are in the trash. Cancel it and invite them again.");
    expect(within(goneRow).getByRole("button", { name: "Cancel invite" })).toBeEnabled();

    const pending = screen.getByRole("listitem", { name: "jordan@example.com, invited" });
    await user.click(within(pending).getByRole("button", { name: "Resend" }));
    await waitFor(() => expect(api.callsTo("POST /api/workspaces/wsp1/invites")).toHaveLength(1));
    expect(api.callsTo("POST /api/workspaces/wsp1/invites")[0]!.body).toEqual({ email: "jordan@example.com", role: "viewer", all_bases: false, base_ids: ["app2"] });
  });

  it("cancels an invite", async () => {
    const user = userEvent.setup();
    const api = routes({ "DELETE /api/invites/inv1": { status: 204 } });
    renderApp({ route: "/workspace/wsp1/members" });
    const pending = await screen.findByRole("listitem", { name: "jordan@example.com, invited" });
    await user.click(within(pending).getByRole("button", { name: "Cancel invite" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/invites/inv1")).toHaveLength(1));
  });

  it("is read-only for someone who is not an owner, without asking for the invites", async () => {
    const me: Member = { user_id: "usr1", name: "Ada Lovelace", email: "ada@example.com", role: "editor", all_bases: false, base_ids: ["app1"] };
    const api = routes({ "GET /api/workspaces": [{ ...ws, role: "editor" }], "GET /api/workspaces/wsp1/members": [me, ...members.slice(1)] });
    renderApp({ route: "/workspace/wsp1/members" });
    const tori = await row("Tori Smith");
    expect(within(tori).getByText("Editor")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Bases .* can open/ })).not.toBeInTheDocument();
    // Only their own row has actions (to leave).
    expect(screen.getAllByRole("button", { name: /Actions for/ }).map((b) => b.getAttribute("aria-label"))).toEqual(["Actions for Ada Lovelace"]);
    expect(screen.queryByRole("button", { name: /Invite people/ })).not.toBeInTheDocument();
    expect(api.callsTo("GET /api/workspaces/wsp1/invites")).toHaveLength(0);
  });

  it("tells someone who is not an owner only whether a member has every base", async () => {
    routes({ "GET /api/workspaces": [{ ...ws, role: "editor" }] });
    renderApp({ route: "/workspace/wsp1/members" });
    // They cannot see every base or anyone's full list, so no counts or names.
    expect(within(await row("Tori Smith")).getByText("Some bases")).toBeInTheDocument();
    expect(within(await row("Kim Park")).getByText("Some bases")).toBeInTheDocument();
    expect(within(await row("Sam Lee")).getByText("All bases")).toBeInTheDocument();
    expect(within(await row("Ada Lovelace")).getByText("All bases")).toBeInTheDocument();
  });

  it("lets someone who is not an owner leave, then goes home", async () => {
    const user = userEvent.setup();
    const me: Member = { user_id: "usr1", name: "Ada Lovelace", email: "ada@example.com", role: "viewer", all_bases: true, base_ids: [] };
    const owner: Member = { user_id: "usr9", name: "Olive Owner", email: "olive@example.com", role: "owner", all_bases: true, base_ids: [] };
    const api = routes({ "GET /api/workspaces/wsp1/members": [owner, me], "DELETE /api/workspaces/wsp1/members/usr1": { ok: true } });
    api.set("GET /api/workspaces", () => (api.callsTo("DELETE /api/workspaces/wsp1/members/usr1").length ? [] : [{ ...ws, role: "viewer" }]));
    renderApp({ route: "/workspace/wsp1/members" });
    expect(screen.queryByRole("button", { name: "Actions for Olive Owner" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Actions for Ada Lovelace" }));
    await user.click(await screen.findByRole("menuitem", { name: "Leave workspace" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Leave Household?");
    await user.click(within(confirm).getByRole("button", { name: "Leave workspace" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/workspaces/wsp1/members/usr1")).toHaveLength(1));
    expect(await screen.findByRole("heading", { name: "Create your first workspace" })).toBeInTheDocument();
  });

  it("does not let the only owner leave, and says why", async () => {
    const user = userEvent.setup();
    routes();
    renderApp({ route: "/workspace/wsp1/members" });
    await user.click(await screen.findByRole("button", { name: "Actions for Ada Lovelace" }));
    expect(await screen.findByRole("menuitem", { name: "Leave workspace" })).toHaveAttribute("data-disabled");
    expect(screen.getByText("You are the only owner. Make someone else an owner first.")).toBeInTheDocument();
  });

  it("opens the invite dialog from Invite people", async () => {
    const user = userEvent.setup();
    routes();
    renderApp({ route: "/workspace/wsp1/members" });
    await user.click(await screen.findByRole("button", { name: /Invite people/ }));
    expect(await screen.findByRole("dialog", { name: "Share Household" })).toBeInTheDocument();
  });
});

describe("workspace settings page", () => {
  it("renames and deletes the workspace for its owner", async () => {
    const user = userEvent.setup();
    const api = routes({ "PATCH /api/workspaces/wsp1": ws, "DELETE /api/workspaces/wsp1": { ok: true } });
    renderApp({ route: "/workspace/wsp1/settings" });
    expect(await screen.findByRole("heading", { level: 1, name: "Workspace settings" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename workspace" });
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "Home");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/workspaces/wsp1")[0]?.body).toEqual({ name: "Home" }));
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete workspace" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/workspaces/wsp1")).toHaveLength(1));
  });

  it("tells others that only owners change these", async () => {
    routes({ "GET /api/workspaces": [{ ...ws, role: "creator" }] });
    renderApp({ route: "/workspace/wsp1/settings" });
    expect(await screen.findByText("Only owners can rename, change or delete a workspace.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete workspace" })).not.toBeInTheDocument();
  });
});
