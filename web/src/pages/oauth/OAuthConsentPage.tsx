import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Globe, Monitor, ShieldCheck, TriangleAlert } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { ConsentRequest } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { AccessChoice } from "@/components/AccessChoice";
import { FolderLimit } from "@/components/FolderLimit";
import { Notice } from "@/components/layouts";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageSpinner, Spinner } from "@/components/ui/spinner";
import { ACCESS_LABEL, ACCESS_ORDER, NEEDS_ALL_FOLDERS, followRedirect, isAccess, type OAuthAccess } from "@/lib/oauthAccess";

/**
 * Where an app asks to be connected (opened by the server's `GET /oauth/authorize`, at
 * `/oauth/consent?request=<id>`). The server keeps the whole request; this page only shows it and
 * posts the person's decision. Everything the app supplied (its name, its address) is untrusted
 * text and is shown as text, next to what OpenBase itself knows about it.
 */
export function OAuthConsentPage() {
  const [params] = useSearchParams();
  const id = params.get("request") ?? "";
  const request = useQuery({
    queryKey: keys.oauthRequest(id),
    queryFn: () => api.oauth.request(id),
    enabled: id !== "",
    retry: false,
    // A request is decided once; do not refetch it behind the person's back.
    staleTime: Infinity,
  });

  if (!id) return <Expired />;
  if (request.isPending) return <PageSpinner label="Loading the request" />;
  if (request.isError) return <Expired detail={errorMessage(request.error)} />;
  return <Consent request={request.data} />;
}

function Expired({ detail }: { detail?: string }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <EmptyState
        as="h1"
        title="This request has expired"
        description={
          <>
            Go back to the app you were connecting and start again. Nothing was shared.
            {detail && <span className="mt-1 block text-meta">{detail}</span>}
          </>
        }
        action={
          <Button asChild variant="primary">
            <Link to="/">Open OpenBase</Link>
          </Button>
        }
      />
    </main>
  );
}

function Consent({ request }: { request: ConsentRequest }) {
  const { data: me } = useMe();
  const max = isAccess(request.max_access) ? request.max_access : "read";
  const [access, setAccess] = useState<OAuthAccess>(isAccess(request.default_access) ? request.default_access : "read");
  const [limitBases, setLimitBases] = useState(false);
  const [baseIds, setBaseIds] = useState<string[]>([]);
  const [left, setLeft] = useState<{ url: string; approved: boolean } | null>(null);

  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api.oauth.decide(
        request.id,
        approve ? { decision: "approve", access, base_ids: limitBases ? baseIds : null } : { decision: "deny" },
      ),
    onSuccess: (outcome, approve) => {
      setLeft({ url: outcome.redirect_to, approved: approve });
      followRedirect(outcome.redirect_to);
    },
  });

  const allowed = ACCESS_ORDER.slice(0, ACCESS_ORDER.indexOf(max) + 1);
  const cannotApprove = limitBases && baseIds.length === 0;
  // The server preselects what the app asked for and offers every level; going above it is the person's own call.
  const asked = isAccess(request.requested_access) ? request.requested_access : null;
  const beyondRequest = ACCESS_ORDER.indexOf(access) > (asked ? ACCESS_ORDER.indexOf(asked) : 0);

  if (left) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 py-4 text-center" role="status">
          <Spinner className="size-6" label={left.approved ? "Returning to the app" : "Going back"} />
          <p className="text-ui font-medium">{left.approved ? `Connected. Returning to ${request.redirect_host}...` : `Refused. Returning to ${request.redirect_host}...`}</p>
          <p className="text-label text-muted">
            If nothing happens, you can close this tab and go back to the app.{" "}
            <a href={left.url} rel="noreferrer">
              Continue manually
            </a>
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-h2">
        Allow <bdi className="break-words font-semibold">{request.client_name}</bdi> to use your OpenBase?
      </h1>
      <p className="mt-1 text-label text-muted">
        {me ? (
          <>
            You are signed in as <span className="font-medium text-fg">{me.email}</span>. The app acts as you, within the access you choose below.
          </>
        ) : (
          "The app acts as you, within the access you choose below."
        )}
      </p>

      <Destination request={request} />
      <Warnings request={request} />

      <fieldset className="mt-5">
        <legend className="mb-2 text-label font-semibold">What can it do?</legend>
        <AccessChoice
          value={access}
          onChange={setAccess}
          levels={allowed}
          // The server refuses Full control for an app limited to some folders, so the choice says why it is out.
          disabled={limitBases ? { [NEEDS_ALL_FOLDERS]: "Not available for an app limited to some folders." } : undefined}
        />
        {beyondRequest && (
          <p className="mt-2 text-label text-muted" role="status">
            This app asked for less. Give it {access === "manage" ? "full control" : ACCESS_LABEL[access].toLowerCase()} anyway?
          </p>
        )}
      </fieldset>

      <div className="mt-5 flex flex-col gap-2">
        <FolderLimit
          limited={limitBases}
          onLimitedChange={(limited) => {
            setLimitBases(limited);
            // Step down rather than fail on Approve.
            if (limited && access === "manage") setAccess("write");
          }}
          baseIds={baseIds}
          onBaseIdsChange={setBaseIds}
          note="An app limited to some folders cannot have Full control, which reaches beyond single folders."
        />
      </div>

      {decide.isError && (
        <div className="mt-4">
          <Notice tone="error">{errorMessage(decide.error)}</Notice>
        </div>
      )}

      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button onClick={() => decide.mutate(false)} disabled={decide.isPending}>
          Deny
        </Button>
        <Button variant="primary" onClick={() => decide.mutate(true)} loading={decide.isPending} disabled={cannotApprove}>
          Approve
        </Button>
      </div>
      <p className="mt-3 text-meta text-muted">You can disconnect the app, or change its access, at any time under Account, AI assistants.</p>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-10">
      <Link to="/" className="mb-6 rounded-md" aria-label="OpenBase home">
        <Logo className="h-10" />
      </Link>
      <Card className="w-full max-w-lg p-6 max-md:p-5">{children}</Card>
    </main>
  );
}

/** Where the access would go: the most useful fact on the page, so it is shown big. */
function Destination({ request }: { request: ConsentRequest }) {
  const Icon = request.loopback ? Monitor : request.trusted_host ? ShieldCheck : Globe;
  return (
    <div className="mt-4 rounded-md border border-line bg-subtle p-3">
      <p className="text-meta text-muted">{request.loopback ? "This app runs on your own computer" : "After you decide, you are sent to"}</p>
      <p className="mt-0.5 flex items-center gap-2 text-h3 font-semibold">
        <Icon aria-hidden className="size-5 shrink-0 text-muted" />
        <span data-testid="redirect-host" className="break-all">
          {request.redirect_host}
        </span>
      </p>
      {request.client_source === "cimd" && <p className="mt-1 break-all text-meta text-muted">App identity: {request.client_id}</p>}
    </div>
  );
}

function Warnings({ request }: { request: ConsentRequest }) {
  const product = request.impersonates;
  const host = request.redirect_host;
  const items: { key: string; tone: "warning" | "info"; text: string }[] = [];
  if (product && !request.loopback) {
    items.push({
      key: "impersonation",
      tone: "warning",
      text: `This app calls itself ${product}, but ${product} would connect from its own address, not from ${host}. Only continue if you trust whoever sent you here.`,
    });
  } else if (product && request.loopback) {
    items.push({
      key: "impersonation-local",
      tone: "warning",
      text: `This app calls itself ${product} and runs on your computer (${host}). That is normal for a ${product} tool you just started yourself. If you did not, deny it.`,
    });
  } else if (request.loopback) {
    items.push({
      key: "loopback",
      tone: "warning",
      text: "This app runs on your own computer. Continue only if you just started it.",
    });
  } else if (!request.trusted_host) {
    items.push({
      key: "unverified",
      tone: "warning",
      text: `OpenBase cannot verify who runs ${host}. Only continue if you started this connection yourself and trust that address.`,
    });
  }
  if (items.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      {items.map((i) => (
        <div key={i.key} role="alert" className="flex gap-2 rounded-md border border-line-strong bg-warning-soft px-3 py-2 text-label">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>{i.text}</p>
        </div>
      ))}
    </div>
  );
}
