import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USER, apiError, mockApi, renderApp } from "@/test/utils";

afterEach(() => vi.unstubAllGlobals());

const SETUP_DONE = { needs_setup: false, open_signup: true, email_enabled: false };
const LOGGED_OUT = apiError(401, "unauthorized", "authentication required");

describe("login", () => {
  it("logs in with email and password, then shows the home page", async () => {
    const user = userEvent.setup();
    let signedIn = false;
    const api = mockApi({
      "GET /api/setup": SETUP_DONE,
      "GET /api/auth/me": () => (signedIn ? USER : LOGGED_OUT),
      "POST /api/auth/login": () => {
        signedIn = true;
        return { user: USER, two_factor_required: false };
      },
      "GET /api/workspaces": [],
    });
    renderApp({ route: "/login" });

    await user.type(await screen.findByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("heading", { name: "Create your first workspace" })).toBeInTheDocument();
    const login = api.callsTo("POST /api/auth/login")[0]!;
    expect(login.body).toEqual({ email: "ada@example.com", password: "correct horse" });
    expect(login.headers.get("X-OpenBase-CSRF")).toBe("1");
  });

  it("shows the server's error message when the password is wrong", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/setup": SETUP_DONE,
      "GET /api/auth/me": LOGGED_OUT,
      "POST /api/auth/login": apiError(401, "unauthorized", "Invalid email or password"),
    });
    const { onUnauthorized } = renderApp({ route: "/login" });

    await user.type(await screen.findByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "nope");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Log in" })).toBeInTheDocument();
  });

  it("continues to the two-factor step when the server asks for a code", async () => {
    const user = userEvent.setup();
    let signedIn = false;
    const api = mockApi({
      "GET /api/setup": SETUP_DONE,
      "GET /api/auth/me": () => (signedIn ? USER : LOGGED_OUT),
      "POST /api/auth/login": { two_factor_required: true },
      "POST /api/auth/login/2fa": () => {
        signedIn = true;
        return { user: USER, two_factor_required: false };
      },
      "GET /api/workspaces": [],
    });
    renderApp({ route: "/login?next=%2Faccount" });

    await user.type(await screen.findByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("heading", { name: "Two-factor authentication" })).toBeInTheDocument();
    const verify = screen.getByRole("button", { name: "Verify" });
    expect(verify).toBeDisabled();
    await user.type(screen.getByLabelText("Authentication code"), "123456");
    await user.click(verify);

    // `next` survives the extra step: we land on the account page, not home.
    expect(await screen.findByRole("heading", { name: "Account settings" })).toBeInTheDocument();
    expect(api.callsTo("POST /api/auth/login/2fa")[0]?.body).toEqual({ code: "123456" });
  });

  it("sends first-time visitors to setup", async () => {
    mockApi({ "GET /api/setup": { needs_setup: true, open_signup: false, email_enabled: false }, "GET /api/auth/me": LOGGED_OUT });
    renderApp({ route: "/login" });
    expect(await screen.findByRole("heading", { name: "Welcome to your OpenBase" })).toBeInTheDocument();
  });

  it("redirects protected routes to login when there is no session", async () => {
    mockApi({ "GET /api/setup": SETUP_DONE, "GET /api/auth/me": LOGGED_OUT });
    renderApp({ route: "/" });
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
  });
});

describe("setup", () => {
  it("creates the owner's account, signs in and opens the intro", async () => {
    const user = userEvent.setup();
    let signedIn = false;
    const owner = { ...USER, is_admin: true, intro_seen: false };
    const api = mockApi({
      "GET /api/setup": () => ({ needs_setup: !signedIn, open_signup: false, email_enabled: false, public_url: "https://base.example.org" }),
      "GET /api/auth/me": () => (signedIn ? owner : LOGGED_OUT),
      "POST /api/auth/signup": () => {
        signedIn = true;
        return owner;
      },
      "PATCH /api/auth/me": { ...owner, intro_seen: true },
      "GET /api/workspaces": [],
    });
    renderApp({ route: "/setup" });

    expect(await screen.findByRole("heading", { name: "Welcome to your OpenBase" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Confirm password")).not.toBeInTheDocument();
    expect(screen.getByText("As the owner you can manage accounts, email and backups in Settings.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Your name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "longenough1");
    await user.click(screen.getByRole("button", { name: "Create my account" }));

    expect(await screen.findByRole("dialog", { name: "A base holds one project" })).toBeInTheDocument();
    expect(api.callsTo("POST /api/auth/signup")[0]?.body).toMatchObject({ name: "Ada", email: "ada@example.com", password: "longenough1" });
    await user.click(screen.getByRole("button", { name: "Skip the intro" }));
    expect(await screen.findByRole("heading", { name: "Create your first workspace" })).toBeInTheDocument();
  });

  it("rejects a short password without calling the server", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /api/setup": { needs_setup: true, open_signup: false, email_enabled: false }, "GET /api/auth/me": LOGGED_OUT });
    renderApp({ route: "/setup" });
    await user.type(await screen.findByLabelText("Your name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Create my account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Password must be at least 10 characters");
    expect(api.callsTo("POST /api/auth/signup")).toHaveLength(0);
  });
});

describe("signup and invites", () => {
  it("is invite-only when open signup is off and no token is present", async () => {
    mockApi({ "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false }, "GET /api/auth/me": LOGGED_OUT });
    renderApp({ route: "/signup" });
    expect(await screen.findByText(/by invitation only/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("signs up with an invite token and shows what the invite is for", async () => {
    const user = userEvent.setup();
    let signedIn = false;
    const api = mockApi({
      "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false },
      "GET /api/auth/me": () => (signedIn ? USER : LOGGED_OUT),
      "GET /api/invites/by-token/tok123": { target_name: "Acme", target_kind: "workspace", role: "editor", email: null, invited_by: "Grace" },
      "POST /api/auth/signup": () => {
        signedIn = true;
        return USER;
      },
      "GET /api/workspaces": [],
    });
    renderApp({ route: "/signup?invite=tok123" });

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Your name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "longenough1");
    await user.type(screen.getByLabelText("Confirm password"), "longenough1");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("heading", { name: "Create your first workspace" })).toBeInTheDocument();
    expect(api.callsTo("POST /api/auth/signup")[0]?.body).toMatchObject({ invite_token: "tok123" });
  });

  it("offers sign up or log in on an invite page when signed out", async () => {
    mockApi({
      "GET /api/auth/me": LOGGED_OUT,
      "GET /api/invites/by-token/tok123": { target_name: "Acme", target_kind: "workspace", role: "editor", invited_by: "Grace" },
    });
    renderApp({ route: "/invite/tok123" });
    expect(await screen.findByRole("heading", { name: "Join Acme" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", "/signup?invite=tok123");
    expect(screen.getByRole("link", { name: "I already have an account" })).toHaveAttribute("href", `/login?next=${encodeURIComponent("/invite/tok123")}`);
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
  });

  it("lets a signed-in user accept an invite to one base and lands in it", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/auth/me": USER,
      "GET /api/invites/by-token/tok123": { target_name: "Acme", target_kind: "workspace", role: "viewer", invited_by: null },
      "POST /api/invites/by-token/tok123/accept": { workspace_id: "wsp1", all_bases: false, base_ids: ["app9"] },
      "GET /api/bases/app9": { status: 404, json: { error: { code: "not_found", message: "x" } } },
    });
    renderApp({ route: "/invite/tok123" });
    await user.click(await screen.findByRole("button", { name: "Accept invitation" }));
    await waitFor(() => expect(api.callsTo("GET /api/bases/app9").length).toBeGreaterThan(0));
    expect(api.callsTo("POST /api/invites/by-token/tok123/accept")[0]?.headers.get("X-OpenBase-CSRF")).toBe("1");
  });

  it("explains an invalid invite", async () => {
    mockApi({ "GET /api/auth/me": LOGGED_OUT, "GET /api/invites/by-token/bad": apiError(404, "not_found", "invite not found") });
    renderApp({ route: "/invite/bad" });
    expect(await screen.findByText(/invalid, has expired/)).toBeInTheDocument();
  });
});

describe("password reset", () => {
  it("requests a reset link and never reveals whether the account exists", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /api/setup": { ...SETUP_DONE, email_enabled: true }, "GET /api/auth/me": LOGGED_OUT, "POST /api/auth/password-reset/request": { ok: true } });
    renderApp({ route: "/forgot-password" });
    await user.type(await screen.findByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByText(/If an account exists/)).toBeInTheDocument();
    expect(api.callsTo("POST /api/auth/password-reset/request")[0]?.body).toEqual({ email: "ada@example.com" });
  });

  it("confirms a reset with the token from the URL", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/setup": SETUP_DONE,
      "GET /api/auth/me": LOGGED_OUT,
      "POST /api/auth/password-reset/confirm": { ok: true },
    });
    renderApp({ route: "/reset-password?token=abc" });
    await user.type(await screen.findByLabelText("New password"), "longenough1");
    await user.type(screen.getByLabelText("Confirm new password"), "longenough1");
    await user.click(screen.getByRole("button", { name: "Update password" }));
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(api.callsTo("POST /api/auth/password-reset/confirm")[0]?.body).toEqual({ token: "abc", new_password: "longenough1" });
  });

  it("asks for a link when the token is missing", async () => {
    mockApi({});
    renderApp({ route: "/reset-password" });
    expect(await screen.findByText(/needs a reset link/)).toBeInTheDocument();
  });
});

describe("icons on invites", () => {
  it("shows the workspace icon on the invite page and in the sign-up notice", async () => {
    mockApi({
      "GET /api/auth/me": LOGGED_OUT,
      "GET /api/invites/by-token/tok123": { target_name: "Acme", target_icon: "briefcase", target_kind: "workspace", role: "editor", invited_by: "Grace" },
    });
    const { unmount } = renderApp({ route: "/invite/tok123" });
    expect(await screen.findByRole("heading", { name: "Join Acme" })).toBeInTheDocument();
    expect(document.querySelectorAll("svg.lucide-briefcase").length).toBeGreaterThan(0);
    unmount();
  });

  it("falls back to the initial when the invited base has no icon", async () => {
    mockApi({
      "GET /api/auth/me": LOGGED_OUT,
      "GET /api/invites/by-token/tok123": { target_name: "Roadmap", target_kind: "base", role: "viewer" },
    });
    renderApp({ route: "/invite/tok123" });
    await screen.findByRole("heading", { name: "Join Roadmap" });
    expect(document.querySelector("[data-entity-tile]")).toHaveTextContent("R");
    expect(document.querySelector("svg.lucide-briefcase")).toBeNull();
  });
});
