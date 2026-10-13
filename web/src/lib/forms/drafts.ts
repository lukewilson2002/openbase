/**
 * The internal "fill in form" mode (and the builder's preview) lets people type into the same
 * editors the expanded record uses. Those editors report either parsed JSON (`json`) or the text
 * the person typed (`text`, parsed here exactly like the expanded record does with `parseText`).
 * This turns the drafts of all fields into the values of one new record, and finds the problems:
 * text a field cannot hold, and required fields left empty.
 */
import type { Field } from "@/api/types";
import { isEmptyValue, toWire } from "@/lib/cells/wire";
import { parseText, type ParseCtx } from "@/lib/cells/parse";

/** What a field editor last reported (`EditValue` of the record editors). */
export interface Draft {
  json?: unknown;
  text?: string;
}

export type Drafts = Readonly<Record<string, Draft>>;

export interface FormEntry {
  field: Field;
  required: boolean;
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

export function resolveForm(entries: readonly FormEntry[], drafts: Drafts, ctx: ParseCtx): ResolvedForm {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const { field, required } of entries) {
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
