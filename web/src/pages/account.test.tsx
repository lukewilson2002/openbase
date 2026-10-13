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
    expect(api.callsTo("PATCH /api/auth/me")[0]?.body).toEqual({ name: "Ada L.", timezone: "Europe/London" });
    expect(await screen.findByText("Profile saved")).toBeInTheDocument();
  });

  it("changes the password after local validation", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /api/auth/me": USER, "POST /api/auth/password": { ok: true } });
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
      "POST /api/auth/2fa/setup": { secret: "JBSWY3DPEHPK3PXP", otpauth_url: "otpauth://totp/OpenGrid:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=OpenGrid" },
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
    const api = mockApi({ "GET /api/auth/me": { ...USER, totp_enabled: true }, "POST /api/auth/2fa/disable": USER });
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
    const info = { id: "pat1", name: "Zapier", write: true, base_ids: null, created_at: 1_700_000_000_000, last_used_at: null, expires_at: null };
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/tokens": [info],
      "POST /api/tokens": { token: "pat_SECRETVALUE", info },
      "DELETE /api/tokens/pat1": { status: 204 },
    });
    renderApp({ route: "/account?tab=tokens" });

    expect(await screen.findByText("Zapier")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /New token/ }));
    const form = await screen.findByRole("dialog", { name: "New personal access token" });
    await user.type(within(form).getByLabelText("Name"), "Zapier");
    await user.click(within(form).getByRole("checkbox", { name: /Allow writes/ }));
    await user.selectOptions(within(form).getByLabelText("Expires"), "90");
    await user.click(within(form).getByRole("button", { name: "Create token" }));

    const shown = await screen.findByRole("dialog", { name: "Copy your new token" });
    expect(within(shown).getByLabelText("API token")).toHaveValue("pat_SECRETVALUE");
    expect(api.callsTo("POST /api/tokens")[0]?.body).toEqual({ name: "Zapier", write: true, base_ids: null, expires_in_days: 90 });
    await user.click(within(shown).getByRole("button", { name: "Done" }));
    expect(screen.queryByDisplayValue("pat_SECRETVALUE")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Revoke Zapier" }));
    await user.click(await screen.findByRole("button", { name: "Revoke token" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/tokens/pat1")).toHaveLength(1));
  });
});
