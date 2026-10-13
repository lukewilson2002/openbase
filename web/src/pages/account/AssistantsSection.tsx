import { Bot, KeyRound } from "lucide-react";
import { CopyBlock } from "@/components/CopyBlock";
import { CopyField } from "@/components/CopyField";
import { Section } from "@/components/layouts";
import { Button } from "@/components/ui/button";

/** Where the MCP server lives: the same origin the app is served from. */
export function mcpEndpoint(origin: string = window.location.origin): string {
  return `${origin.replace(/\/+$/, "")}/mcp`;
}

/** `claude mcp add ...` for Claude Code, with a placeholder where the token goes. */
export function claudeCodeCommand(endpoint: string): string {
  return `claude mcp add --transport http openbase ${endpoint} --header "Authorization: Bearer YOUR_TOKEN"`;
}

/** A configuration file for MCP clients that support remote (Streamable HTTP) servers with headers. */
export function genericConfig(endpoint: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        openbase: {
          type: "http",
          url: endpoint,
          headers: { Authorization: "Bearer YOUR_TOKEN" },
        },
      },
    },
    null,
    2,
  );
}

const TOKEN_KINDS: { name: string; text: string }[] = [
  { name: "Read only", text: "The assistant can look at everything you can see and change nothing. A good start for questions and reports." },
  {
    name: "Read and write",
    text: "It can create and edit records, tables, fields, views, automations and share links as you. It can never do more than your own role allows, and its changes appear in the record history under your name.",
  },
  {
    name: "Limited to bases",
    text: "Pick the bases when you create the token. The assistant then cannot see or touch anything else, and cannot create workspaces or bases.",
  },
  {
    name: "Can manage workspaces and members",
    text: "Adds workspaces, members, invites, deleting and duplicating bases, and (if you are an administrator) the admin pages. Only for an assistant you fully trust.",
  },
];

export function AssistantsSection({ onOpenTokens }: { onOpenTokens: () => void }) {
  const endpoint = mcpEndpoint();
  return (
    <Section
      title="Connect an AI assistant (MCP)"
      description="OpenBase speaks the Model Context Protocol, so an AI assistant can do what you can do in the app: build tables, fill in records, run views, set up automations. You do not have to open the app yourself."
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-[0.8125rem] font-semibold">
            <span className="flex size-5 items-center justify-center rounded-full bg-subtle text-xs">1</span> Create a token
          </h3>
          <p className="text-[0.8125rem] text-muted">
            The assistant signs in with a personal access token and acts as you, limited by what the token allows. Create one for it and copy it (it is shown once).
          </p>
          <div>
            <Button onClick={onOpenTokens}>
              <KeyRound aria-hidden className="size-4" /> Create a token
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-[0.8125rem] font-semibold">
            <span className="flex size-5 items-center justify-center rounded-full bg-subtle text-xs">2</span> Point the assistant at this address
          </h3>
          <CopyField label="MCP endpoint" value={endpoint} />
          <p className="text-xs text-muted">Streamable HTTP transport. Send the token as an Authorization: Bearer header.</p>
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="flex items-center gap-2 text-[0.8125rem] font-semibold">
            <span className="flex size-5 items-center justify-center rounded-full bg-subtle text-xs">3</span> Add it to your assistant
          </h3>
          <p className="text-[0.8125rem] text-muted">Replace YOUR_TOKEN with the token you created.</p>
          <CopyBlock label="Claude Code command" copyLabel="Copy command" value={claudeCodeCommand(endpoint)} />
          <CopyBlock label="Generic MCP configuration" copyLabel="Copy configuration" value={genericConfig(endpoint)} />
          <p className="text-xs text-muted">
            The configuration works for clients that support remote MCP servers with custom headers (for example Cursor, Windsurf, VS Code and Claude Code's .mcp.json). Clients that
            only run local programs can use a bridge such as mcp-remote.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-[0.8125rem] font-semibold">
            <Bot aria-hidden className="size-4" /> Which token?
          </h3>
          <dl className="divide-y divide-line rounded-md border border-line">
            {TOKEN_KINDS.map((k) => (
              <div key={k.name} className="px-3 py-2">
                <dt className="text-[0.8125rem] font-medium">{k.name}</dt>
                <dd className="text-xs text-muted">{k.text}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted">
            Whatever the token, an assistant can never change your password, two-factor settings, sessions or tokens. Revoke a token under API tokens at any time and the assistant
            loses access immediately. The full list of what it can do is in docs/mcp.md.
          </p>
        </div>
      </div>
    </Section>
  );
}
