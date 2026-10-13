import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PasskeyInfo } from "@/api/types";
import { ADMIN, ADMIN_USER_ROW, USER, apiError, mockApi, renderApp } from "@/test/utils";

// The browser's WebAuthn calls are replaced; the conversions (lib/webauthn.test.ts) are real.
const webauthn = vi.hoisted(() => ({
  supported: true,
  conditional: false,
  create: vi.fn(),
  get: vi.fn(),
}));
vi.mock("@/lib/webauthn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webauthn")>();
  return {
    ...actual,
    passkeysSupported: () => webauthn.supported,
    conditionalMediationSupported: async () => webauthn.conditional,
    createPasskey: webauthn.create,
    getPasskey: webauthn.get,
    defaultPasskeyName: () => "Chrome on macOS",
  };
});

// Leaving the app for the server's own pages is observed, not performed (jsdom cannot navigate).
const follow = vi.hoisted(() => vi.fn());
vi.mock("@/lib/oauthAccess", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/oauthAccess")>()), followRedirect: follow }));

beforeEach(() => {
  follow.mockReset();
  webauthn.supported = true;
  webauthn.conditional = false;
  webauthn.create.mockReset();
  webauthn.get.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const ORIGIN = window.location.origin;
const SETUP_ON = { needs_setup: false, open_signup: false, email_enabled: false, public_url: ORIGIN, passkeys_enabled: true };
const LOGGED_OUT = apiError(401, "unauthorized", "authentication required");

const MAC: PasskeyInfo = { id: "pky1", name: "MacBook", created_at: 1_700_000_000_000, last_used_at: 1_700_100_000_000, transports: ["internal"], backup_eligible: true, backup_state: true };
const KEY: PasskeyInfo = { id: "pky2", name: "Security key", created_at: 1_690_000_000_000, last_used_at: null, transports: ["usb"], backup_eligible: false, backup_state: false };

describe("Account -> Security -> Passkeys", () => {
  it("lists the passkeys with when they were added and last used", async () => {
    mockApi({ "GET /api/setup": SETUP_ON, "GET /api/auth/me": USER, "GET /api/auth/passkeys": [MAC, KEY] });
    renderApp({ route: "/account?tab=security" });
    const list = await screen.findByRole("list", { name: "Your passkeys" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("MacBook");
    expect(items[0]).toHaveTextContent("Synced");
    expect(items[0]).toHaveTextContent(/last used/);
    expect(items[1]).toHaveTextContent("Security key");
    expect(items[1]).toHaveTextContent("never used");
    expect(items[1]).not.toHaveTextContent("Synced");
    expect(screen.getByRole("button", { name: "Add a passkey" })).toBeEnabled();
  });

  it("says there are none yet", async () => {
    mockApi({ "GET /api/setup": SETUP_ON, "GET /api/auth/me": USER, "GET /api/auth/passkeys": [] });
    renderApp({ route: "/account?tab=security" });
    expect(await screen.findByText(/No passkeys yet/)).toBeInTheDocument();
  });

  it("adds a passkey: asks the server, lets the browser create it, and sends the answer with the chosen name", async () => {
    const user = userEvent.setup();
    let list: PasskeyInfo[] = [];
    const credential = { id: "AQID", rawId: "AQID", type: "public-key", response: { attestationObject: "x", clientDataJSON: "y", transports: ["internal"] } };
    webauthn.create.mockResolvedValue(credential);
    const api = mockApi({
      "GET /api/setup": SETUP_ON,
      "GET /api/auth/me": USER,
      "GET /api/auth/passkeys": () => list,
      "POST /api/auth/passkeys/register/start": { challenge_id: "pkc_1", options: { publicKey: { challenge: "BAUG" } } },
      "POST /api/auth/passkeys/register/finish": () => {
        list = [MAC];
        return MAC;
      },
    });
    renderApp({ route: "/account?tab=security" });

    await user.click(await screen.findByRole("button", { name: "Add a passkey" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a passkey" });
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveValue("Chrome on macOS");
    expect(within(dialog).queryByLabelText("Password")).not.toBeInTheDocument();
    await user.clear(name);
    await user.type(name, "MacBook");
    await user.click(within(dialog).getByRole("button", { name: "Add passkey" }));

    await waitFor(() => expect(api.callsTo("POST /api/auth/passkeys/register/finish")).toHaveLength(1));
    expect(api.callsTo("POST /api/auth/passkeys/register/start")[0]?.body).toEqual({});
    expect(webauthn.create).toHaveBeenCalledWith({ publicKey: { challenge: "BAUG" } });
    expect(api.callsTo("POST /api/auth/passkeys/register/finish")[0]?.body).toEqual({ challenge_id: "pkc_1", name: "MacBook", credential });
    expect(await screen.findByText("Passkey added")).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Your passkeys" })).toHaveTextContent("MacBook");
    expect(screen.queryByRole("dialog", { name: "Add a passkey" })).not.toBeInTheDocument();
  });

  it("asks for the password when the session is too old, then continues", async () => {
    const user = userEvent.setup();
    webauthn.create.mockResolvedValue({ id: "AQ" });
    let attempts = 0;
    const api = mockApi({
      "GET /api/setup": SETUP_ON,
      "GET /api/auth/me": USER,
      "GET /api/auth/passkeys": [],
      "POST /api/auth/passkeys/register/start": (call) => {
        attempts += 1;
        if (!(call.body as { password?: string }).password) return apiError(403, "reauth_required", "confirm your password to add a passkey");
        return { challenge_id: "pkc_1", options: { publicKey: {} } };
      },
      "POST /api/auth/passkeys/register/finish": MAC,
    });
    renderApp({ route: "/account?tab=security" });

    await user.click(await screen.findByRole("button", { name: "Add a passkey" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a passkey" });
    await user.click(within(dialog).getByRole("button", { name: "Add passkey" }));
    expect(await within(dialog).findByText("Confirm your password to add a passkey.")).toBeInTheDocument();
    expect(webauthn.create).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText("Password"), "correct horse");
    await user.click(within(dialog).getByRole("button", { name: "Add passkey" }));
    await waitFor(() => expect(api.callsTo("POST /api/auth/passkeys/register/finish")).toHaveLength(1));
    expect(attempts).toBe(2);
    expect(api.callsTo("POST /api/auth/passkeys/register/start")[1]?.body).toEqual({ password: "correct horse" });
  });

  it("shrugs off a closed prompt and explains a device that already has a passkey", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/setup": SETUP_ON,
      "GET /api/auth/me": USER,
      "GET /api/auth/passkeys": [],
      "POST /api/auth/passkeys/register/start": { challenge_id: "pkc_1", options: { publicKey: {} } },
    });
    renderApp({ route: "/account?tab=security" });
    await user.click(await screen.findByRole("button", { name: "Add a passkey" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a passkey" });

    webauthn.create.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"));
    await user.click(within(dialog).getByRole("button", { name: "Add passkey" }));
    expect(await within(dialog).findByText(/prompt was closed/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();

    webauthn.create.mockRejectedValueOnce(new DOMException("dup", "InvalidStateError"));
    await user.click(within(dialog).getByRole("button", { name: "Add passkey" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already has a passkey");
    expect(api.callsTo("POST /api/auth/passkeys/register/finish")).toHaveLength(0);

    // A refusal by the server is shown as it is.
    webauthn.create.mockResolvedValueOnce({ id: "AQ" });
    api.set("POST /api/auth/passkeys/register/finish", apiError(400, "bad_request", "the passkey could not be verified"));
    await user.click(within(dialog).getByRole("button", { name: "Add passkey" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("could not be verified");
  });

  it("renames a passkey", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/setup": SETUP_ON,
      "GET /api/auth/me": USER,
      "GET /api/auth/passkeys": [MAC],
      "PATCH /api/auth/passkeys/pky1": (call) => ({ ...MAC, ...(call.body as object) }),
    });
    renderApp({ route: "/account?tab=security" });
    await user.click(await screen.findByRole("button", { name: "Rename MacBook" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename passkey" });
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveValue("MacBook");
    await user.clear(name);
    await user.type(name, "Work laptop");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/auth/passkeys/pky1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/auth/passkeys/pky1")[0]?.body).toEqual({ name: "Work laptop" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename passkey" })).not.toBeInTheDocument());
  });

  it("removes a passkey only after a confirmation", async () => {
    const user = userEvent.setup();
    let list = [MAC, KEY];
    const api = mockApi({
      "GET /api/setup": SETUP_ON,
      "GET /api/auth/me": USER,
      "GET /api/auth/passkeys": () => list,
      "DELETE /api/auth/passkeys/pky2": () => {
        list = [MAC];
        return { status: 204 };
      },
    });
    renderApp({ route: "/account?tab=security" });
    await user.click(await screen.findByRole("button", { name: "Remove Security key" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Remove Security key?");
    expect(api.callsTo("DELETE /api/auth/passkeys/pky2")).toHaveLength(0);
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(api.callsTo("DELETE /api/auth/passkeys/pky2")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Remove Security key" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove passkey" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/auth/passkeys/pky2")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Security key")).not.toBeInTheDocument());
  });

  it("explains why a passkey cannot be added here instead of failing later", async () => {
    // A browser without WebAuthn.
    webauthn.supported = false;
    mockApi({ "GET /api/setup": SETUP_ON, "GET /api/auth/me": USER, "GET /api/auth/passkeys": [MAC] });
    const first = renderApp({ route: "/account?tab=security" });
    expect(await screen.findByText(/cannot create passkeys here/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Add a passkey" })).toBeDisabled();
    // Existing passkeys can still be managed.
    expect(screen.getByRole("button", { name: "Remove MacBook" })).toBeEnabled();
    first.unmount();

    // A server whose public URL is an IP address.
    webauthn.supported = true;
    mockApi({ "GET /api/setup": { ...SETUP_ON, passkeys_enabled: false }, "GET /api/auth/me": USER, "GET /api/auth/passkeys": [] });
    const second = renderApp({ route: "/account?tab=security" });
    expect(await screen.findByText(/Passkeys are off on this server/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Add a passkey" })).toBeDisabled();
    second.unmount();

    // A page opened at another address than the public URL.
    mockApi({ "GET /api/setup": { ...SETUP_ON, public_url: "https://base.example.com" }, "GET /api/auth/me": USER, "GET /api/auth/passkeys": [] });
    renderApp({ route: "/account?tab=security" });
    expect(await screen.findByText(/belong to https:\/\/base.example.com/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Add a passkey" })).toBeDisabled();
  });
});

describe("login with a passkey", () => {
  it("offers the button only where passkeys work", async () => {
    mockApi({ "GET /api/setup": SETUP_ON, "GET /api/auth/me": LOGGED_OUT });
    const on = renderApp({ route: "/login" });
    expect(await screen.findByRole("button", { name: "Sign in with a passkey" })).toBeInTheDocument();
    on.unmount();

    mockApi({ "GET /api/setup": { ...SETUP_ON, passkeys_enabled: false }, "GET /api/auth/me": LOGGED_OUT });
    const off = renderApp({ route: "/login" });
    await screen.findByRole("heading", { name: "Log in" });
    expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).not.toBeInTheDocument();
    expect(screen.queryByText(/cannot use them here/)).not.toBeInTheDocument();
    off.unmount();

    // Passkeys on at the server, but not in this browser: a plain sentence, no dead button.
    webauthn.supported = false;
    mockApi({ "GET /api/setup": SETUP_ON, "GET /api/auth/me": LOGGED_OUT });
    renderApp({ route: "/login" });
    expect(await screen.findByText(/this browser cannot use them here/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "username");
  });

  it("signs in with the browser's answer and lands where the password login would", async () => {
    const user = userEvent.setup();
    let signedIn = false;
    const credential = { id: "AQID", rawId: "AQID", type: "public-key", response: { authenticatorData: "a", clientDataJSON: "b", signature: "c", userHandle: "d" } };
    webauthn.get.mockResolvedValue(credential);
    const api = mockApi({
      "GET /api/setup": SETUP_ON,
      "GET /api/auth/me": () => (signedIn ? USER : LOGGED_OUT),
      "POST /api/auth/passkey-login/start": { challenge_id: "pkc_9", options: { publicKey: { challenge: "BAUG" } } },
      "POST /api/auth/passkey-login/finish": () => {
        signedIn = true;
        return { user: USER, two_factor_required: false };
      },
      "GET /api/workspaces": [],
    });
    renderApp({ route: "/login" });

    await user.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));
    expect(await screen.findByRole("heading", { name: "Your workspaces" })).toBeInTheDocument();
    expect(webauthn.get).toHaveBeenCalledWith({ publicKey: { challenge: "BAUG" } }, { mediation: undefined, signal: undefined });
    expect(api.callsTo("POST /api/auth/passkey-login/finish")[0]?.body).toEqual({ challenge_id: "pkc_9", credential });
    // No password and no second-factor step were involved.
    expect(api.callsTo("POST /api/auth/login")).toHaveLength(0);
    expect(api.callsTo("POST /api/auth/login/2fa")).toHaveLength(0);
  });

  describe("coming back from signing in to the server's authorization endpoint", () => {
    const AUTHORIZE = "/oauth/authorize?client_id=ocl1&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb&state=s1";
    const LOGIN = `/login?next=${encodeURIComponent(AUTHORIZE)}`;

    function serverWithPasskey() {
      let signedIn = false;
      webauthn.get.mockResolvedValue({ id: "AQID", rawId: "AQID", type: "public-key", response: { authenticatorData: "a", clientDataJSON: "b", signature: "c", userHandle: "d" } });
      return mockApi({
        "GET /api/setup": SETUP_ON,
        "GET /api/auth/me": () => (signedIn ? USER : LOGGED_OUT),
        "POST /api/auth/passkey-login/start": { challenge_id: "pkc_9", options: { publicKey: { challenge: "BAUG" } } },
        "POST /api/auth/passkey-login/finish": () => {
          signedIn = true;
          return { user: USER, two_factor_required: false };
        },
        "GET /api/workspaces": [],
      });
    }

    it("loads the authorization request again with a full page load after the passkey button", async () => {
      const user = userEvent.setup();
      serverWithPasskey();
      renderApp({ route: LOGIN });
      await user.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));
      // /oauth/authorize is answered by the server, not by a route of the app.
      await waitFor(() => expect(follow).toHaveBeenCalledWith(AUTHORIZE));
    });

    it("does the same after a pick from the autofill list", async () => {
      webauthn.conditional = true;
      serverWithPasskey();
      renderApp({ route: LOGIN });
      await waitFor(() => expect(follow).toHaveBeenCalledWith(AUTHORIZE));
    });

    it("still stays in the app for an ordinary next address", async () => {
      const user = userEvent.setup();
      serverWithPasskey();
      renderApp({ route: "/login?next=%2Faccount" });
      await user.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));
      expect(await screen.findByRole("heading", { name: "Account settings" })).toBeInTheDocument();
      expect(follow).not.toHaveBeenCalled();
    });
  });

  it("says why a sign-in failed, and stays quiet when the prompt was closed", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/setup": SETUP_ON,
      "GET /api/auth/me": LOGGED_OUT,
      "POST /api/auth/passkey-login/start": { challenge_id: "pkc_9", options: { publicKey: {} } },
      "POST /api/auth/passkey-login/finish": apiError(401, "invalid_passkey", "that passkey was not accepted; try again, or sign in with your password"),
    });
    const { onUnauthorized } = renderApp({ route: "/login" });
    const button = await screen.findByRole("button", { name: "Sign in with a passkey" });

    webauthn.get.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"));
    await user.click(button);
    await waitFor(() => expect(webauthn.get).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    webauthn.get.mockResolvedValueOnce({ id: "AQ" });
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("that passkey was not accepted");
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(api.callsTo("POST /api/auth/passkey-login/finish")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Log in" })).toBeInTheDocument();
  });

  it("waits in the background for a pick from the email field's autofill list, and gives way to the button", async () => {
    const user = userEvent.setup();
    webauthn.conditional = true;
    const aborted: boolean[] = [];
    // The conditional request never resolves by itself; it ends when the page aborts it.
    webauthn.get.mockImplementation((_options: unknown, opts: { mediation?: string; signal?: AbortSignal }) =>
      opts.mediation === "conditional"
        ? new Promise((_resolve, reject) => {
            opts.signal?.addEventListener("abort", () => {
              aborted.push(true);
              reject(new DOMException("aborted", "AbortError"));
            });
          })
        : Promise.resolve({ id: "AQ" }),
    );
    let signedIn = false;
    mockApi({
      "GET /api/setup": SETUP_ON,
      "GET /api/auth/me": () => (signedIn ? USER : LOGGED_OUT),
      "POST /api/auth/passkey-login/start": { challenge_id: "pkc_9", options: { publicKey: {} } },
      "POST /api/auth/passkey-login/finish": () => {
        signedIn = true;
        return { user: USER, two_factor_required: false };
      },
      "GET /api/workspaces": [],
    });
    renderApp({ route: "/login" });

    const email = await screen.findByLabelText("Email");
    await waitFor(() => expect(email).toHaveAttribute("autocomplete", "username webauthn"));
    await waitFor(() => expect(webauthn.get).toHaveBeenCalledWith({ publicKey: {} }, expect.objectContaining({ mediation: "conditional", signal: expect.any(AbortSignal) })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Using the button cancels the waiting request first (a page can have one at a time).
    await user.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    expect(await screen.findByRole("heading", { name: "Your workspaces" })).toBeInTheDocument();
    expect(aborted.length).toBeGreaterThan(0);
  });

  it("signs in from the autofill list", async () => {
    webauthn.conditional = true;
    let signedIn = false;
    webauthn.get.mockResolvedValue({ id: "AQ", type: "public-key" });
    mockApi({
      "GET /api/setup": SETUP_ON,
      "GET /api/auth/me": () => (signedIn ? USER : LOGGED_OUT),
      "POST /api/auth/passkey-login/start": { challenge_id: "pkc_9", options: { publicKey: {} } },
      "POST /api/auth/passkey-login/finish": () => {
        signedIn = true;
        return { user: USER, two_factor_required: false };
      },
      "GET /api/workspaces": [],
    });
    renderApp({ route: "/login?next=%2Faccount" });
    expect(await screen.findByRole("heading", { name: "Account settings" })).toBeInTheDocument();
  });
});

describe("Administration -> Users", () => {
  it("removes all of a user's passkeys after a confirmation", async () => {
    const user = userEvent.setup();
    let row = { ...ADMIN_USER_ROW, totp_enabled: false, passkey_count: 2 };
    const api = mockApi({
      "GET /api/auth/me": ADMIN,
      "GET /api/admin/users": () => [{ ...ADMIN_USER_ROW, id: "usr0", name: "Root Admin", email: "root@example.com", is_admin: true, totp_enabled: false }, row],
      "DELETE /api/admin/users/usr1/passkeys": () => {
        row = { ...row, passkey_count: 0 };
        return { removed: 2 };
      },
    });
    renderApp({ route: "/admin?tab=users" });
    expect(await screen.findByText("2 passkeys")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Actions for Ada Lovelace" }));
    await user.click(await screen.findByRole("menuitem", { name: /Remove passkeys/ }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Remove all passkeys of Ada Lovelace?");
    expect(api.callsTo("DELETE /api/admin/users/usr1/passkeys")).toHaveLength(0);
    await user.click(within(confirm).getByRole("button", { name: "Remove passkeys" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/admin/users/usr1/passkeys")).toHaveLength(1));
    expect(await screen.findByText("2 passkeys removed")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("2 passkeys")).not.toBeInTheDocument());
  });

  it("offers the action only for users who have passkeys", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /api/auth/me": ADMIN, "GET /api/admin/users": [{ ...ADMIN_USER_ROW, passkey_count: 0 }] });
    renderApp({ route: "/admin?tab=users" });
    await user.click(await screen.findByRole("button", { name: "Actions for Ada Lovelace" }));
    await screen.findByRole("menuitem", { name: /Create password reset link/ });
    expect(screen.queryByRole("menuitem", { name: /Remove passkeys/ })).not.toBeInTheDocument();
  });
});
