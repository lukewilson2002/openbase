import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Globe, Monitor, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { ConsentRequest } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { Notice } from "@/components/layouts";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { PageSpinner, Spinner } from "@/components/ui/spinner";
import { ACCESS_HINT, ACCESS_LABEL, ACCESS_ORDER, followRedirect, isAccess, type OAuthAccess } from "@/lib/oauthAccess";

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
        icon={<ShieldAlert />}
        title="This request has expired"
        description={
          <>
            Go back to the app you were connecting and start again. Nothing was shared.
            {detail && <span className="mt-1 block text-xs">{detail}</span>}
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
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list, enabled: limitBases });

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

  if (left) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 py-4 text-center" role="status">
          <Spinner className="size-6" label={left.approved ? "Returning to the app" : "Going back"} />
          <p className="text-[0.9375rem] font-medium">{left.approved ? `Connected. Returning to ${request.redirect_host}...` : `Refused. Returning to ${request.redirect_host}...`}</p>
          <p className="text-[0.8125rem] text-muted">
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
      <h1 className="text-xl leading-snug">
        Allow <span className="break-words font-semibold">{request.client_name}</span> to use your OpenBase?
      </h1>
      <p className="mt-1 text-[0.8125rem] text-muted">
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
        <legend className="mb-2 text-[0.8125rem] font-medium">What can it do?</legend>
        <div role="radiogroup" aria-label="Access" className="flex flex-col gap-2">
          {allowed.map((level) => (
            <label
              key={level}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-line-strong p-3 has-[:checked]:border-primary has-[:checked]:bg-subtle"
            >
              <input type="radio" name="access" value={level} checked={access === level} onChange={() => setAccess(level)} className="mt-1" />
              <span className="flex flex-col gap-0.5">
                <span className="text-[0.875rem] font-medium">{ACCESS_LABEL[level]}</span>
                <span className="text-xs text-muted">{ACCESS_HINT[level]}</span>
              </span>
            </label>
          ))}
        </div>
        {request.requested_access && max !== "manage" && <p className="mt-2 text-xs text-muted">The app asked for no more than {ACCESS_LABEL[max].toLowerCase()}.</p>}
      </fieldset>

      <fieldset className="mt-5">
        <legend className="mb-2 text-[0.8125rem] font-medium">Which bases?</legend>
        <Select
          aria-label="Bases"
          value={limitBases ? "some" : "all"}
          onChange={(e) => {
            setLimitBases(e.target.value === "some");
            if (e.target.value !== "some") setBaseIds([]);
          }}
        >
          <option value="all">All bases I can access</option>
          <option value="some">Only the bases I select</option>
        </Select>
        {limitBases && (
          <div className="mt-2 flex flex-col gap-1.5" role="group" aria-label="Allowed bases">
            {workspaces.isPending ? (
              <Spinner />
            ) : workspaces.isError ? (
              <Notice tone="error">{errorMessage(workspaces.error)}</Notice>
            ) : workspaces.data.every((w) => w.bases.length === 0) ? (
              <p className="text-xs text-muted">You have no bases yet.</p>
            ) : (
              workspaces.data.flatMap((w) =>
                w.bases.map((b) => (
                  <Checkbox
                    key={b.id}
                    checked={baseIds.includes(b.id)}
                    onCheckedChange={(on) => setBaseIds((cur) => (on ? [...cur, b.id] : cur.filter((x) => x !== b.id)))}
                    label={`${w.name} / ${b.name}`}
                  />
                )),
              )
            )}
            {access === "manage" && <p className="text-xs text-muted">An app limited to some bases cannot manage workspaces, members or the admin pages.</p>}
          </div>
        )}
      </fieldset>

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
      <p className="mt-3 text-xs text-muted">You can disconnect the app at any time under Account, AI assistants, Connected apps.</p>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Link to="/" className="mb-6" aria-label="OpenBase home">
        <Logo className="h-10" />
      </Link>
      <div className="w-full max-w-lg rounded-lg border border-line bg-surface p-6 shadow-pop">{children}</div>
    </main>
  );
}

/** Where the access would go: the most useful fact on the page, so it is shown big. */
function Destination({ request }: { request: ConsentRequest }) {
  const Icon = request.loopback ? Monitor : request.trusted_host ? ShieldCheck : Globe;
  return (
    <div className="mt-4 rounded-md border border-line bg-subtle p-3">
      <p className="text-xs text-muted">{request.loopback ? "This app runs on your own computer" : "After you decide, you are sent to"}</p>
      <p className="mt-0.5 flex items-center gap-2 text-[1rem] font-semibold">
        <Icon aria-hidden className="size-5 shrink-0 text-muted" />
        <span data-testid="redirect-host" className="break-all">
          {request.redirect_host}
        </span>
      </p>
      {request.client_source === "cimd" && <p className="mt-1 break-all text-xs text-muted">App identity: {request.client_id}</p>}
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
        <div key={i.key} role="alert" className="flex gap-2 rounded-md border border-line-strong bg-warning-soft px-3 py-2 text-[0.8125rem]">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>{i.text}</p>
        </div>
      ))}
    </div>
  );
}
