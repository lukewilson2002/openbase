/**
 * Template tokens (`{{trigger.record.fields.Name}}`, `{{steps.1.record_id}}`, ...) offered by the
 * "Insert data" menu, and inserting one into text at the caret. Which tokens exist depends on the
 * trigger (record data, webhook body, neither) and on the action's position (only earlier steps).
 * Mirrors crates/server/src/automations/template.rs and docs/automations.md.
 */
import type { Action, Field } from "@/api/types";
import type { TriggerShape } from "./model";

export interface TemplateToken {
  /** What the menu shows. */
  label: string;
  /** What gets inserted, braces included. */
  token: string;
}

export interface TokenGroup {
  id: string;
  label: string;
  tokens: TemplateToken[];
  /** The group takes a path typed by the person (webhook body keys). */
  bodyPath?: boolean;
}

export interface TemplateContext {
  shape: TriggerShape;
  /** Fields of the table whose records fire the trigger (record and form triggers). */
  fields: readonly Pick<Field, "id" | "name">[];
  /** The actions before the one being edited, in order. */
  earlier: readonly Action[];
}

export const braces = (path: string): string => `{{${path}}}`;

/** Field references use the name, which stays readable; ids are the fallback for names that would break the syntax. */
export function fieldToken(field: Pick<Field, "id" | "name">): string {
  const name = field.name.trim();
  const safe = name !== "" && !name.includes("{{") && !name.includes("}}");
  return braces(`trigger.record.fields.${safe ? name : field.id}`);
}

export function bodyToken(path: string): string | null {
  const clean = path
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean)
    .join(".");
  return clean ? braces(`trigger.body.${clean}`) : null;
}

/** The outputs an action exposes to later actions as `{{steps.N.<key>}}`. */
export function stepOutputs(action: Action): string[] {
  switch (action.type) {
    case "create_record":
    case "update_record":
      return ["record_id", "table_id"];
    case "http_request":
      return ["status", "body", "json"];
    case "send_email":
      return ["sent_to"];
    case "notify":
      return ["notified"];
  }
}

export function templateGroups(ctx: TemplateContext): TokenGroup[] {
  const groups: TokenGroup[] = [
    {
      id: "trigger",
      label: "Trigger",
      tokens: [
        { label: "Trigger type", token: braces("trigger.type") },
        { label: "Trigger time", token: braces("trigger.time") },
      ],
    },
  ];
  if (ctx.shape === "record") {
    groups.push({
      id: "record",
      label: "Trigger record",
      tokens: [{ label: "Record id", token: braces("trigger.record.id") }, { label: "Table id", token: braces("trigger.record.table_id") }, ...ctx.fields.map((f) => ({ label: f.name || f.id, token: fieldToken(f) }))],
    });
  }
  if (ctx.shape === "webhook") groups.push({ id: "body", label: "Webhook body", tokens: [], bodyPath: true });
  ctx.earlier.forEach((action, i) => {
    groups.push({
      id: `step-${i + 1}`,
      label: `Step ${i + 1}: ${actionLabel(action)}`,
      tokens: stepOutputs(action).map((key) => ({ label: key, token: braces(`steps.${i + 1}.${key}`) })),
    });
  });
  return groups;
}

function actionLabel(action: Action): string {
  switch (action.type) {
    case "create_record":
      return "Create record";
    case "update_record":
      return "Update record";
    case "send_email":
      return "Send email";
    case "http_request":
      return "HTTP request";
    case "notify":
      return "Notify";
  }
}

/** `text` with `token` replacing the selection `[start, end)`; `caret` is just after the token. */
export function insertToken(text: string, token: string, start: number | null, end: number | null): { text: string; caret: number } {
  const s = clampIndex(start ?? text.length, text.length);
  const e = Math.max(s, clampIndex(end ?? s, text.length));
  return { text: text.slice(0, s) + token + text.slice(e), caret: s + token.length };
}

function clampIndex(n: number, max: number): number {
  return Math.min(max, Math.max(0, n));
}

/** True when the text holds a `{{...}}` placeholder (then a typed editor cannot hold the value). */
export function hasTemplate(value: unknown): boolean {
  return typeof value === "string" && value.includes("{{");
}
