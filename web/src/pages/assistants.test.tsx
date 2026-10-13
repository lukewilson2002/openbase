import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USER, apiError, mockApi, renderApp } from "@/test/utils";
import { claudeCodeCommand, claudeCodeTokenCommand, genericConfig, mcpUrl, needsPublicHttps } from "./account/AssistantsSection";

afterEach(() => vi.unstubAllGlobals());

const PUBLIC = "https://base.example.org";
const MCP = `${PUBLIC}/mcp`;

function setup(publicUrl: string = PUBLIC) {
  return { needs_setup: false, open_signup: false, email_enabled: false, public_url: publicUrl };
}

function render(publicUrl: string = PUBLIC, extra: Record<string, unknown> = {}) {
  const api = mockApi({ "GET /api/auth/me": USER, "GET /api/setup": setup(publicUrl), "GET /api/tokens": [], "GET /api/oauth/grants": [], ...extra });
  renderApp({ route: "/account?tab=assistants" });
  return api;
}

const trigger = (name: string) => screen.getByRole("button", { name });

describe("assistants: address helpers", () => {
  it("builds the MCP address from the configured public URL, with or without a trailing slash", () => {
    expect(mcpUrl("https://base.example.org")).toBe(MCP);
    expect(mcpUrl("https://base.example.org/")).toBe(MCP);
    expect(mcpUrl("http://localhost:8080")).toBe("http://localhost:8080/mcp");
  });

  it("asks for a public https address for anything but https on a real host", () => {
    for (const ok of ["https://base.example.org", "https://base.example.org:8443", "https://openbase.fly.dev"]) expect(needsPublicHttps(ok), ok).toBe(false);
    for (const bad of [
      "http://base.example.org",
      "http://localhost:8080",
      "https://localhost",
      "https://app.localhost",
      "http://127.0.0.1:8080",
      "https://127.0.0.1",
      "http://[::1]:8080",
      "https://0.0.0.0",
      "not a url",
      "",
    ]) {
      expect(needsPublicHttps(bad), bad).toBe(true);
    }
  });

  it("formats the commands and the configuration around the address", () => {
    expect(claudeCodeCommand(MCP)).toBe(`claude mcp add --transport http openbase ${MCP}`);
    expect(claudeCodeTokenCommand(MCP)).toBe(`claude mcp add --transport http openbase ${MCP} --header "Authorization: Bearer YOUR_TOKEN"`);
    expect(JSON.parse(genericConfig(MCP))).toEqual({ mcpServers: { openbase: { type: "http", url: MCP, headers: { Authorization: "Bearer YOUR_TOKEN" } } } });
  });
});

describe("account: AI assistants tab", () => {
  it("opens with one sentence and the MCP address from the server's public URL, not the browser's", async () => {
    render();
    expect(await screen.findByText("Let an AI assistant work in OpenBase for you.")).toBeInTheDocument();
    expect(await screen.findByLabelText("MCP address")).toHaveValue(MCP);
    expect(MCP).not.toContain(window.location.origin);
  });

  it("shows three sections, Claude open and the others closed, and only one open at a time", async () => {
    const user = userEvent.setup();
    render();
    await screen.findByLabelText("MCP address");
    expect(trigger("Claude")).toHaveAttribute("aria-expanded", "true");
    expect(trigger("ChatGPT")).toHaveAttribute("aria-expanded", "false");
    expect(trigger("Others")).toHaveAttribute("aria-expanded", "false");
    // Claude: the desktop steps come first, then Claude Code.
    const headings = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual(["Claude Desktop & claude.ai", "Claude Code"]);
    expect(screen.queryByText(/Developer mode/)).not.toBeInTheDocument();

    await user.click(trigger("ChatGPT"));
    expect(trigger("ChatGPT")).toHaveAttribute("aria-expanded", "true");
    expect(trigger("Claude")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "Claude Code" })).not.toBeInTheDocument();
    expect(screen.getByText(/Developer mode/)).toBeInTheDocument();

    await user.click(trigger("Others"));
    expect(trigger("Others")).toHaveAttribute("aria-expanded", "true");
    expect(trigger("ChatGPT")).toHaveAttribute("aria-expanded", "false");
  });

  it("opens and closes a section from the keyboard", async () => {
    const user = userEvent.setup();
    render();
    await screen.findByLabelText("MCP address");
    trigger("ChatGPT").focus();
    await user.keyboard("{Enter}");
    expect(trigger("ChatGPT")).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(trigger("ChatGPT")).toHaveAttribute("aria-expanded", "false");
  });

  it("each section has a brand mark and the names are plain buttons", async () => {
    render();
    await screen.findByLabelText("MCP address");
    for (const name of ["Claude", "ChatGPT", "Others"]) expect(trigger(name).querySelector("svg")).not.toBeNull();
    // The marks are decorative: the accessible name is the text alone.
    expect(trigger("Claude").querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("gives short, specific steps for Claude Desktop and claude.ai", async () => {
    render();
    await screen.findByLabelText("MCP address");
    const steps = within(screen.getByRole("list"));
    expect(steps.getAllByRole("listitem")).toHaveLength(4);
    expect(steps.getAllByRole("listitem")[0]).toHaveTextContent("Customize → Connectors");
    expect(steps.getAllByRole("listitem")[0]).toHaveTextContent("Add custom connector");
    expect(steps.getAllByRole("listitem")[2]).toHaveTextContent("Connect");
    expect(steps.getAllByRole("listitem")[3]).toHaveTextContent("+ → Connectors");
    expect(screen.getByText(/inside Claude Code to sign in/)).toHaveTextContent("Run /mcp");
  });

  it("explains ChatGPT in four steps with the plans that support it", async () => {
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole("button", { name: "ChatGPT" }));
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("Developer mode");
    expect(items[0]).toHaveTextContent("Apps & Connectors or Security");
    expect(items[1]).toHaveTextContent("OAuth");
    expect(items[3]).toHaveTextContent("enable OpenBase in the tools");
    expect(screen.getByText(/Plus, Pro, Business, Enterprise or Edu/)).toBeInTheDocument();
  });

  it("points other clients at the address, OAuth, and the docs", async () => {
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole("button", { name: "Others" }));
    expect(screen.getByText(/supports remote HTTP servers/)).toBeInTheDocument();
    expect(screen.getByText(/sign in with OAuth when asked/)).toBeInTheDocument();
    expect(screen.getByLabelText("Server URL")).toHaveValue(MCP);
    const notes = screen.getByRole("link", { name: "Notes for specific clients" });
    expect(notes).toHaveAttribute("href", expect.stringContaining("docs/mcp.md"));
  });

  it("links 'How access works' to the short section of the docs", async () => {
    render();
    const link = await screen.findByRole("link", { name: "How access works" });
    expect(link.getAttribute("href")).toMatch(/docs\/mcp\.md#how-access-works$/);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  describe("public address warning", () => {
    const WARNING = /need OpenBase at a public https address/;

    it.each(["https://base.example.org", "https://base.example.org/"])("is not shown for %s", async (url) => {
      render(url);
      await screen.findByLabelText("MCP address");
      expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    });

    it.each(["http://localhost:8080", "https://localhost", "http://127.0.0.1:8080", "http://base.example.org"])("is shown, once, for %s", async (url) => {
      render(url);
      expect(await screen.findByText(WARNING)).toBeInTheDocument();
      expect(screen.getAllByText(WARNING)).toHaveLength(1);
      expect(screen.getByText(/Claude Code works locally/)).toBeInTheDocument();
    });
  });

  describe("copy buttons", () => {
    it("copy the configured address from the top field and from the Claude step, with feedback", async () => {
      const user = userEvent.setup();
      render();
      await screen.findByLabelText("MCP address");

      await user.click(screen.getByRole("button", { name: "Copy MCP address" }));
      expect(await navigator.clipboard.readText()).toBe(MCP);
      expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Copy connector URL" }));
      expect(await navigator.clipboard.readText()).toBe(MCP);
      expect(screen.getByLabelText("Connector URL")).toHaveValue(MCP);
    });

    it("copy the Claude Code command for the configured address", async () => {
      const user = userEvent.setup();
      render();
      await screen.findByLabelText("MCP address");
      expect(screen.getByLabelText("Claude Code command")).toHaveTextContent(`claude mcp add --transport http openbase ${MCP}`);
      await user.click(screen.getByRole("button", { name: "Copy command" }));
      expect(await navigator.clipboard.readText()).toBe(`claude mcp add --transport http openbase ${MCP}`);
      expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    });

    it("copy the address from the ChatGPT and Others sections", async () => {
      const user = userEvent.setup();
      render();
      await user.click(await screen.findByRole("button", { name: "ChatGPT" }));
      await user.click(screen.getByRole("button", { name: "Copy connector URL" }));
      expect(await navigator.clipboard.readText()).toBe(MCP);

      await user.click(trigger("Others"));
      await user.click(screen.getByRole("button", { name: "Copy server URL" }));
      expect(await navigator.clipboard.readText()).toBe(MCP);
    });

    it("use the server's address even when the browser is on another one", async () => {
      const user = userEvent.setup();
      render("http://localhost:8080");
      await screen.findByLabelText("MCP address");
      await user.click(screen.getByRole("button", { name: "Copy MCP address" }));
      expect(await navigator.clipboard.readText()).toBe("http://localhost:8080/mcp");
    });
  });

  describe("token disclosures", () => {
    it("are collapsed by default and show the token command only when opened", async () => {
      const user = userEvent.setup();
      render();
      await screen.findByLabelText("MCP address");
      const disclosure = screen.getByRole("button", { name: "Use a token instead" });
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByLabelText("Claude Code command with a token")).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain("YOUR_TOKEN");

      await user.click(disclosure);
      expect(disclosure).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByLabelText("Claude Code command with a token")).toHaveTextContent(`${MCP} --header "Authorization: Bearer YOUR_TOKEN"`);
      await user.click(screen.getByRole("button", { name: "Copy token command" }));
      expect(await navigator.clipboard.readText()).toBe(`claude mcp add --transport http openbase ${MCP} --header "Authorization: Bearer YOUR_TOKEN"`);

      // The link goes to the Tokens tab.
      await user.click(screen.getByRole("link", { name: "API tokens" }));
      expect(await screen.findByRole("heading", { name: "Personal access tokens" })).toBeInTheDocument();
    });

    it("offers a generic client configuration for Others, collapsed until opened", async () => {
      const user = userEvent.setup();
      render();
      await user.click(await screen.findByRole("button", { name: "Others" }));
      const disclosure = screen.getByRole("button", { name: "Use a token instead" });
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByLabelText("MCP client configuration")).not.toBeInTheDocument();

      await user.click(disclosure);
      const config = JSON.parse(screen.getByLabelText("MCP client configuration").textContent ?? "");
      expect(config).toEqual({ mcpServers: { openbase: { type: "http", url: MCP, headers: { Authorization: "Bearer YOUR_TOKEN" } } } });
      await user.click(screen.getByRole("button", { name: "Copy configuration" }));
      expect(JSON.parse(await navigator.clipboard.readText())).toEqual(config);
      // The token itself is never part of the page.
      expect(document.body.textContent).not.toMatch(/pat_/);
    });
  });

  it("no longer carries the old explanations", async () => {
    render();
    await screen.findByLabelText("MCP address");
    for (const gone of [/Which token/, /Connect an AI assistant \(MCP\)/, /Streamable HTTP/, /Read and write/, /never change your password/, /mcp-remote/, /Cursor/]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
  });

  it("lists connected apps below the sections, and only on this tab", async () => {
    const user = userEvent.setup();
    const api = render(PUBLIC, {
      "GET /api/oauth/grants": [
        {
          id: "g1",
          client_name: "Claude",
          client_source: "preregistered",
          redirect_host: "claude.ai",
          write: true,
          manage: false,
          bases: null,
          created_at: 1_800_000_000_000,
          last_used_at: null,
          expires_at: 1_800_000_000_000,
          user_email: null,
          user_name: null,
        },
      ],
    });
    const list = await screen.findByRole("list", { name: "Connected apps" });
    expect(within(list).getByText("Claude")).toBeInTheDocument();
    const sections = screen.getByRole("heading", { name: "Connected apps" });
    expect(sections.compareDocumentPosition(trigger("Others")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(api.callsTo("GET /api/oauth/grants")).toHaveLength(1);

    await user.click(screen.getByRole("tab", { name: "API tokens" }));
    expect(await screen.findByRole("heading", { name: "Personal access tokens" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Connected apps" })).not.toBeInTheDocument();
  });

  it("shows the error and no instructions when the server address cannot be loaded", async () => {
    mockApi({ "GET /api/auth/me": USER, "GET /api/setup": apiError(500, "internal", "Something went wrong."), "GET /api/oauth/grants": [] });
    renderApp({ route: "/account?tab=assistants" });
    expect(await screen.findByText("Something went wrong.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Claude" })).not.toBeInTheDocument();
  });
});
