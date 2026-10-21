/** A run's (or test's) step log: one line per action with status, duration, error and output. */
import type { RunStatus, StepLog, StepStatus } from "@/api/types";
import { cn } from "@/lib/cn";
import { RUN_STATUS_LABELS, STEP_STATUS_LABELS, formatDuration, prettyJson, stepTitle } from "./runs";

export function StatusBadge({ status }: { status: RunStatus | StepStatus }) {
  const label = status in RUN_STATUS_LABELS ? RUN_STATUS_LABELS[status as RunStatus] : STEP_STATUS_LABELS[status as StepStatus];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
        status === "succeeded" && "bg-success-soft text-success",
        status === "failed" && "bg-danger-soft text-danger",
        (status === "skipped" || status === "queued") && "bg-subtle text-muted",
        status === "running" && "bg-primary-soft text-primary-text",
      )}
    >
      {label}
    </span>
  );
}

export function StepLogView({ log, empty = "Nothing was logged." }: { log: readonly StepLog[]; empty?: string }) {
  if (log.length === 0) return <p className="text-xs text-muted">{empty}</p>;
  return (
    <ol aria-label="Step log" className="flex flex-col divide-y divide-line rounded-md border border-line">
      {log.map((l, i) => (
        <li key={i} className="flex flex-col gap-1 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.8125rem] font-medium">{stepTitle(l)}</span>
            <StatusBadge status={l.status} />
            <span className="text-xs text-muted">{formatDuration(l.duration_ms)}</span>
            {l.attempt > 1 && <span className="text-xs text-muted">attempt {l.attempt}</span>}
            {l.retry_at ? <span className="text-xs text-muted">will retry at {new Date(l.retry_at).toLocaleTimeString()}</span> : null}
          </div>
          {l.error && (
            <p role="alert" className="text-xs text-danger">
              {l.error}
            </p>
          )}
          {l.output !== undefined && l.output !== null && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted">Output</summary>
              <pre className="mt-1 max-h-60 overflow-auto rounded bg-subtle p-2">{prettyJson(l.output)}</pre>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}
