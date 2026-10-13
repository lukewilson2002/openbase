/** Display helpers for runs and their step logs. Pure. */
import type { AutomationRun, JsonValue, RunStatus, StepLog, StepStatus } from "@/api/types";

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
};

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
};

/** "340 ms", "1.2 s", "2 min 5 s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const min = Math.floor(s / 60);
  const rest = Math.round(s - min * 60);
  return rest === 0 ? `${min} min` : `${min} min ${rest} s`;
}

/** How long a run took from its first attempt, or null while it has not finished. */
export function runDuration(run: Pick<AutomationRun, "created_at" | "started_at" | "finished_at">): number | null {
  if (run.finished_at === null || run.finished_at === undefined) return null;
  return Math.max(0, run.finished_at - (run.started_at ?? run.created_at));
}

export function isActive(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

function asObject(v: JsonValue): Record<string, JsonValue> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

export interface TriggerInfo {
  /** `record_created`, `webhook`, ... */
  type: string;
  test: boolean;
  recordId: string | null;
  /** Webhook body or other detail worth showing next to the raw JSON. */
  hasBody: boolean;
}

/** What fired a run, from `trigger_data` (`{type, time, record?, body?, test?}`). */
export function triggerInfo(data: JsonValue): TriggerInfo {
  const o = asObject(data);
  const record = o ? asObject(o["record"] ?? null) : null;
  return {
    type: typeof o?.["type"] === "string" ? o["type"] : "unknown",
    test: o?.["test"] === true,
    recordId: typeof record?.["id"] === "string" ? record["id"] : null,
    hasBody: o?.["body"] !== undefined && o["body"] !== null,
  };
}

const TRIGGER_NAMES: Record<string, string> = {
  record_created: "Record created",
  record_updated: "Record updated",
  record_matches: "Record matches",
  form_submitted: "Form submitted",
  schedule: "Schedule",
  webhook: "Webhook",
};

export function triggerName(type: string): string {
  return TRIGGER_NAMES[type] ?? type;
}

/** Short description of one log line's step, e.g. "Step 2 · create_record". System lines have no index. */
export function stepTitle(step: Pick<StepLog, "index" | "action">): string {
  const name = step.action.replace(/_/g, " ");
  return step.index === null || step.index === undefined ? name : `Step ${step.index + 1}: ${name}`;
}

export function prettyJson(value: JsonValue | undefined): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
