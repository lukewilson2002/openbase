import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN, ADMIN_USER_ROW, USER, mockApi, renderApp } from "@/test/utils";
import { AUDIT_PAGE_SIZE } from "./admin/AuditTab";

afterEach(() => vi.unstubAllGlobals());

describe("admin", () => {
  it("is closed to regular users", async () => {
    const api = mockApi({ "GET /api/auth/me": USER });
    renderApp({ route: "/admin" });
    expect(await screen.findByText("Administrators only")).toBeInTheDocument();
    expect(api.callsTo("GET /api/admin/users")).toHaveLength(0);
  });

  it("lists users with status badges and creates a reset link", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/auth/me": ADMIN,
      "GET /api/admin/users": [
        { ...ADMIN_USER_ROW, id: "usr0", name: "Root Admin", email: "root@example.com", is_admin: true, totp_enabled: false },
        ADMIN_USER_ROW,
        { ...ADMIN_USER_ROW, id: "usr3", name: "Old Timer", email: "old@example.com", is_active: false, totp_enabled: false },
      ],
      "POST /api/admin/users/usr1/reset-link": { url: "/reset-password?token=zzz", expires_at: 1_800_000_000_000 },
      "PATCH /api/admin/users/usr1": { ...ADMIN_USER_ROW, is_admin: true },
    });
    renderApp({ route: "/admin" });

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(within(rows[1]!).getByText("Admin")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("2FA")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Deactivated")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actions for Ada Lovelace" }));
    await user.click(await screen.findByRole("menuitem", { name: /Create password reset link/ }));
    const dialog = await screen.findByRole("dialog", { name: /Reset link for Ada Lovelace/ });
    expect(within(dialog).getByLabelText("Reset link")).toHaveValue(`${window.location.origin}/reset-password?token=zzz`);
    await user.click(within(dialog).getByRole("button", { name: "Done" }));

    await user.click(screen.getByRole("button", { name: "Actions for Ada Lovelace" }));
    await user.click(await screen.findByRole("menuitem", { name: /Make administrator/ }));
    await waitFor(() => expect(api.callsTo("PATCH /api/admin/users/usr1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/admin/users/usr1")[0]?.body).toEqual({ is_admin: true });
  });

  it("does not let an administrator demote or deactivate themselves from the menu", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /api/auth/me": ADMIN, "GET /api/admin/users": [{ ...ADMIN_USER_ROW, id: "usr0", name: "Root Admin", email: "root@example.com", is_admin: true }] });
    renderApp({ route: "/admin" });
    await user.click(await screen.findByRole("button", { name: "Actions for Root Admin" }));
    expect(await screen.findByRole("menuitem", { name: /Remove admin rights/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: /Deactivate/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("disables a user's two-factor after confirmation", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /api/auth/me": ADMIN, "GET /api/admin/users": [ADMIN_USER_ROW], "PATCH /api/admin/users/usr1": { ...ADMIN_USER_ROW, totp_enabled: false } });
    renderApp({ route: "/admin" });
    await user.click(await screen.findByRole("button", { name: "Actions for Ada Lovelace" }));
    await user.click(await screen.findByRole("menuitem", { name: /Disable two-factor/ }));
    await user.click(await screen.findByRole("button", { name: "Disable two-factor" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/admin/users/usr1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/admin/users/usr1")[0]?.body).toEqual({ disable_2fa: true });
  });

  it("creates a user and shows the reset link when no password was set", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/auth/me": ADMIN,
      "GET /api/admin/users": [],
      "POST /api/admin/users": {
        status: 201,
        json: {
          user: { ...ADMIN_USER_ROW, id: "usr7", name: "New Hire", email: "new@example.com" },
          reset_link: { url: "https://og.example.com/reset-password?token=abc", expires_at: 1_800_000_000_000 },
        },
      },
    });
    renderApp({ route: "/admin" });
    await user.click(await screen.findByRole("button", { name: /New user/ }));
    const form = await screen.findByRole("dialog", { name: "New user" });
    await user.type(within(form).getByLabelText("Name"), "New Hire");
    await user.type(within(form).getByLabelText("Email"), "new@example.com");
    await user.click(within(form).getByRole("button", { name: "Create user" }));
    expect(await screen.findByRole("dialog", { name: /Reset link for New Hire/ })).toBeInTheDocument();
    expect(api.callsTo("POST /api/admin/users")[0]?.body).toEqual({ name: "New Hire", email: "new@example.com", password: null, is_admin: false });
  });

  it("pages through the audit log with cursors", async () => {
    const user = userEvent.setup();
    const entry = (id: number) => ({ id, user_id: "usr0", user_email: "root@example.com", action: `action.${id}`, target: null, detail: null, ip: "127.0.0.1", created_at: 1_700_000_000_000 + id });
    const firstPage = Array.from({ length: AUDIT_PAGE_SIZE }, (_, i) => entry(200 - i));
    const secondPage = [entry(150), entry(149)];
    const api = mockApi({
      "GET /api/auth/me": ADMIN,
      "GET /api/admin/audit": (call) =>
        call.query.get("before") === null ? { entries: firstPage, next_before: 151 } : { entries: secondPage, next_before: null },
    });
    renderApp({ route: "/admin?tab=audit" });

    expect(await screen.findByText("action.200")).toBeInTheDocument();
    expect(screen.getByText(`Page 1 (${AUDIT_PAGE_SIZE} entries)`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Newer/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Older/ }));
    expect(await screen.findByText("action.150")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Older/ })).toBeDisabled();
    expect(api.callsTo("GET /api/admin/audit").map((c) => c.query.get("before"))).toEqual([null, "151"]);
    expect(api.callsTo("GET /api/admin/audit")[0]?.query.get("limit")).toBe(String(AUDIT_PAGE_SIZE));
    expect(api.callsTo("GET /api/admin/audit")[0]?.query.has("offset")).toBe(false);

    await user.click(screen.getByRole("button", { name: /Newer/ }));
    expect(await screen.findByText("action.200")).toBeInTheDocument();
  });

  it("shows instance statistics", async () => {
    mockApi({
      "GET /api/auth/me": ADMIN,
      "GET /api/admin/stats": { users: 3, workspaces: 2, bases: 5, records: 12345, database_bytes: 5 * 1024 * 1024, attachments_bytes: 0, last_backup_at: null, version: "0.1.0" },
    });
    renderApp({ route: "/admin?tab=stats" });
    expect(await screen.findByText("12,345")).toBeInTheDocument();
    expect(screen.getByText("5.0 MB")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
    expect(screen.getByText("0.1.0")).toBeInTheDocument();
  });

  it("lists backups with download links and creates one on demand", async () => {
    const user = userEvent.setup();
    const backups = [{ name: "openbase-2026-10-11.tar.gz", size: 2048, created_at: 1_700_000_000_000 }];
    const api = mockApi({
      "GET /api/auth/me": ADMIN,
      "GET /api/admin/backups": backups,
      "POST /api/admin/backups": { name: "openbase-2026-10-12.tar.gz", size: 4096, created_at: 1_700_000_100_000 },
    });
    renderApp({ route: "/admin?tab=backups" });
    const link = await screen.findByRole("link", { name: /Download/ });
    expect(link).toHaveAttribute("href", "/api/admin/backups/openbase-2026-10-11.tar.gz");
    await user.click(screen.getByRole("button", { name: /Create backup now/ }));
    await waitFor(() => expect(api.callsTo("POST /api/admin/backups")).toHaveLength(1));
  });
});
