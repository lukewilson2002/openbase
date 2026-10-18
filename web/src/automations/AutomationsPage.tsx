/**
 * `/base/:baseId/automations/:automationId?/:tab?` inside the base shell: the list on the left,
 * the selected automation's editor or run history on the right (one at a time on narrow screens).
 * Creators and owners manage automations; the server also lets editors read run history, but it
 * offers them no way to list automations, so the page is for creators.
 */
import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Lock, Plus, Zap } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { Automation, BaseSchema } from "@/api/types";
import { useMe, useSetupStatus } from "@/auth/useAuth";
import { basePermissions } from "@/base/permissions";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { browserTimeZone } from "@/lib/format";
import { cn } from "@/lib/cn";
import { AutomationEditor, type EditorTab } from "./AutomationEditor";
import { AutomationList } from "./AutomationList";
import { AutomationEnvProvider, type AutomationEnv } from "./context";
import { CreateAutomationDialog } from "./CreateAutomationDialog";

export function AutomationsPage({ schema }: { schema: BaseSchema }) {
  const { automationId, tab: tabParam } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const setup = useSetupStatus();
  const [creating, setCreating] = useState(false);
  // Webhook tokens are shown once, in the response that creates or rotates them; keep them for as long as this page is open.
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const allowed = basePermissions.manageAutomations(schema.role);

  const automations = useQuery({ queryKey: keys.automations(schema.id), queryFn: () => api.automations.list(schema.id), enabled: allowed });
  const collaborators = useQuery({ queryKey: keys.baseCollaborators(schema.id), queryFn: () => api.bases.collaborators(schema.id), staleTime: 60_000, enabled: allowed });

  const env = useMemo<AutomationEnv>(
    () => ({
      schema,
      collaborators: collaborators.data ?? [],
      emailEnabled: setup.data?.email_enabled ?? false,
      timeZone: me.data?.timezone || browserTimeZone(),
      currentUserId: me.data?.id ?? null,
    }),
    [schema, collaborators.data, setup.data?.email_enabled, me.data?.timezone, me.data?.id],
  );

  const base = `/base/${schema.id}/automations`;
  const onCreated = useCallback(
    (a: Automation) => {
      if (a.webhook_token) setTokens((t) => ({ ...t, [a.id]: a.webhook_token! }));
      setCreating(false);
      // Put it in the cached list first so the editor can open on it straight away.
      qc.setQueryData<Automation[]>(keys.automations(schema.id), (l) => [...(l ?? []).filter((x) => x.id !== a.id), { ...a, webhook_token: null }]);
      void qc.invalidateQueries({ queryKey: keys.automations(schema.id) });
      navigate(`${base}/${a.id}`);
    },
    [qc, schema.id, base, navigate],
  );

  if (!allowed) {
    return (
      <EmptyState
        icon={<Lock />}
        title="Automations are for creators"
        description="Only creators and owners of this project can see and change its automations. Ask one of them for access."
      />
    );
  }

  const list = automations.data ?? [];
  const selected = automationId ? list.find((a) => a.id === automationId) : undefined;
  const tab: EditorTab = tabParam === "runs" ? "runs" : "editor";

  return (
    <AutomationEnvProvider value={env}>
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-4 px-4 py-5">
        <div className={cn("flex-wrap items-center justify-between gap-3", automationId ? "hidden md:flex" : "flex")}>
          <div>
            <h2 className="flex items-center gap-2 text-xl">
              <Zap aria-hidden className="size-5 text-muted" /> Automations
            </h2>
            <p className="mt-0.5 text-[0.8125rem] text-muted">
              Do things automatically when records change, forms arrive, on a schedule or from a webhook. Reference: <code>docs/automations.md</code>.
            </p>
          </div>
          {list.length > 0 && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus aria-hidden className="size-4" /> New automation
            </Button>
          )}
        </div>

        {automations.isPending ? (
          <div className="flex justify-center py-16">
            <Spinner className="size-6" label="Loading automations" />
          </div>
        ) : automations.isError ? (
          <div role="alert" className="flex flex-col items-center gap-2 py-12 text-center text-[0.8125rem]">
            <p className="text-muted">Could not load the automations: {errorMessage(automations.error)}</p>
            <Button size="sm" onClick={() => void automations.refetch()}>
              Try again
            </Button>
          </div>
        ) : list.length === 0 ? (
          <AutomationList baseId={schema.id} automations={list} activeId={undefined} onNew={() => setCreating(true)} onDeleted={() => {}} />
        ) : (
          <div className="grid gap-5 md:grid-cols-[20rem_minmax(0,1fr)]">
            <div className={cn(automationId && "hidden md:block")}>
              <AutomationList baseId={schema.id} automations={list} activeId={automationId} onNew={() => setCreating(true)} onDeleted={(id) => id === automationId && navigate(base, { replace: true })} />
            </div>
            <div className={cn("min-w-0", !automationId && "hidden md:block")}>
              {automationId ? (
                <>
                  <Button asChild variant="ghost" size="sm" className="mb-3 md:hidden">
                    <Link to={base}>
                      <ArrowLeft aria-hidden className="size-4" /> All automations
                    </Link>
                  </Button>
                  {selected ? (
                    <AutomationEditor
                      key={selected.id}
                      automation={selected}
                      tab={tab}
                      onTabChange={(t) => navigate(`${base}/${selected.id}${t === "runs" ? "/runs" : ""}`)}
                      webhookToken={tokens[selected.id] ?? null}
                      onWebhookToken={(token) => setTokens((t) => ({ ...t, [selected.id]: token }))}
                    />
                  ) : (
                    <EmptyState title="Automation not found" description="It may have been deleted. Pick another one from the list." />
                  )}
                </>
              ) : (
                <EmptyState icon={<Zap />} title="Select an automation" description="Choose one from the list to edit it, test it or see its runs." className="rounded-lg border border-dashed border-line-strong" />
              )}
            </div>
          </div>
        )}
      </div>
      <CreateAutomationDialog open={creating} onOpenChange={setCreating} baseId={schema.id} onCreated={onCreated} />
    </AutomationEnvProvider>
  );
}
