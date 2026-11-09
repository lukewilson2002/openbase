import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USER, mockApi, renderApp } from "@/test/utils";

afterEach(() => vi.unstubAllGlobals());

describe("account", () => {
  it("saves the profile with a time zone chosen from the browser's list", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/auth/me": USER,
      "PATCH /api/auth/me": (call) => ({ ...USER, ...(call.body as object) }),
    });
    renderApp({ route: "/account" });

    const name = await screen.findByLabelText("Name");
    expect(screen.getByLabelText("Email")).toBeDisabled();
    await user.clear(name);
    await user.type(name, "Ada L.");
    const tz = screen.getByLabelText("Time zone");
    expect(within(tz).getAllByRole("option").length).toBeGreaterThan(10);
    await user.selectOptions(tz, "Europe/London");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(api.callsTo("PATCH /api/auth/me")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/auth/me")[0]?.body).toEqual({ name: "Ada L.", timezone: "Europe/London", week_start: 0 });
    expect(await screen.findByText("Profile saved")).toBeInTheDocument();
  });

  it("saves the week start with the profile, for the filters that say this week", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /api/auth/me": { ...USER, week_start: 0 }, "PATCH /api/auth/me": (call) => ({ ...USER, ...(call.body as object) }) });
    renderApp({ route: "/account" });
    const week = await screen.findByLabelText("Week starts on");
    expect(week).toHaveValue("0");
    await user.selectOptions(week, "Monday");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/auth/me")[0]?.body).toMatchObject({ week_start: 1 }));
  });

  it("changes the password after local validation", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /api/auth/me": USER, "GET /api/auth/passkeys": [], "POST /api/auth/password": { ok: true } });
    renderApp({ route: "/account?tab=security" });

    await user.type(await screen.findByLabelText("Current password"), "oldpassword1");
    await user.type(screen.getByLabelText("New password"), "newpassword1");
    await user.type(screen.getByLabelText("Confirm new password"), "mismatch1234");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not match");
    expect(api.callsTo("POST /api/auth/password")).toHaveLength(0);

    const confirm = screen.getByLabelText("Confirm new password");
    await user.clear(confirm);
    await user.type(confirm, "newpassword1");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(api.callsTo("POST /api/auth/password")).toHaveLength(1));
    expect(api.callsTo("POST /api/auth/password")[0]?.body).toEqual({ current_password: "oldpassword1", new_password: "newpassword1" });
  });

  it("enables two-factor with a QR code, the secret for manual entry, and a confirmation code", async () => {
    const user = userEvent.setup();
    let enabled = false;
    const api = mockApi({
      "GET /api/auth/me": () => ({ ...USER, totp_enabled: enabled }),
      "GET /api/auth/passkeys": [],
      "POST /api/auth/2fa/setup": { secret: "JBSWY3DPEHPK3PXP", otpauth_url: "otpauth://totp/OpenBase:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=OpenBase" },
      "POST /api/auth/2fa/enable": () => {
        enabled = true;
        return { ...USER, totp_enabled: true };
      },
    });
    renderApp({ route: "/account?tab=security" });

    await user.click(await screen.findByRole("button", { name: /Enable two-factor/ }));
    const dialog = await screen.findByRole("dialog", { name: "Set up two-factor authentication" });
    const qr = await within(dialog).findByRole("img", { name: /QR code/ });
    expect(qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(within(dialog).getByLabelText("Secret key")).toHaveValue("JBSWY3DPEHPK3PXP");

    const turnOn = within(dialog).getByRole("button", { name: "Turn on" });
    expect(turnOn).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Code from your app"), "654321");
    await user.click(turnOn);

    await waitFor(() => expect(api.callsTo("POST /api/auth/2fa/enable")).toHaveLength(1));
    expect(api.callsTo("POST /api/auth/2fa/enable")[0]?.body).toEqual({ code: "654321" });
    expect(await screen.findByText("Enabled")).toBeInTheDocument();
  });

  it("disables two-factor with password and code", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /api/auth/me": { ...USER, totp_enabled: true }, "GET /api/auth/passkeys": [], "POST /api/auth/2fa/disable": USER });
    renderApp({ route: "/account?tab=security" });
    await user.click(await screen.findByRole("button", { name: "Disable" }));
    const dialog = await screen.findByRole("dialog", { name: /Disable two-factor/ });
    await user.type(within(dialog).getByLabelText("Password"), "hunter2hunter2");
    await user.type(within(dialog).getByLabelText("Authentication code"), "111222");
    await user.click(within(dialog).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(api.callsTo("POST /api/auth/2fa/disable")).toHaveLength(1));
    expect(api.callsTo("POST /api/auth/2fa/disable")[0]?.body).toEqual({ password: "hunter2hunter2", code: "111222" });
  });

  it("lists sessions, marks the current one and revokes others", async () => {
    const user = userEvent.setup();
    const sessions = [
      { id: "s1", created_at: 1_700_000_000_000, last_seen_at: 1_700_000_100_000, expires_at: 1_800_000_000_000, user_agent: "Firefox on Linux", ip: "10.0.0.1", current: true },
      { id: "s2", created_at: 1_690_000_000_000, last_seen_at: 1_690_000_100_000, expires_at: 1_800_000_000_000, user_agent: "Safari on iPhone", ip: null, current: false },
    ];
    const api = mockApi({ "GET /api/auth/me": USER, "GET /api/auth/sessions": sessions, "DELETE /api/auth/sessions/s2": { status: 204 } });
    renderApp({ route: "/account?tab=sessions" });

    expect(await screen.findByText("Firefox on Linux")).toBeInTheDocument();
    expect(screen.getByText("This session")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/auth/sessions/s2")).toHaveLength(1));
  });

  it("creates an API token, shows it once, and revokes tokens", async () => {
    const user = userEvent.setup();
    const info = { id: "pat1", name: "Zapier", write: true, manage: false, base_ids: null, created_at: 1_700_000_000_000, last_used_at: null, expires_at: null };
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/tokens": [info],
      "POST /api/tokens": { token: "pat_SECRETVALUE", info },
      "DELETE /api/tokens/pat1": { status: 204 },
    });
    renderApp({ route: "/account?tab=tokens" });

    expect(await screen.findByText("Zapier")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /New token/ }));
    const form = await screen.findByRole("dialog", { name: "New API token" });
    await user.type(within(form).getByLabelText("Name"), "Zapier");
    await user.click(within(form).getByRole("radio", { name: "Read and write" }));
    await user.selectOptions(within(form).getByLabelText("Expires"), "90");
    await user.click(within(form).getByRole("button", { name: "Create token" }));

    const shown = await screen.findByRole("dialog", { name: "Copy your new token" });
    expect(within(shown).getByLabelText("API token")).toHaveValue("pat_SECRETVALUE");
    expect(api.callsTo("POST /api/tokens")[0]?.body).toEqual({ name: "Zapier", write: true, manage: false, base_ids: null, expires_in_days: 90 });
    await user.click(within(shown).getByRole("button", { name: "Done" }));
    expect(screen.queryByDisplayValue("pat_SECRETVALUE")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Revoke Zapier" }));
    await user.click(await screen.findByRole("button", { name: "Revoke token" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/tokens/pat1")).toHaveLength(1));
  });

  it("offers Read, Read and write, or Full access with a plain sentence each, and shows the level in the list", async () => {
    const user = userEvent.setup();
    const base = { write: true, base_ids: null, created_at: 1_700_000_000_000, last_used_at: null, expires_at: null };
    const agent = { id: "pat2", name: "Agent", manage: true, ...base };
    const plain = { id: "pat3", name: "Plain", manage: false, ...base };
    const viewer = { id: "pat5", name: "Viewer", write: false, manage: false, base_ids: null, created_at: 1_700_000_000_000, last_used_at: null, expires_at: null };
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/tokens": [agent, plain, viewer],
      "POST /api/tokens": { token: "pat_X", info: agent },
    });
    renderApp({ route: "/account?tab=tokens" });

    const rows = within(await screen.findByRole("list", { name: "API tokens" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Full access");
    expect(rows[1]).toHaveTextContent("Read and write");
    expect(rows[2]).toHaveTextContent("Read");
    expect(rows[2]).not.toHaveTextContent("Read and write");

    await user.click(screen.getByRole("button", { name: /New token/ }));
    const form = await screen.findByRole("dialog", { name: "New API token" });
    const levels = within(form).getByRole("radiogroup", { name: "Access" });
    expect(within(levels).getAllByRole("radio").map((r) => r.getAttribute("aria-labelledby") && document.getElementById(r.getAttribute("aria-labelledby")!)!.textContent)).toEqual(["Read", "Read and write", "Full access"]);
    // Each level says in one sentence what it allows, and Read is the default.
    expect(within(levels).getByRole("radio", { name: "Read" })).toBeChecked();
    expect(within(levels).getByRole("radio", { name: "Read" })).toHaveAccessibleDescription("Can see your folders, collections and records, and cannot change anything.");
    expect(within(levels).getByRole("radio", { name: "Full access" })).toHaveAccessibleDescription(/create and delete workspaces and folders, manage members/);
    expect(within(form).getByText(/can never be changed with a token/)).toBeInTheDocument();

    await user.type(within(form).getByLabelText("Name"), "Agent");
    await user.click(within(levels).getByRole("radio", { name: "Full access" }));
    await user.click(within(form).getByRole("button", { name: "Create token" }));

    await screen.findByRole("dialog", { name: "Copy your new token" });
    expect(api.callsTo("POST /api/tokens")[0]?.body).toEqual({ name: "Agent", write: true, manage: true, base_ids: null, expires_in_days: null });
  });

  it("limits a token to selected bases", async () => {
    const user = userEvent.setup();
    const info = { id: "pat4", name: "Scoped", write: true, manage: false, base_ids: ["app2"], created_at: 1_700_000_000_000, last_used_at: null, expires_at: null };
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/tokens": [],
      "GET /api/workspaces": [
        {
          id: "wsp1",
          name: "Acme",
          role: "owner",
          bases: [
            { id: "app1", workspace_id: "wsp1", name: "CRM", color: "blue", icon: null, role: "owner" },
            { id: "app2", workspace_id: "wsp1", name: "Ops", color: "green", icon: null, role: "owner" },
          ],
        },
      ],
      "POST /api/tokens": { token: "pat_SCOPED", info },
    });
    renderApp({ route: "/account?tab=tokens" });

    await user.click(await screen.findByRole("button", { name: /New token/ }));
    // The shell (a phone's tabs) asks for the workspaces on its own; the form must not add a request.
    const shellRequests = api.callsTo("GET /api/workspaces").length;
    const form = await screen.findByRole("dialog", { name: "New API token" });
    await user.type(within(form).getByLabelText("Name"), "Scoped");
    // Without the list of bases being asked for, nothing is fetched.
    expect(api.callsTo("GET /api/workspaces")).toHaveLength(shellRequests);
    await user.selectOptions(within(form).getByLabelText("Folders"), "some");
    const group = await within(form).findByRole("group", { name: "Allowed folders" });
    expect(within(form).getByRole("button", { name: "Create token" })).toBeDisabled();
    await user.click(await within(group).findByRole("checkbox", { name: "Acme / Ops" }));
    expect(within(group).getByRole("checkbox", { name: "Acme / CRM" })).not.toBeChecked();
    // The server takes any level with a folder limit for a token, so Full access stays on offer.
    expect(within(group).queryByText(/cannot have Full access/)).not.toBeInTheDocument();
    expect(within(form).getByRole("radio", { name: "Full access" })).toBeEnabled();
    await user.click(within(form).getByRole("button", { name: "Create token" }));

    await screen.findByRole("dialog", { name: "Copy your new token" });
    expect(api.callsTo("POST /api/tokens")[0]?.body).toEqual({ name: "Scoped", write: false, manage: false, base_ids: ["app2"], expires_in_days: null });
  });

  it("keeps Full access when a token is limited to some folders, as the server allows", async () => {
    const user = userEvent.setup();
    const info = { id: "pat6", name: "Scoped agent", write: true, manage: true, base_ids: ["app2"], created_at: 1_700_000_000_000, last_used_at: null, expires_at: null };
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/tokens": [],
      "GET /api/workspaces": [{ id: "wsp1", name: "Acme", role: "owner", bases: [{ id: "app2", workspace_id: "wsp1", name: "Ops", color: "green", icon: null, role: "owner" }] }],
      "POST /api/tokens": { token: "pat_SCOPED", info },
    });
    renderApp({ route: "/account?tab=tokens" });

    await user.click(await screen.findByRole("button", { name: /New token/ }));
    const form = await screen.findByRole("dialog", { name: "New API token" });
    await user.type(within(form).getByLabelText("Name"), "Scoped agent");
    await user.click(within(form).getByRole("radio", { name: "Full access" }));
    await user.selectOptions(within(form).getByLabelText("Folders"), "some");
    expect(within(form).getByRole("radio", { name: "Full access" })).toBeChecked();
    await user.click(await within(await within(form).findByRole("group", { name: "Allowed folders" })).findByRole("checkbox", { name: "Acme / Ops" }));
    await user.click(within(form).getByRole("button", { name: "Create token" }));

    await screen.findByRole("dialog", { name: "Copy your new token" });
    expect(api.callsTo("POST /api/tokens")[0]?.body).toEqual({ name: "Scoped agent", write: true, manage: true, base_ids: ["app2"], expires_in_days: null });
  });
});
