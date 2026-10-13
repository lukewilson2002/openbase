/**
 * The automation editor's draft and its conversion to the API payloads. Pure: no React, no fetch.
 *
 * A draft is the DTO plus a stable `key` per action (so reordering and removing keep each card's
 * local state). `toCreate` / `toUpdate` produce exactly the JSON the server stores; `isDirty`
 * compares drafts to the saved automation key-order-insensitively (the server returns maps in
 * alphabetical order, the editor inserts in click order).
 */
import type { Action, ActionStep, Automation, BaseSchema, CreateAutomation, Filter, Table, Trigger, UpdateAutomation, View } from "@/api/types";
import { pruneFilter } from "@/lib/cells/filters";
import { describeCron } from "./cron";

export const MAX_ACTIONS = 25;

export type TriggerType = Trigger["type"];
export type ActionType = Action["type"];

export const TRIGGER_TYPES: readonly TriggerType[] = ["record_created", "record_updated", "record_matches", "form_submitted", "schedule", "webhook"];
export const ACTION_TYPES: readonly ActionType[] = ["create_record", "update_record", "send_email", "http_request", "notify"];

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  record_created: "A record is created",
  record_updated: "A record is updated",
  record_matches: "A record matches conditions",
  form_submitted: "A form is submitted",
  schedule: "On a schedule",
  webhook: "A webhook is called",
};

export const TRIGGER_HINTS: Record<TriggerType, string> = {
  record_created: "Fires for records created in the grid, the API, an import or a form (never by an automation).",
  record_updated: "Fires when an editable field changes. Pick fields to watch, or leave it empty for any.",
  record_matches: "Fires when a record starts matching the conditions: created matching, or edited into matching.",
  form_submitted: "Fires when someone submits a form view. The new record also fires \"a record is created\".",
  schedule: "Fires on a cron schedule in a time zone, at most every 5 minutes.",
  webhook: "Fires when something sends a JSON POST to the automation's private URL.",
};

export const ACTION_LABELS: Record<ActionType, string> = {
  create_record: "Create record",
  update_record: "Update record",
  send_email: "Send email",
  http_request: "Send HTTP request",
  notify: "Notify people",
};

export const ACTION_HINTS: Record<ActionType, string> = {
  create_record: "Add a record to a table, with values that can use data from the trigger.",
  update_record: "Change fields of an existing record, such as the one that fired the trigger.",
  send_email: "Send a plain-text email. Needs SMTP to be configured on the server.",
  http_request: "Call an external URL (GET, POST, PUT, PATCH or DELETE).",
  notify: "Send an in-app notification to people with access to this base.",
};

export type TriggerShape = "record" | "webhook" | "schedule";

export function triggerShape(trigger: Trigger): TriggerShape {
  switch (trigger.type) {
    case "webhook":
      return "webhook";
    case "schedule":
      return "schedule";
    default:
      return "record";
  }
}

export function findView(schema: BaseSchema, viewId: string): { table: Table; view: View } | null {
  for (const table of schema.tables) {
    const view = table.views.find((v) => v.id === viewId);
    if (view) return { table, view };
  }
  return null;
}

/** Form views of the base with the table they belong to. */
export function formViews(schema: BaseSchema): { table: Table; view: View }[] {
  return schema.tables.flatMap((table) => table.views.filter((v) => v.type === "form").map((view) => ({ table, view })));
}

/** The table whose records the trigger provides (null for schedule and webhook, or a deleted table). */
export function triggerTable(trigger: Trigger, schema: BaseSchema): Table | null {
  switch (trigger.type) {
    case "record_created":
    case "record_updated":
    case "record_matches":
      return schema.tables.find((t) => t.id === trigger.table_id) ?? null;
    case "form_submitted":
      return findView(schema, trigger.view_id)?.table ?? null;
    default:
      return null;
  }
}

/** A fresh trigger of `type`, or null when the base cannot support it yet (no tables, no form view). */
export function newTrigger(type: TriggerType, schema: BaseSchema, timeZone: string): Trigger | null {
  const first = schema.tables[0];
  switch (type) {
    case "record_created":
      return first ? { type, table_id: first.id } : null;
    case "record_updated":
      return first ? { type, table_id: first.id, field_ids: [] } : null;
    case "record_matches":
      return first ? { type, table_id: first.id, filter: { conjunction: "and", items: [] } } : null;
    case "form_submitted": {
      const form = formViews(schema)[0];
      return form ? { type, view_id: form.view.id } : null;
    }
    case "schedule":
      return { type, cron: "0 9 * * *", timezone: timeZone };
    case "webhook":
      return { type };
  }
}

/** Why a trigger type cannot be chosen yet, or null. */
export function triggerUnavailableReason(type: TriggerType, schema: BaseSchema): string | null {
  if (type === "form_submitted" && formViews(schema).length === 0) return "Create a form view first";
  if (type.startsWith("record") && schema.tables.length === 0) return "Create a table first";
  return null;
}

/** Switching a record trigger to another table drops what referred to the old table's fields. */
export function withTriggerTable(trigger: Trigger, tableId: string): Trigger {
  switch (trigger.type) {
    case "record_created":
      return { ...trigger, table_id: tableId };
    case "record_updated":
      return { type: "record_updated", table_id: tableId, field_ids: [] };
    case "record_matches":
      return { type: "record_matches", table_id: tableId, filter: { conjunction: "and", items: [] } };
    default:
      return trigger;
  }
}

/** A new action of `type`; update_record defaults to the record that fired the trigger. */
export function newAction(type: ActionType, schema: BaseSchema, trigger: Trigger): Action {
  const tableId = triggerTable(trigger, schema)?.id ?? schema.tables[0]?.id ?? "";
  switch (type) {
    case "create_record":
      return { type, table_id: tableId, values: {} };
    case "update_record":
      return { type, table_id: tableId, record_id: triggerShape(trigger) === "record" ? "{{trigger.record.id}}" : "", values: {} };
    case "send_email":
      return { type, to: "", subject: "", body: "" };
    case "http_request":
      return { type, method: "POST", url: "", headers: {}, body: "" };
    case "notify":
      return { type, user_ids: [], message: "" };
  }
}

/** Remove conditions' references to fields of other tables after the trigger table changed. */
export function pruneConditions(steps: readonly DraftStep[], table: Table | null): DraftStep[] {
  const ids = new Set(table?.fields.map((f) => f.id) ?? []);
  return steps.map((s) => {
    if (!s.step.condition) return s;
    if (!table) return { ...s, step: withCondition(s.step, null) };
    const pruned = pruneFilter(s.step.condition, ids);
    return { ...s, step: withCondition(s.step, pruned.items.length === 0 ? null : pruned) };
  });
}

export function withCondition(step: ActionStep, condition: Filter | null): ActionStep {
  const { condition: _old, ...rest } = step;
  return (condition ? { ...rest, condition } : rest) as ActionStep;
}

// ----------------------------------------------------------------- summaries

export function triggerSummary(trigger: Trigger, schema: BaseSchema): string {
  const tableName = (id: string) => schema.tables.find((t) => t.id === id)?.name ?? "a deleted table";
  switch (trigger.type) {
    case "record_created":
      return `A record is created in ${tableName(trigger.table_id)}`;
    case "record_updated": {
      const table = schema.tables.find((t) => t.id === trigger.table_id);
      const names = trigger.field_ids.map((id) => table?.fields.find((f) => f.id === id)?.name ?? "deleted field");
      return `A record in ${tableName(trigger.table_id)} is updated${names.length ? ` (${names.join(", ")})` : ""}`;
    }
    case "record_matches":
      return `A record in ${tableName(trigger.table_id)} matches conditions`;
    case "form_submitted": {
      const found = findView(schema, trigger.view_id);
      return found ? `The form "${found.view.name}" is submitted` : "A form is submitted (the form view was deleted)";
    }
    case "schedule":
      return `${describeCron(trigger.cron)} (${trigger.timezone})`;
    case "webhook":
      return "A webhook is called";
  }
}

export function actionSummary(action: Action, schema: BaseSchema): string {
  const tableName = (id: string) => schema.tables.find((t) => t.id === id)?.name ?? "a deleted table";
  switch (action.type) {
    case "create_record":
      return `Create a record in ${tableName(action.table_id)}`;
    case "update_record":
      return `Update a record in ${tableName(action.table_id)}`;
    case "send_email":
      return action.to.trim() ? `Email ${action.to.trim()}` : "Send an email";
    case "http_request": {
      let host = action.url.trim();
      try {
        host = new URL(action.url.trim()).host || host;
      } catch {
        /* a template or a half-typed URL: show it as typed */
      }
      return host ? `${action.method} ${host}` : `${action.method} request`;
    }
    case "notify":
      return `Notify ${action.user_ids.length} ${action.user_ids.length === 1 ? "person" : "people"}`;
  }
}

// -------------------------------------------------------------------- draft

export interface DraftStep {
  key: string;
  step: ActionStep;
}

export interface Draft {
  name: string;
  trigger: Trigger;
  steps: DraftStep[];
}

let keyCounter = 0;
export function newStepKey(): string {
  keyCounter += 1;
  return `step-${keyCounter}`;
}

export function draftFromAutomation(a: Pick<Automation, "name" | "trigger" | "actions">): Draft {
  return {
    name: a.name,
    trigger: structuredClone(a.trigger),
    steps: a.actions.map((step) => ({ key: newStepKey(), step: structuredClone(step) })),
  };
}

/** The action as sent: no empty condition, no empty request body. */
export function cleanStep(step: ActionStep): ActionStep {
  const out: Record<string, unknown> = { ...step };
  if (!out["condition"]) delete out["condition"];
  if (out["type"] === "http_request" && !out["body"]) delete out["body"];
  return out as ActionStep;
}

export function actionsPayload(steps: readonly DraftStep[]): ActionStep[] {
  return steps.map((s) => cleanStep(s.step));
}

export function toCreate(draft: Draft, enabled = false): CreateAutomation {
  const payload: CreateAutomation = { name: draft.name.trim(), trigger: draft.trigger, actions: actionsPayload(draft.steps) };
  if (enabled) payload.enabled = true;
  return payload;
}

export function toUpdate(draft: Draft): UpdateAutomation {
  return { name: draft.name.trim(), trigger: draft.trigger, actions: actionsPayload(draft.steps) };
}

/** JSON with object keys sorted, so equal values compare equal whatever their insertion order. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, sort(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function isDirty(draft: Draft, saved: Pick<Automation, "name" | "trigger" | "actions">): boolean {
  return canonicalJson(toUpdate(draft)) !== canonicalJson(toUpdate(draftFromAutomation(saved)));
}

// ------------------------------------------------------------------- errors

export interface ParsedSaveError {
  /** 0-based index of the action the server blames (messages start with "action N: "), else null. */
  action: number | null;
  text: string;
}

/** The server prefixes action errors with "action N: " (1-based); everything else is about the trigger or the name. */
export function parseSaveError(message: string): ParsedSaveError {
  const m = /^action (\d+): ([\s\S]*)$/.exec(message);
  if (m) return { action: Number(m[1]) - 1, text: m[2] ?? "" };
  return { action: null, text: message };
}

/** Webhook URL for a token, as an absolute URL for the page's origin. */
export function webhookUrl(token: string, origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/hooks/${token}`;
}
