/** Run history of one automation: paged, newest first, each run expandable to its step log. */
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, History, RefreshCw } from "lucide-react";
import { api, } from "@/api/endpoints";
import { errorMessage } from "@/api/client";
import { keys } from "@/api/keys";
import type { Automation, AutomationRun } from "@/api/types";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime } from "@/lib/format";
import { relativeTime } from "@/lib/relativeTime";
import { formatDuration, isActive, prettyJson, runDuration, triggerInfo, triggerName } from "./runs";
import { StatusBadge, StepLogView } from "./StepLogView";

export const RUNS_PAGE_SIZE = 20;
/** Runs are produced by a background runner and there is no event for them, so the open tab polls. */
const POLL_MS = 5000;

export function RunsTab({ automation, timeZone }: { automation: Pick<Automation, "id" | "enabled">; timeZone: string }) {
  const q = useInfiniteQuery({
    queryKey: keys.automationRuns(automation.id),
    queryFn: ({ pageParam }) => api.automations.runs(automation.id, { limit: RUNS_PAGE_SIZE, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
    refetchInterval: POLL_MS,
  });

  if (q.isPending) {
    return (
      <div className="flex justify-center py-10">
        <Spinner className="size-5" label="Loading runs" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <div role="alert" className="flex flex-col items-center gap-2 py-8 text-center text-[0.8125rem]">
        <p className="text-muted">Could not load the runs: {errorMessage(q.error)}</p>
        <Button size="sm" onClick={() => void q.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const runs = q.data.pages.flatMap((p) => p.runs);
  const total = q.data.pages[0]?.total ?? runs.length;

  if (runs.length === 0) {
    return (
      <EmptyState
        icon={<History />}
        title="No runs yet"
        description={
          automation.enabled
            ? "Runs appear here a moment after the trigger fires. Use Test on the Editor tab to try it now."
            : "This automation is off, so it never runs. Turn it on from the list or the Editor tab, or use Test to try it once."
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.8125rem] text-muted">
          {total} {total === 1 ? "run" : "runs"}, newest first. Finished runs are kept for 30 days.
        </p>
        <Button size="sm" onClick={() => void q.refetch()} loading={q.isRefetching}>
          <RefreshCw aria-hidden className="size-3.5" /> Refresh
        </Button>
      </div>
      <ul className="divide-y divide-line rounded-md border border-line bg-surface" aria-label="Runs">
        {runs.map((run) => (
          <RunRow key={run.id} run={run} timeZone={timeZone} />
        ))}
      </ul>
      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
            Load older runs
          </Button>
        </div>
      )}
    </div>
  );
}

function RunRow({ run, timeZone }: { run: AutomationRun; timeZone: string }) {
  const [open, setOpen] = useState(false);
  const info = triggerInfo(run.trigger_data);
  const started = run.started_at ?? run.created_at;
  const duration = runDuration(run);
  const panelId = `run-${run.id}`;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="grid w-full grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 px-3 py-2 text-left hover:bg-hover sm:grid-cols-[auto_6.5rem_minmax(0,1fr)_auto_5rem]"
      >
        {open ? <ChevronDown aria-hidden className="size-4 text-muted" /> : <ChevronRight aria-hidden className="size-4 text-muted" />}
        <StatusBadge status={run.status} />
        <span className="min-w-0 truncate text-[0.8125rem]">
          <span className="font-medium">{triggerName(info.type)}</span>
          {info.test && <span className="ml-1.5 rounded bg-subtle px-1 text-xs text-muted">test</span>}
          {info.recordId && <span className="ml-1.5 font-mono text-xs text-muted">{info.recordId}</span>}
        </span>
        <span className="col-start-3 text-xs text-muted sm:col-start-auto" title={formatDateTime(started, timeZone)}>
          {isActive(run.status) && !run.started_at ? "Waiting to start" : `Started ${relativeTime(started)}`}
        </span>
        <span className="hidden text-right text-xs text-muted sm:block">{duration === null ? (isActive(run.status) ? "…" : "") : formatDuration(duration)}</span>
      </button>
      <div id={panelId} hidden={!open} className="flex flex-col gap-3 border-t border-line bg-subtle/40 px-4 py-3">
        {open && (
          <>
            <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
              <dt className="text-muted">Started</dt>
              <dd>{formatDateTime(started, timeZone)}</dd>
              <dt className="text-muted">Duration</dt>
              <dd>{duration === null ? "not finished" : formatDuration(duration)}</dd>
              <dt className="text-muted">Attempts</dt>
              <dd>{run.attempts}</dd>
            </dl>
            {run.error && <Notice tone="error">{run.error}</Notice>}
            <StepLogView log={run.log} empty={isActive(run.status) ? "No step has finished yet." : "No actions ran."} />
            <details className="text-xs">
              <summary className="cursor-pointer text-muted">Trigger data</summary>
              <pre className="mt-1 max-h-60 overflow-auto rounded bg-subtle p-2">{prettyJson(run.trigger_data)}</pre>
            </details>
          </>
        )}
      </div>
    </li>
  );
}
