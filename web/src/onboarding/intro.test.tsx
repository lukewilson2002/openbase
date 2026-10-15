import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USER, mockApi, renderApp, renderWithProviders } from "@/test/utils";
import { IntroProvider, useIntro } from "./IntroContext";

afterEach(() => vi.unstubAllGlobals());

const NEW_USER = { ...USER, intro_seen: false };

function routes(over: Record<string, unknown> = {}) {
  return mockApi({
    "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false, public_url: "https://base.example.org", passkeys_enabled: true },
    "GET /api/auth/me": NEW_USER,
    "PATCH /api/auth/me": { ...NEW_USER, intro_seen: true },
    "GET /api/workspaces": [],
    ...over,
  });
}

describe("intro", () => {
  it("opens for someone who has not seen it, with the heading focused", async () => {
    routes();
    renderApp({ route: "/" });
    const dialog = await screen.findByRole("dialog", { name: "A base holds one project" });
    expect(within(dialog).getByText("Step 1 of 3 · Bases")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "A base holds one project" })).toHaveFocus());
  });

  it("stays closed for someone who has seen it", async () => {
    routes({ "GET /api/auth/me": USER });
    renderApp({ route: "/" });
    expect(await screen.findByRole("heading", { name: "Create your first workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not open on the sign-in pages", async () => {
    routes({ "GET /api/auth/me": { status: 401, json: { error: { code: "unauthorized", message: "no" } } } });
    renderApp({ route: "/login" });
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("steps forward and back, and the closing screen has no Next", async () => {
    const user = userEvent.setup();
    routes();
    renderApp({ route: "/" });
    await screen.findByRole("dialog", { name: "A base holds one project" });
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Tables are the lists inside a base" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "A base holds one project" })).toBeInTheDocument();

    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("heading", { name: "Workspaces keep things apart" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Let an assistant do the setup" })).toBeInTheDocument();
    expect(screen.getByText("Optional · Works best for most people")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("skipping closes it and saves that it was seen", async () => {
    const user = userEvent.setup();
    const api = routes();
    renderApp({ route: "/" });
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Skip the intro" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.callsTo("PATCH /api/auth/me").map((c) => c.body)).toEqual([{ intro_seen: true }]);
    expect(screen.getByRole("heading", { name: "Create your first workspace" })).toBeInTheDocument();
  });

  it("Escape skips it", async () => {
    const user = userEvent.setup();
    const api = routes();
    renderApp({ route: "/" });
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.callsTo("PATCH /api/auth/me")).toHaveLength(1);
  });

  it("\"I'll do it myself\" finishes it for good", async () => {
    const user = userEvent.setup();
    const api = routes();
    // After the save, the server says it was seen (the next /me must not bring it back).
    api.set("GET /api/auth/me", () => (api.callsTo("PATCH /api/auth/me").length ? { ...NEW_USER, intro_seen: true } : NEW_USER));
    renderApp({ route: "/" });
    await screen.findByRole("dialog");
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "I'll do it myself" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.callsTo("PATCH /api/auth/me")[0]?.body).toEqual({ intro_seen: true });
  });

  it("\"Connect an assistant\" finishes it and opens the assistants tab", async () => {
    const user = userEvent.setup();
    const api = routes({ "GET /api/oauth/grants": [] });
    renderApp({ route: "/" });
    await screen.findByRole("dialog");
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Connect an assistant" }));
    expect(await screen.findByRole("heading", { name: "Account settings" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "AI assistants" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.callsTo("PATCH /api/auth/me")).toHaveLength(1);
  });

  it("warns on the closing screen when OpenBase has no public https address", async () => {
    const user = userEvent.setup();
    routes({ "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false, public_url: "http://localhost:8080", passkeys_enabled: false } });
    renderApp({ route: "/" });
    await screen.findByRole("dialog");
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Claude and ChatGPT on the web need OpenBase at a public https address. Claude Code works from this computer now.")).toBeInTheDocument();
  });

  it("has no https warning when the public address is https", async () => {
    const user = userEvent.setup();
    routes();
    renderApp({ route: "/" });
    await screen.findByRole("dialog");
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Let an assistant do the setup" })).toBeInTheDocument();
    expect(screen.queryByText(/need OpenBase at a public https address/)).not.toBeInTheDocument();
  });

  it("replays from useIntro() without touching the saved flag", async () => {
    const user = userEvent.setup();
    const api = routes({ "GET /api/auth/me": USER });
    function Replay() {
      const { openIntro } = useIntro();
      return (
        <button type="button" onClick={openIntro}>
          Replay the intro
        </button>
      );
    }
    renderWithProviders(
      <IntroProvider>
        <Replay />
      </IntroProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Replay the intro" }));
    expect(await screen.findByRole("dialog", { name: "A base holds one project" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip the intro" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.callsTo("PATCH /api/auth/me")).toHaveLength(0);
  });
});
