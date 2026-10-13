/** The base's automations: name, what triggers them, an on/off switch and how the last run went. */
import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { Automation } from "@/api/types";
import { NameDialog } from "@/components/NameDialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relativeTime";
import { useAutomationEnv } from "./context";
import { triggerSummary } from "./model";
import { StatusBadge } from "./StepLogView";

export interface AutomationListProps {
  baseId: string;
  automations: Automation[];
  activeId: string | undefined;
  onNew: () => void;
  onDeleted: (id: string) => void;
}

type Dialog = { kind: "rename"; automation: Automation } | { kind: "delete"; automation: Automation };

export function AutomationList({ baseId, automations, activeId, onNew, onDeleted }: AutomationListProps) {
  const { schema } = useAutomationEnv();
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.automations(baseId) });

  const lastRuns = useQueries({
    queries: automations.map((a) => ({
      queryKey: keys.automationLastRun(a.id),
      queryFn: () => api.automations.runs(a.id, { limit: 1 }),
      staleTime: 10_000,
      refetchInterval: 15_000,
    })),
  });

  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.automations.update(v.id, { enabled: v.enabled }),
    onSuccess: refresh,
    onError: (e, v) => toast.error(e, v.enabled ? "Could not turn the automation on" : "Could not turn the automation off"),
  });
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => api.automations.update(v.id, { name: v.name }), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: (id: string) => api.automations.remove(id),
    onSuccess: async (_r, id) => {
      await refresh();
      onDeleted(id);
    },
  });

  if (automations.length === 0) {
    return (
      <EmptyState
        icon={<Zap />}
        title="No automations yet"
        description={
          <>
            An automation runs actions for you when something happens: a record is created or changed, a form is submitted, a schedule fires or a webhook is called. See <code>docs/automations.md</code> for everything it can do.
          </>
        }
        action={
          <Button variant="primary" onClick={onNew}>
            <Plus aria-hidden className="size-4" /> New automation
          </Button>
        }
      />
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-1" aria-label="Automations">
        {automations.map((a, i) => {
          const last = lastRuns[i]?.data?.runs[0];
          const active = a.id === activeId;
          return (
            <li key={a.id} className={cn("group/item flex items-start gap-2 rounded-md border px-3 py-2", active ? "border-primary bg-primary-soft/40" : "border-line bg-surface hover:bg-hover")}>
              <Link to={`/base/${baseId}/automations/${a.id}`} aria-current={active ? "page" : undefined} className="min-w-0 flex-1 text-inherit no-underline">
                <span className="block truncate text-[0.8125rem] font-medium">{a.name}</span>
                <span className="block truncate text-xs text-muted">{triggerSummary(a.trigger, schema)}</span>
                <span className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                  {last ? (
                    <>
                      <StatusBadge status={last.status} />
                      <span>{relativeTime(last.started_at ?? last.created_at)}</span>
                    </>
                  ) : lastRuns[i]?.isPending ? (
                    <span>Loading…</span>
                  ) : (
                    <span>Never run</span>
                  )}
                </span>
              </Link>
              <Switch
                checked={a.enabled}
                disabled={toggle.isPending && toggle.variables?.id === a.id}
                onCheckedChange={(enabled) => toggle.mutate({ id: a.id, enabled })}
                label={<span className="sr-only">{`${a.enabled ? "Turn off" : "Turn on"} ${a.name}`}</span>}
                className="pt-0.5"
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton label={`Options for ${a.name}`} size="sm" noTooltip>
                    <Ellipsis aria-hidden className="size-4" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={() => setDialog({ kind: "rename", automation: a })}>
                    <Pencil aria-hidden className="size-4" /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem danger onSelect={() => setDialog({ kind: "delete", automation: a })}>
                    <Trash2 aria-hidden className="size-4" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ul>
      <NameDialog
        open={dialog?.kind === "rename"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Rename automation"
        initialValue={dialog?.kind === "rename" ? dialog.automation.name : ""}
        onSubmit={(name) => (dialog?.kind === "rename" ? rename.mutateAsync({ id: dialog.automation.id, name }) : undefined)}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Delete ${dialog?.kind === "delete" ? dialog.automation.name : "automation"}?`}
        description="The automation and its run history are deleted for good. Queued runs are dropped."
        confirmLabel="Delete automation"
        destructive
        onConfirm={() => (dialog?.kind === "delete" ? remove.mutateAsync(dialog.automation.id) : undefined)}
      />
    </>
  );
}
