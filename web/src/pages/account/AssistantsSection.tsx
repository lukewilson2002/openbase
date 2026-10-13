import type { ReactNode } from "react";
import { Link } from "react-router";
import { Accordion, Collapsible } from "radix-ui";
import { ChevronDown, ExternalLink, TriangleAlert } from "lucide-react";
import { errorMessage } from "@/api/client";
import { useSetupStatus } from "@/auth/useAuth";
import { CopyBlock } from "@/components/CopyBlock";
import { CopyField } from "@/components/CopyField";
import { Notice } from "@/components/layouts";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { ChatGPTMark, ClaudeMark, OtherClientsMark } from "./AssistantMarks";
import { ConnectedAppsSection } from "./ConnectedAppsSection";

const DOCS = "https://github.com/openbase/openbase/blob/main/docs/mcp.md";
export const DOCS_ACCESS = `${DOCS}#how-access-works`;
export const DOCS_CLIENTS = `${DOCS}#set-up-your-client`;

/** The MCP address for the server's configured public URL (not the address this browser happens to use). */
export function mcpUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/mcp`;
}

/**
 * Claude and ChatGPT connect from the internet, so they need a public https address. True for
 * anything else: plain http, an unparsable value, or a loopback / `.localhost` name.
 */
export function needsPublicHttps(publicUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return true;
  }
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "::1" || host === "0.0.0.0" || /^127(\.\d{1,3}){3}$/.test(host);
  return url.protocol !== "https:" || local;
}

/** Claude Code with OAuth: sign in afterwards with /mcp. */
export function claudeCodeCommand(url: string): string {
  return `claude mcp add --transport http openbase ${url}`;
}

/** Claude Code with a personal access token instead of OAuth. */
export function claudeCodeTokenCommand(url: string): string {
  return `${claudeCodeCommand(url)} --header "Authorization: Bearer YOUR_TOKEN"`;
}

/** A configuration file for MCP clients that support remote (Streamable HTTP) servers with headers. */
export function genericConfig(url: string): string {
  return JSON.stringify({ mcpServers: { openbase: { type: "http", url, headers: { Authorization: "Bearer YOUR_TOKEN" } } } }, null, 2);
}

export function AssistantsSection() {
  const setup = useSetupStatus();
  const publicUrl = setup.data?.public_url;
  const url = publicUrl === undefined ? null : mcpUrl(publicUrl);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-[0.9375rem]">Let an AI assistant work in OpenBase for you.</p>
        {setup.isError ? (
          <Notice tone="error">{errorMessage(setup.error)}</Notice>
        ) : url === null || publicUrl === undefined ? (
          <Spinner />
        ) : (
          <>
            <CopyField label="MCP address" copyLabel="Copy MCP address" value={url} />
            {needsPublicHttps(publicUrl) && (
              <p className="flex items-start gap-1.5 text-xs text-muted">
                <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                <span>Claude and ChatGPT connect from the internet, so they need OpenBase at a public https address. Claude Code works locally.</span>
              </p>
            )}
          </>
        )}
      </div>

      {url !== null && (
        <>
          <Accordion.Root type="single" collapsible defaultValue="claude" className="divide-y divide-line rounded-lg border border-line bg-surface">
            <AssistantItem value="claude" name="Claude" mark={<ClaudeMark />}>
              <ClaudeSteps url={url} />
            </AssistantItem>
            <AssistantItem value="chatgpt" name="ChatGPT" mark={<ChatGPTMark />}>
              <ChatGPTSteps url={url} />
            </AssistantItem>
            <AssistantItem value="others" name="Others" mark={<OtherClientsMark />}>
              <OtherSteps url={url} />
            </AssistantItem>
          </Accordion.Root>
          <p className="-mt-3 text-xs">
            <ExternalDocLink href={DOCS_ACCESS}>How access works</ExternalDocLink>
          </p>
        </>
      )}

      <ConnectedAppsSection />
    </div>
  );
}

function AssistantItem({ value, name, mark, children }: { value: string; name: string; mark: ReactNode; children: ReactNode }) {
  return (
    <Accordion.Item value={value} className="group/item">
      <Accordion.Header className="flex">
        <Accordion.Trigger
          className={cn(
            "flex w-full items-center gap-3 px-4 py-3 text-left text-[0.9375rem] font-semibold transition-colors hover:bg-hover",
            "focus-visible:-outline-offset-2 group-first/item:rounded-t-lg group-last/item:rounded-b-lg [&[data-state=open]]:rounded-b-none",
          )}
        >
          {mark}
          {name}
          <ChevronDown aria-hidden className="ml-auto size-4 shrink-0 text-muted transition-transform group-data-[state=open]/item:rotate-180" />
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Content className="px-4 pb-4 pt-1">{children}</Accordion.Content>
    </Accordion.Item>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h4 className="text-[0.8125rem] font-semibold">{children}</h4>;
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="flex list-decimal flex-col gap-2.5 pl-5 text-[0.8125rem] marker:text-muted">{children}</ol>;
}

function ExternalDocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
      {children}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}

/** A collapsed "Use a token instead" for clients or setups that cannot sign in with OAuth. */
function TokenDisclosure({ children }: { children: ReactNode }) {
  return (
    <Collapsible.Root className="group/token">
      <Collapsible.Trigger className="inline-flex items-center gap-1 rounded text-xs font-medium text-muted hover:text-fg">
        <ChevronDown aria-hidden className="size-3.5 -rotate-90 transition-transform group-data-[state=open]/token:rotate-0" />
        Use a token instead
      </Collapsible.Trigger>
      <Collapsible.Content className="mt-2 flex flex-col gap-2">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

function CreateTokenLine() {
  return (
    <p className="text-xs text-muted">
      Replace YOUR_TOKEN with one from{" "}
      <Link to="/account?tab=tokens" className="text-primary underline-offset-2 hover:underline">
        API tokens
      </Link>
      .
    </p>
  );
}

function ClaudeSteps({ url }: { url: string }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2.5">
        <SubHeading>Claude Desktop &amp; claude.ai</SubHeading>
        <Steps>
          <li>
            Open <b>Customize → Connectors</b> and choose <b>Add custom connector</b>.
          </li>
          <li>
            <span>
              Name it <b>OpenBase</b> and paste the URL.
            </span>
            <div className="mt-1.5">
              <CopyField label="Connector URL" copyLabel="Copy connector URL" value={url} />
            </div>
          </li>
          <li>
            Choose <b>Add</b>, then <b>Connect</b> and approve access in OpenBase.
          </li>
          <li>
            In a chat, turn it on under <b>+ → Connectors</b>.
          </li>
        </Steps>
      </div>

      <div className="flex flex-col gap-2.5">
        <SubHeading>Claude Code</SubHeading>
        <CopyBlock label="Claude Code command" copyLabel="Copy command" value={claudeCodeCommand(url)} />
        <p className="text-[0.8125rem]">
          Run <code className="rounded bg-subtle px-1 py-0.5 font-mono text-xs">/mcp</code> inside Claude Code to sign in.
        </p>
        <TokenDisclosure>
          <CopyBlock label="Claude Code command with a token" copyLabel="Copy token command" value={claudeCodeTokenCommand(url)} />
          <CreateTokenLine />
        </TokenDisclosure>
      </div>
    </div>
  );
}

function ChatGPTSteps({ url }: { url: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      <Steps>
        <li>
          Turn on <b>Developer mode</b> in Settings (under Apps &amp; Connectors or Security).
        </li>
        <li>
          <span>
            Create a connector named <b>OpenBase</b> with this URL and <b>OAuth</b> as authentication.
          </span>
          <div className="mt-1.5">
            <CopyField label="Connector URL" copyLabel="Copy connector URL" value={url} />
          </div>
        </li>
        <li>Sign in to OpenBase and approve access.</li>
        <li>In a chat, enable OpenBase in the tools.</li>
      </Steps>
      <p className="text-xs text-muted">Needs a Plus, Pro, Business, Enterprise or Edu plan.</p>
    </div>
  );
}

function OtherSteps({ url }: { url: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[0.8125rem]">Any MCP client that supports remote HTTP servers. Add this URL and sign in with OAuth when asked.</p>
      <CopyField label="Server URL" copyLabel="Copy server URL" value={url} />
      <TokenDisclosure>
        <CopyBlock label="MCP client configuration" copyLabel="Copy configuration" value={genericConfig(url)} />
        <CreateTokenLine />
      </TokenDisclosure>
      <p className="text-xs text-muted">
        <ExternalDocLink href={DOCS_CLIENTS}>Notes for specific clients</ExternalDocLink>
      </p>
    </div>
  );
}
