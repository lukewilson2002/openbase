/**
 * Pure logic of the form builder: edits of a view's `FormConfig` (always returning a new object),
 * what a form may contain, and which of its fields the server leaves out of the *public* form.
 *
 * Rules mirrored from the server (crates/server/src/store/views.rs `check_form`, store/sharing.rs
 * `form_fields`; the server stays authoritative):
 *   - computed fields (formulas, lookups, autonumber, ...) can never be part of a form;
 *   - the public form never collects link or user fields (they would need pickers over other data),
 *     and skips fields the form view hides;
 *   - `redirect_url` is an http or https URL with a host, at most 2048 characters;
 *   - texts are limited to 255 characters (title, submit label) and 20,000 (the others).
 */
import type { Field, FormConfig, FormField, Table, ViewConfig } from "@/api/types";
import { isComputed } from "@/lib/cells/kinds";

export const MAX_FORM_TITLE = 255;
export const MAX_FORM_TEXT = 20_000;
export const MAX_REDIRECT_URL = 2048;

export const DEFAULT_SUBMIT_LABEL = "Submit";
export const DEFAULT_SUCCESS_MESSAGE = "Thanks! Your response has been recorded.";

/** Whether the field may be part of a form at all (computed ones may not). */
export function canBeInForm(field: Pick<Field, "type">): boolean {
  return !isComputed(field);
}

export type PublicStatus =
  /** Shown on the public form. */
  | { public: true }
  | { public: false; reason: "link" | "user" | "hidden"; message: string };

const REASONS = {
  link: "Link fields are not collected by public forms, so this field only appears when signed-in editors fill in the form.",
  user: "User fields are not collected by public forms, so this field only appears when signed-in editors fill in the form.",
  hidden: "This field is hidden in the form view, so the public form leaves it out.",
} as const;

/** Whether the public form (share link) shows this field, and why not when it does not. */
export function publicStatus(field: Pick<Field, "id" | "type">, hiddenFields: readonly string[]): PublicStatus {
  if (field.type === "link") return { public: false, reason: "link", message: REASONS.link };
  if (field.type === "user") return { public: false, reason: "user", message: REASONS.user };
  if (hiddenFields.includes(field.id)) return { public: false, reason: "hidden", message: REASONS.hidden };
  return { public: true };
}

/** The form's entries whose field still exists, in form order (a deleted field's stale entry is dropped). */
export function liveEntries(form: FormConfig, table: Pick<Table, "fields">): { entry: FormField; field: Field }[] {
  const byId = new Map(table.fields.map((f) => [f.id, f] as const));
  const out: { entry: FormField; field: Field }[] = [];
  const seen = new Set<string>();
  for (const entry of form.fields) {
    const field = byId.get(entry.field_id);
    if (field && !seen.has(field.id)) {
      seen.add(field.id);
      out.push({ entry, field });
    }
  }
  return out;
}

/** Fields that can still be added: editable and not already in the form, in table order. */
export function addableFields(form: FormConfig, table: Pick<Table, "fields">): Field[] {
  const used = new Set(form.fields.map((f) => f.field_id));
  return table.fields.filter((f) => canBeInForm(f) && !used.has(f.id));
}

export function addFormField(form: FormConfig, table: Pick<Table, "fields">, fieldId: string): FormConfig {
  const field = table.fields.find((f) => f.id === fieldId);
  if (!field || !canBeInForm(field) || form.fields.some((f) => f.field_id === fieldId)) return form;
  return { ...form, fields: [...form.fields, { field_id: fieldId, required: false, label: null, help: null }] };
}

export function addAllFormFields(form: FormConfig, table: Pick<Table, "fields">): FormConfig {
  return addableFields(form, table).reduce((f, field) => addFormField(f, table, field.id), form);
}

export function removeFormField(form: FormConfig, fieldId: string): FormConfig {
  if (!form.fields.some((f) => f.field_id === fieldId)) return form;
  return { ...form, fields: form.fields.filter((f) => f.field_id !== fieldId) };
}

/** Move the entry at `from` to position `to` (indexes into `form.fields`). */
export function moveFormField(form: FormConfig, from: number, to: number): FormConfig {
  const n = form.fields.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return form;
  const next = [...form.fields];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return { ...form, fields: next };
}

/** Reorder by field id (the drag-and-drop list reports ids). */
export function moveFormFieldById(form: FormConfig, activeId: string, overId: string): FormConfig {
  return moveFormField(
    form,
    form.fields.findIndex((f) => f.field_id === activeId),
    form.fields.findIndex((f) => f.field_id === overId),
  );
}

export type FormFieldPatch = Partial<Pick<FormField, "required" | "label" | "help">>;

export function updateFormField(form: FormConfig, fieldId: string, patch: FormFieldPatch): FormConfig {
  let changed = false;
  const fields = form.fields.map((f) => {
    if (f.field_id !== fieldId) return f;
    changed = true;
    return { ...f, ...patch };
  });
  return changed ? { ...form, fields } : form;
}

export type FormSettingsPatch = Partial<Pick<FormConfig, "title" | "description" | "submit_label" | "success_message" | "redirect_url" | "show_submit_another">>;

export function updateFormSettings(form: FormConfig, patch: FormSettingsPatch): FormConfig {
  return { ...form, ...patch };
}

/** `null` when the URL is acceptable (or empty), else what is wrong with it. */
export function redirectUrlProblem(url: string): string | null {
  const text = url.trim();
  if (text === "") return null;
  if (text.length > MAX_REDIRECT_URL) return `The address is longer than ${MAX_REDIRECT_URL} characters.`;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return "Enter a full address such as https://example.com/thanks.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Only http:// and https:// addresses are allowed.";
  if (!parsed.hostname) return "The address needs a host name.";
  return null;
}

/** Empty strings become `null`, so a cleared label falls back to the field name on the server. */
export function cleanFormField(entry: FormField): FormField {
  const trim = (s: string | null | undefined) => (s && s.trim() !== "" ? s : null);
  return { field_id: entry.field_id, required: entry.required, label: trim(entry.label), help: trim(entry.help) };
}

/** What gets saved: cleaned entries and an empty redirect as `null`. */
export function cleanForm(form: FormConfig): FormConfig {
  const redirect = form.redirect_url?.trim() ?? "";
  return { ...form, fields: form.fields.map(cleanFormField), redirect_url: redirect === "" ? null : redirect };
}

/**
 * Drop entries of fields that were deleted or became computed since the form was built; the
 * server refuses a form that names them (unless they were already there).
 */
export function pruneForm(form: FormConfig, table: Pick<Table, "fields">): FormConfig {
  const live = new Set(table.fields.filter(canBeInForm).map((f) => f.id));
  const fields = form.fields.filter((f) => live.has(f.field_id));
  return fields.length === form.fields.length ? form : { ...form, fields };
}

/** Whether two forms would save the same thing. */
export function sameForm(a: FormConfig, b: FormConfig): boolean {
  return JSON.stringify(cleanForm(a)) === JSON.stringify(cleanForm(b));
}

export interface FormSummary {
  /** Fields in the form that exist. */
  total: number;
  /** Fields of the form that a visitor of the public link would see. */
  publicCount: number;
  /** Fields of the form the public link leaves out, with why. */
  excluded: { field: Field; status: Extract<PublicStatus, { public: false }> }[];
  /** A public form needs at least one field; without one the share link would answer with an empty form. */
  publicEmpty: boolean;
}

export function summarizeForm(form: FormConfig, table: Pick<Table, "fields">, config: Pick<ViewConfig, "hidden_fields">): FormSummary {
  const entries = liveEntries(form, table);
  const excluded: FormSummary["excluded"] = [];
  let publicCount = 0;
  for (const { field } of entries) {
    const status = publicStatus(field, config.hidden_fields);
    if (status.public) publicCount++;
    else excluded.push({ field, status });
  }
  return { total: entries.length, publicCount, excluded, publicEmpty: publicCount === 0 };
}
