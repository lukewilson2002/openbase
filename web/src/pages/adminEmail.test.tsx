import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailSettings } from "@/api/types";
import { ADMIN, apiError, mockApi, renderApp } from "@/test/utils";

afterEach(() => vi.unstubAllGlobals());

const OFF: EmailSettings = {
  enabled: false,
  source: "unset",
  host: null,
  port: 587,
  security: "starttls",
  username: null,
  from: "OpenGrid <opengrid@localhost>",
  password_set: false,
  sources: { host: "unset", port: "default", security: "default", username: "unset", password: "unset", from: "default" },
  budgets: { per_user_hour: 100, per_hour: 500 },
};

const ON: EmailSettings = {
  ...OFF,
  enabled: true,
  source: "settings",
  host: "smtp.example.com",
  port: 465,
  security: "tls",
  username: "mailer",
  from: "Grid <grid@example.com>",
  password_set: true,
  sources: { host: "settings", port: "settings", security: "settings", username: "settings", password: "settings", from: "settings" },
};

const ENV: EmailSettings = {
  ...ON,
  source: "environment",
  sources: { ...ON.sources, host: "environment", password: "environment" },
};

function open(settings: EmailSettings, extra: Record<string, unknown> = {}) {
  return mockApi({ "GET /api/auth/me": ADMIN, "GET /api/admin/email": settings, ...extra } as Parameters<typeof mockApi>[0]);
}

describe("admin email tab", () => {
  it("is a tab of the administration page and says email is off", async () => {
    open(OFF);
    renderApp({ route: "/admin" });
    const tab = await screen.findByRole("tab", { name: "Email" });
    await userEvent.setup().click(tab);
    expect(await screen.findByText(/Email is off/)).toBeInTheDocument();
    expect(screen.getByLabelText("Host")).toHaveValue("");
    expect(screen.getByLabelText("Port")).toHaveValue("587");
    expect(screen.getByLabelText("Connection security")).toHaveValue("starttls");
    expect(screen.getByLabelText("From address")).toHaveValue("OpenGrid <opengrid@localhost>");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // no test email without a mail server
    expect(screen.getByRole("button", { name: /Send test email/ })).toBeDisabled();
    expect(screen.getByText(/Enter a mail server and save/)).toBeInTheDocument();
  });

  it("shows the status and the read-only sending limits", async () => {
    open(ON);
    renderApp({ route: "/admin?tab=email" });
    expect(await screen.findByText("Email is on")).toBeInTheDocument();
    expect(screen.getByText("Host saved here")).toBeInTheDocument();
    expect(screen.getByText("smtp.example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("Host")).toHaveValue("smtp.example.com");
    expect(screen.getByLabelText("Username")).toHaveValue("mailer");
    expect(screen.getByText("OPENGRID_EMAIL_PER_HOUR")).toBeInTheDocument();
    expect(screen.getByText("500")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
  });

  it("saves only what changed and keeps the password write-only", async () => {
    const user = userEvent.setup();
    const api = open(OFF, {
      "PATCH /api/admin/email": { ...ON, port: 587, security: "starttls", password_set: true, sources: { ...ON.sources, port: "default", security: "default" } },
    });
    renderApp({ route: "/admin?tab=email" });
    await user.type(await screen.findByLabelText("Host"), "smtp.example.com");
    await user.type(screen.getByLabelText("Username"), "mailer");
    await user.type(screen.getByLabelText("Password"), "s3cret-pw");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/admin/email")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/admin/email")[0]?.body).toEqual({ host: "smtp.example.com", username: "mailer", password: "s3cret-pw" });

    // after saving: the form shows the saved values, and the password only as "Saved"
    expect(await screen.findByText("Email is on")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("s3cret-pw")).not.toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("replaces, keeps and removes the saved password", async () => {
    const user = userEvent.setup();
    const api = open(ON, { "PATCH /api/admin/email": ON });
    renderApp({ route: "/admin?tab=email" });

    // replace, then cancel: nothing to save
    await user.click(await screen.findByRole("button", { name: "Replace" }));
    expect(screen.getByPlaceholderText("New password")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Password"), "x");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Keep the saved password" }));
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    // replace with an empty value keeps the old one (nothing is sent)
    await user.click(screen.getByRole("button", { name: "Replace" }));
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Keep the saved password" }));

    // remove, undo, remove again and save: password null
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText("Will be removed when you save")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/admin/email")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/admin/email")[0]?.body).toEqual({ password: null });
  });

  it("clearing the host turns email off by sending null", async () => {
    const user = userEvent.setup();
    const api = open(ON, { "PATCH /api/admin/email": { ...OFF, port: 465 } });
    renderApp({ route: "/admin?tab=email" });
    await user.clear(await screen.findByLabelText("Host"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/admin/email")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/admin/email")[0]?.body).toEqual({ host: null });
    expect(await screen.findByText(/Email is off/)).toBeInTheDocument();
  });

  it("shows settings from the environment as read-only and never sends them", async () => {
    const user = userEvent.setup();
    const api = open(ENV, { "PATCH /api/admin/email": ENV });
    renderApp({ route: "/admin?tab=email" });
    expect(await screen.findByText("Host set by environment")).toBeInTheDocument();
    expect(screen.getByLabelText("Host")).toBeDisabled();
    expect(screen.getByText(/OPENGRID_SMTP_HOST/)).toBeInTheDocument();
    expect(screen.getByText(/OPENGRID_SMTP_PASSWORD/)).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Replace" })).not.toBeInTheDocument();
    // the others stay editable
    expect(screen.getByLabelText("Username")).toBeEnabled();
    expect(screen.getByLabelText("Port")).toBeEnabled();
    await user.clear(screen.getByLabelText("Username"));
    await user.type(screen.getByLabelText("Username"), "other");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/admin/email")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/admin/email")[0]?.body).toEqual({ username: "other" });
  });

  it("validates the port and warns about unencrypted credentials", async () => {
    const user = userEvent.setup();
    open(ON);
    renderApp({ route: "/admin?tab=email" });
    const port = await screen.findByLabelText("Port");
    await user.clear(port);
    await user.type(port, "99999");
    expect(screen.getByText("1 to 65535")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await user.clear(port);
    await user.type(port, "25");
    expect(screen.queryByText("1 to 65535")).not.toBeInTheDocument();
    expect(screen.queryByText(/sent unencrypted/)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Connection security"), "none");
    expect(screen.getByText(/sent unencrypted/)).toBeInTheDocument();
  });

  it("shows the server's refusal when saving fails", async () => {
    const user = userEvent.setup();
    open(OFF, { "PATCH /api/admin/email": apiError(400, "bad_request", "invalid sender address 'x': missing @") });
    renderApp({ route: "/admin?tab=email" });
    const from = await screen.findByLabelText("From address");
    await user.clear(from);
    await user.type(from, "x");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid sender address 'x': missing @");
    // the form keeps what was typed
    expect(screen.getByLabelText("From address")).toHaveValue("x");
  });

  it("sends a test email to the admin by default and reports success", async () => {
    const user = userEvent.setup();
    const api = open(ON, { "POST /api/admin/email/test": { ok: true, to: "root@example.com" } });
    renderApp({ route: "/admin?tab=email" });
    const send = await screen.findByRole("button", { name: /Send test email/ });
    expect(screen.getByLabelText("Send to")).toHaveAttribute("placeholder", "root@example.com");
    await user.click(send);
    expect(await screen.findByText(/Test email sent to root@example.com/)).toBeInTheDocument();
    expect(api.callsTo("POST /api/admin/email/test")[0]?.body).toEqual({});
  });

  it("sends a test email to another address and shows the real SMTP error on failure", async () => {
    const user = userEvent.setup();
    const api = open(ON, {
      "POST /api/admin/email/test": { ok: false, to: "ops@example.org", error: "Connection error: Connection refused (os error 111)" },
    });
    renderApp({ route: "/admin?tab=email" });
    await user.type(await screen.findByLabelText("Send to"), "ops@example.org");
    await user.click(screen.getByRole("button", { name: /Send test email/ }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/was not sent/)).toBeInTheDocument();
    expect(within(alert).getByText("Connection error: Connection refused (os error 111)")).toBeInTheDocument();
    expect(api.callsTo("POST /api/admin/email/test")[0]?.body).toEqual({ to: "ops@example.org" });
  });

  it("asks to save first when the form has unsaved changes", async () => {
    const user = userEvent.setup();
    open(ON);
    renderApp({ route: "/admin?tab=email" });
    const host = await screen.findByLabelText("Host");
    expect(screen.getByRole("button", { name: /Send test email/ })).toBeEnabled();
    await user.type(host, "x");
    expect(screen.getByRole("button", { name: /Send test email/ })).toBeDisabled();
    expect(screen.getByText(/Save your changes first/)).toBeInTheDocument();
  });

  it("shows an error when the settings cannot be loaded", async () => {
    mockApi({ "GET /api/auth/me": ADMIN, "GET /api/admin/email": apiError(500, "internal", "boom") });
    renderApp({ route: "/admin?tab=email" });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
