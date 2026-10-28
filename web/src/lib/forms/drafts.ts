/**
 * The internal "fill in form" mode (and the builder's preview) lets people type into the same
 * editors the expanded record uses. Those editors report either parsed JSON (`json`) or the text
 * the person typed (`text`, parsed here exactly like the expanded record does with `parseText`).
 * This turns the drafts of all fields into the values of one new record, and finds the problems:
 * text a field cannot hold, and required fields left empty.
 */
import type { Field, Filter } from "@/api/types";
import { isEmptyValue, toWire } from "@/lib/cells/wire";
import { parseText, type ParseCtx } from "@/lib/cells/parse";
import { fieldDefault, type FormItem } from "./formConfig";
import { shownEntries } from "./showIf";

/** What a field editor last reported (`EditValue` of the record editors). */
export interface Draft {
  json?: unknown;
  text?: string;
}

export type Drafts = Readonly<Record<string, Draft>>;

export interface FormEntry {
  field: Field;
  required: boolean;
  showIf?: Filter | null;
}

export interface ResolvedForm {
  /** Values in wire form (links as ids), non-empty fields only, ready for `POST /records`. */
  values: Record<string, unknown>;
  errors: Record<string, string>;
}

type One = { ok: true; value: unknown } | { ok: false; error: string };

function resolveDraft(field: Field, draft: Draft | undefined, ctx: ParseCtx): One {
  if (!draft) return { ok: true, value: null };
  if (draft.text !== undefined) {
    // Links are picked, never typed.
    if (field.type === "link") return { ok: true, value: null };
    const parsed = parseText(field, draft.text, ctx);
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: parsed.error };
  }
  return { ok: true, value: draft.json ?? null };
}

/** The drafts a form starts with: the defaults of its fields (text and number fields have one). */
export function defaultDrafts(items: readonly FormItem[]): Drafts {
  const out: Record<string, Draft> = {};
  for (const item of items) {
    if (item.kind !== "field") continue;
    const d = fieldDefault(item.field);
    if (d !== null) out[item.field.id] = { json: d };
  }
  return out;
}

/** The stored (wire) answer of a question, or null when it is empty or not valid yet. */
export function answerOfDraft(field: Field, draft: Draft | undefined, ctx: ParseCtx): unknown {
  const res = resolveDraft(field, draft, ctx);
  return res.ok && !isEmptyValue(res.value) ? toWire(field, res.value) : null;
}

/** The ids of the entries shown, going down the form: a show-if reads the answers of the shown questions above it. */
export function shownItems(items: readonly FormItem[], drafts: Drafts, ctx: ParseCtx): Set<string> {
  const byId = new Map(items.flatMap((i) => (i.kind === "field" ? [[i.field.id, i.field] as const] : [])));
  return shownEntries(
    items.map((i) =>
      i.kind === "field"
        ? { id: i.field.id, showIf: i.entry.show_if, answer: () => answerOfDraft(i.field, drafts[i.field.id], ctx) }
        : { id: i.entry.field_id, showIf: i.entry.show_if },
    ),
    (id) => byId.get(id),
    "skip",
  );
}

/** Resolve the drafts of the entries (those in `shown`, when given: a hidden question is neither checked nor sent). */
export function resolveForm(entries: readonly FormEntry[], drafts: Drafts, ctx: ParseCtx, shown?: ReadonlySet<string>): ResolvedForm {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const { field, required } of entries) {
    if (shown && !shown.has(field.id)) continue;
    const res = resolveDraft(field, drafts[field.id], ctx);
    if (!res.ok) {
      errors[field.id] = res.error;
      continue;
    }
    if (isEmptyValue(res.value)) {
      if (required) errors[field.id] = field.type === "checkbox" ? "This box must be checked." : "This field is required.";
      continue;
    }
    values[field.id] = toWire(field, res.value);
  }
  return { values, errors };
}
