import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsentRequest } from "@/api/types";
import { USER, apiError, makeWorkspace, mockApi, renderApp } from "@/test/utils";

const follow = vi.hoisted(() => vi.fn());
vi.mock("@/lib/oauthAccess", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/oauthAccess")>()), followRedirect: follow }));

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => follow.mockReset());

const REQUEST: ConsentRequest = {
  id: "oar1",
  client_id: "ocl1",
  client_name: "Fancy App",
  client_source: "dcr",
  redirect_uri: "https://app.example.com/cb",
  redirect_host: "app.example.com",
  loopback: false,
  trusted_host: false,
  impersonates: null,
  requested_access: null,
  max_access: "manage",
  default_access: "read",
  expires_at: 4_000_000_000_000,
};
const ROUTE = "/oauth/consent?request=oar1";
const LOGGED_OUT = apiError(401, "unauthorized", "authentication required");

function consent(over: Partial<ConsentRequest> = {}, extra: Record<string, unknown> = {}) {
  return mockApi({
    "GET /api/auth/me": USER,
    "GET /api/oauth/requests/oar1": { ...REQUEST, ...over },
    "POST /api/oauth/requests/oar1/decision": { redirect_to: "https://app.example.com/cb?code=abc&state=s&iss=https%3A%2F%2Fbase.example" },
    ...extra,
  });
}

describe("OAuth consent page", () => {
  it("names the app and where the access goes, and selects read-only first", async () => {
    consent();
    renderApp({ route: ROUTE });
    expect(await screen.findByRole("heading", { name: /Allow Fancy App to use your OpenBase\?/ })).toBeInTheDocument();
    expect(screen.getByTestId("redirect-host")).toHaveTextContent("app.example.com");
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText(/Read only/)).toBeChecked();
    expect(screen.getByLabelText(/Read & edit/)).not.toBeChecked();
    expect(screen.getByLabelText(/Full control/)).not.toBeChecked();
    expect(screen.getByLabelText("Bases")).toHaveValue("all");
  });

  it("approves with the chosen access and follows the redirect the server returns", async () => {
    const user = userEvent.setup();
    const api = consent();
    renderApp({ route: ROUTE });
    await user.click(await screen.findByLabelText(/Read & edit/));
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(follow).toHaveBeenCalledTimes(1));
    expect(follow).toHaveBeenCalledWith("https://app.example.com/cb?code=abc&state=s&iss=https%3A%2F%2Fbase.example");
    const call = api.callsTo("POST /api/oauth/requests/oar1/decision")[0]!;
    expect(call.body).toEqual({ decision: "approve", access: "write", base_ids: null });
    expect(call.headers.get("X-OpenBase-CSRF")).toBe("1");
    expect(await screen.findByText(/Connected\. Returning to app\.example\.com/)).toBeInTheDocument();
  });

  it("denies without any access level", async () => {
    const user = userEvent.setup();
    const api = consent({}, { "POST /api/oauth/requests/oar1/decision": { redirect_to: "https://app.example.com/cb?error=access_denied" } });
    renderApp({ route: ROUTE });
    await user.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(follow).toHaveBeenCalledWith("https://app.example.com/cb?error=access_denied"));
    expect(api.callsTo("POST /api/oauth/requests/oar1/decision")[0]?.body).toEqual({ decision: "deny" });
    expect(await screen.findByText(/Refused\. Returning to/)).toBeInTheDocument();
  });

  it("offers only what the app asked for, and preselects what the server says", async () => {
    consent({ requested_access: "write", max_access: "write", default_access: "write" });
    renderApp({ route: ROUTE });
    expect(await screen.findByLabelText(/Read & edit/)).toBeChecked();
    expect(screen.getByLabelText(/Read only/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Full control/)).not.toBeInTheDocument();
    expect(screen.getByText(/asked for no more than read & edit/i)).toBeInTheDocument();
  });

  it("offers Full control, with what it adds spelled out, but never preselects it", async () => {
    const user = userEvent.setup();
    const api = consent({ requested_access: "manage", default_access: "write" });
    renderApp({ route: ROUTE });
    const full = await screen.findByLabelText(/Full control/);
    expect(full).not.toBeChecked();
    expect(screen.getByLabelText(/Read & edit/)).toBeChecked();
    expect(screen.getByText(/manage workspaces, members, invites and settings/)).toBeInTheDocument();
    await user.click(full);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.callsTo("POST /api/oauth/requests/oar1/decision")).toHaveLength(1));
    expect(api.callsTo("POST /api/oauth/requests/oar1/decision")[0]?.body).toMatchObject({ access: "manage" });
  });

  it("limits the app to the selected bases and cannot approve with none selected", async () => {
    const user = userEvent.setup();
    const api = consent(
      {},
      {
        "GET /api/workspaces": [
          makeWorkspace("owner", [
            { id: "app1", workspace_id: "wsp1", name: "CRM", color: "green_dark", icon: null, role: "owner", people: [] },
            { id: "app2", workspace_id: "wsp1", name: "Notes", color: "green_dark", icon: null, role: "owner", people: [] },
          ]),
        ],
      },
    );
    renderApp({ route: ROUTE });
    await user.selectOptions(await screen.findByLabelText("Bases"), "some");
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    const group = await screen.findByRole("group", { name: "Allowed bases" });
    await user.click(await within(group).findByLabelText("Acme / CRM"));
    expect(approve).toBeEnabled();
    await user.click(approve);
    await waitFor(() => expect(api.callsTo("POST /api/oauth/requests/oar1/decision")).toHaveLength(1));
    expect(api.callsTo("POST /api/oauth/requests/oar1/decision")[0]?.body).toEqual({ decision: "approve", access: "read", base_ids: ["app1"] });
  });

  describe("warnings", () => {
    it("says it cannot verify an unknown app", async () => {
      consent();
      renderApp({ route: ROUTE });
      expect(await screen.findByText(/OpenBase cannot verify who runs app\.example\.com/)).toBeInTheDocument();
    });

    it("has no warning for a known assistant provider", async () => {
      consent({ client_name: "Claude", redirect_uri: "https://claude.ai/api/mcp/auth_callback", redirect_host: "claude.ai", trusted_host: true });
      renderApp({ route: ROUTE });
      expect(await screen.findByRole("heading", { name: /Allow Claude to use/ })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("warns when an app runs on this computer", async () => {
      consent({ client_name: "My Script", redirect_uri: "http://127.0.0.1:53124/cb", redirect_host: "127.0.0.1:53124", loopback: true });
      renderApp({ route: ROUTE });
      expect(await screen.findByText(/This app runs on your own computer\. Continue only if you just started it\./)).toBeInTheDocument();
      expect(screen.getByTestId("redirect-host")).toHaveTextContent("127.0.0.1:53124");
    });

    it("warns loudly when a name imitates an assistant that is connecting from somewhere else", async () => {
      consent({ client_name: "Claude", impersonates: "Claude", redirect_host: "claude-login.example.net" });
      renderApp({ route: ROUTE });
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("calls itself Claude");
      expect(alert).toHaveTextContent("not from claude-login.example.net");
    });

    it("explains the expected case of a local tool that carries an assistant's name", async () => {
      consent({ client_name: "Claude Code", impersonates: "Claude", loopback: true, redirect_host: "127.0.0.1:5000", redirect_uri: "http://127.0.0.1:5000/cb" });
      renderApp({ route: ROUTE });
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("calls itself Claude and runs on your computer (127.0.0.1:5000)");
      expect(alert).toHaveTextContent("If you did not, deny it");
    });

    it("shows the identity address of an app described by a metadata document", async () => {
      consent({ client_source: "cimd", client_id: "https://app.example.com/oauth/client.json" });
      renderApp({ route: ROUTE });
      expect(await screen.findByText(/App identity: https:\/\/app\.example\.com\/oauth\/client\.json/)).toBeInTheDocument();
    });

    it("shows what the app says about itself as plain text", async () => {
      consent({ client_name: "<img src=x onerror=alert(1)> Evil" });
      const { container } = renderApp({ route: ROUTE });
      expect(await screen.findByRole("heading", { name: /Allow <img src=x onerror=alert\(1\)> Evil to use/ })).toBeInTheDocument();
      expect(container.querySelector("img")).toBeNull();
    });
  });

  it("stays on the page and says what went wrong when the decision fails", async () => {
    const user = userEvent.setup();
    consent({}, { "POST /api/oauth/requests/oar1/decision": apiError(400, "bad_request", "unknown base 'app9'") });
    renderApp({ route: ROUTE });
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("unknown base 'app9'")).toBeInTheDocument();
    expect(follow).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("explains an expired or unknown request instead of showing buttons", async () => {
    mockApi({ "GET /api/auth/me": USER, "GET /api/oauth/requests/oar1": apiError(404, "not_found", "authorization request not found") });
    renderApp({ route: ROUTE });
    expect(await screen.findByText("This request has expired")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open OpenBase" })).toBeInTheDocument();
  });

  it("has nothing to show without a request id", async () => {
    mockApi({ "GET /api/auth/me": USER });
    renderApp({ route: "/oauth/consent" });
    expect(await screen.findByText("This request has expired")).toBeInTheDocument();
  });

  it("asks a signed-out person to log in first and brings them back to the request", async () => {
    const user = userEvent.setup();
    let signedIn = false;
    const api = mockApi({
      "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false },
      "GET /api/auth/me": () => (signedIn ? USER : LOGGED_OUT),
      "POST /api/auth/login": () => {
        signedIn = true;
        return { user: USER, two_factor_required: false };
      },
      "GET /api/oauth/requests/oar1": REQUEST,
    });
    renderApp({ route: ROUTE });
    await user.type(await screen.findByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse");
    expect(api.callsTo("GET /api/oauth/requests/oar1")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("heading", { name: /Allow Fancy App to use your OpenBase\?/ })).toBeInTheDocument();
  });

  describe("coming back from signing in to the server's authorization endpoint", () => {
    const AUTHORIZE = "/oauth/authorize?client_id=ocl1&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb&state=s1";
    const LOGIN = `/login?next=${encodeURIComponent(AUTHORIZE)}`;
    const SETUP = { needs_setup: false, open_signup: false, email_enabled: false };

    it("loads the authorization request again with a full page load once the person is signed in", async () => {
      const user = userEvent.setup();
      let signedIn = false;
      mockApi({
        "GET /api/setup": SETUP,
        "GET /api/auth/me": () => (signedIn ? USER : LOGGED_OUT),
        "POST /api/auth/login": () => {
          signedIn = true;
          return { user: USER, two_factor_required: false };
        },
      });
      renderApp({ route: LOGIN });
      await user.type(await screen.findByLabelText("Email"), "ada@example.com");
      await user.type(screen.getByLabelText("Password"), "correct horse");
      await user.click(screen.getByRole("button", { name: "Log in" }));
      // /oauth/authorize is answered by the server, not by a route of the app.
      await waitFor(() => expect(follow).toHaveBeenCalledWith(AUTHORIZE));
    });

    it("does the same after the two-factor step", async () => {
      const user = userEvent.setup();
      let signedIn = false;
      mockApi({
        "GET /api/setup": SETUP,
        "GET /api/auth/me": () => (signedIn ? USER : LOGGED_OUT),
        "POST /api/auth/login": { two_factor_required: true },
        "POST /api/auth/login/2fa": () => {
          signedIn = true;
          return { user: USER, two_factor_required: false };
        },
      });
      renderApp({ route: LOGIN });
      await user.type(await screen.findByLabelText("Email"), "ada@example.com");
      await user.type(screen.getByLabelText("Password"), "correct horse");
      await user.click(screen.getByRole("button", { name: "Log in" }));
      await user.type(await screen.findByLabelText("Authentication code"), "123456");
      await user.click(screen.getByRole("button", { name: "Verify" }));
      await waitFor(() => expect(follow).toHaveBeenCalledWith(AUTHORIZE));
    });

    it("continues straight away for a person who is already signed in", async () => {
      mockApi({ "GET /api/setup": SETUP, "GET /api/auth/me": USER });
      renderApp({ route: LOGIN });
      await waitFor(() => expect(follow).toHaveBeenCalledWith(AUTHORIZE));
    });

    it("only treats the authorization endpoint as a server page, never another address", async () => {
      mockApi({ "GET /api/setup": SETUP, "GET /api/auth/me": USER, "GET /api/workspaces": [] });
      renderApp({ route: `/login?next=${encodeURIComponent("https://evil.example/oauth/authorize?x=1")}` });
      expect(await screen.findByRole("heading", { name: "Your workspaces" })).toBeInTheDocument();
      expect(follow).not.toHaveBeenCalled();
    });
  });
});
