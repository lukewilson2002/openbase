/**
 * Pure logic of the form builder: edits of a view's `FormConfig` (always returning a new object),
 * what a form may contain, and which of its fields the server leaves out of the *public* form.
 *
 * Rules mirrored from the server (crates/server/src/store/views.rs `check_form`, store/sharing.rs
 * `form_fields`; the server stays authoritative):
 *   - computed fields (formulas, lookups, autonumber, ...) can never be part of a form;
 *   - the public form never collects link or user fields (they would need pickers over other data),
 *     and skips fields the form view hides; such a link or user field cannot be made required
 *     (a newly saved form is refused), since only signed-in editors could be held to it;
 *   - `redirect_url` is an http or https URL with a host, at most 2048 characters;
 *   - texts are limited to 255 characters (title, submit label) and 20,000 (the others);
 *   - a form entry is a question or, with `block`, a heading (its text is the label) or a paragraph (its text is the
 *     help) that has an id of its own; every entry may carry a `show_if` on the questions above it (see ./showIf).
 */
import type { Field, Filter, FormBlock, FormConfig, FormField, PublicFormField, Table, ViewConfig } from "@/api/types";
import { isComputed } from "@/lib/cells/kinds";
import { safeRedirect } from "@/lib/publicErrors";
import { canTestInShowIf, restrictShowIf } from "./showIf";

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

/** Why a field cannot be marked required, or null when it can (the server refuses it for link and user fields). */
export function requiredBlockedReason(field: Pick<Field, "type">): string | null {
  if (field.type === "link") return "Link fields cannot be required: the public form does not ask for them.";
  if (field.type === "user") return "User fields cannot be required: the public form does not ask for them.";
  return null;
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

/** An entry of the form as it is laid out: a question about a table field, or a heading or paragraph. */
export type FormItem = { kind: "field"; entry: FormField; field: Field } | { kind: "block"; entry: FormField; block: FormBlock };

/** Every entry of the form in order: the questions whose field still exists (first mention wins) and the blocks. */
export function liveItems(form: FormConfig, table: Pick<Table, "fields">): FormItem[] {
  const byId = new Map(table.fields.map((f) => [f.id, f] as const));
  const out: FormItem[] = [];
  const seen = new Set<string>();
  for (const entry of form.fields) {
    if (entry.block) {
      if (!seen.has(entry.field_id)) {
        seen.add(entry.field_id);
        out.push({ kind: "block", entry, block: entry.block });
      }
      continue;
    }
    const field = byId.get(entry.field_id);
    if (field && !seen.has(field.id)) {
      seen.add(field.id);
      out.push({ kind: "field", entry, field });
    }
  }
  return out;
}

/** The text a heading or paragraph shows. */
export function blockText(entry: FormField): string {
  return ((entry.block === "heading" ? entry.label : entry.help) ?? "").trim();
}

/** The default a text, number or percent field starts with, as a value to submit (null when it has none). */
export function fieldDefault(field: Pick<Field, "type" | "options">): string | number | null {
  const options = field.options as { default?: string | number | null } | null | undefined;
  const d = options?.default;
  if (field.type === "text") return typeof d === "string" && d !== "" ? d : null;
  if (field.type === "number" || field.type === "percent") return typeof d === "number" ? d : null;
  return null;
}

/** The help shown under a question: the form's own, else the field's description. */
export function helpFor(entry: Pick<FormField, "help">, field: Pick<Field, "description">): string | null {
  return entry.help?.trim() ? entry.help : field.description?.trim() ? field.description : null;
}

/** Fields that can still be added: editable and not already in the form, in table order. */
export function addableFields(form: FormConfig, table: Pick<Table, "fields">): Field[] {
  const used = new Set(form.fields.map((f) => f.field_id));
  return table.fields.filter((f) => canBeInForm(f) && !used.has(f.id));
}

/** An entry taken out of the form, with the place it had, so it can come back as it was. */
export interface RemovedFormField {
  entry: FormField;
  index: number;
}

/** The entry as it re-enters the form: a field that cannot be required is not. */
function restoredEntry(field: Field, removed: RemovedFormField | undefined): FormField {
  if (!removed) return { field_id: field.id, required: false, label: null, help: null };
  return { ...removed.entry, required: removed.entry.required && requiredBlockedReason(field) === null };
}

/** Add a field at the end, or, when it was removed before (`removed`), back to its place with its label, help and required. */
export function addFormField(form: FormConfig, table: Pick<Table, "fields">, fieldId: string, removed?: RemovedFormField): FormConfig {
  const field = table.fields.find((f) => f.id === fieldId);
  if (!field || !canBeInForm(field) || form.fields.some((f) => f.field_id === fieldId)) return form;
  const entry = restoredEntry(field, removed);
  if (!removed) return { ...form, fields: [...form.fields, entry] };
  const fields = [...form.fields];
  fields.splice(Math.min(Math.max(removed.index, 0), fields.length), 0, entry);
  return { ...form, fields };
}

/** Add every field that is left; those removed earlier (`removed`, by field id) keep their settings. */
export function addAllFormFields(form: FormConfig, table: Pick<Table, "fields">, removed?: ReadonlyMap<string, RemovedFormField>): FormConfig {
  return addableFields(form, table).reduce((f, field) => addFormField(f, table, field.id, removed?.get(field.id)), form);
}

/** A fresh id for a heading or paragraph (the server keeps ids that are given). */
export function newBlockId(): string {
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "").slice(0, 14) : Math.random().toString(36).slice(2, 16).padEnd(14, "0");
  return `blk${rand}`;
}

export const NEW_BLOCK_TEXT: Record<FormBlock, string> = { heading: "New section", text: "Some words for the people filling this in" };

/** Add a heading or paragraph at `index` of the form's entries (default: the end). */
export function addFormBlock(form: FormConfig, block: FormBlock, index?: number, id: string = newBlockId()): FormConfig {
  const entry: FormField = {
    field_id: id,
    required: false,
    label: block === "heading" ? NEW_BLOCK_TEXT.heading : null,
    help: block === "text" ? NEW_BLOCK_TEXT.text : null,
    block,
  };
  const fields = [...form.fields];
  fields.splice(index === undefined ? fields.length : Math.min(Math.max(index, 0), fields.length), 0, entry);
  return { ...form, fields };
}

export function removeFormField(form: FormConfig, fieldId: string): FormConfig {
  if (!form.fields.some((f) => f.field_id === fieldId)) return form;
  return { ...form, fields: form.fields.filter((f) => f.field_id !== fieldId) };
}

/** What `removeFormField` takes out, for putting it back. */
export function removedFormField(form: FormConfig, fieldId: string): RemovedFormField | null {
  const index = form.fields.findIndex((f) => f.field_id === fieldId);
  const entry = form.fields[index];
  return entry ? { entry, index } : null;
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

export type FormFieldPatch = Partial<Pick<FormField, "required" | "label" | "help" | "show_if">>;

export function updateFormField(form: FormConfig, fieldId: string, patch: FormFieldPatch): FormConfig {
  let changed = false;
  const fields = form.fields.map((f) => {
    if (f.field_id !== fieldId) return f;
    changed = true;
    return { ...f, ...patch };
  });
  return changed ? { ...form, fields } : form;
}

export type FormSettingsPatch = Partial<Pick<FormConfig, "title" | "description" | "submit_label" | "success_message" | "redirect_url" | "show_submit_another" | "notify_user_ids">>;

export function updateFormSettings(form: FormConfig, patch: FormSettingsPatch): FormConfig {
  return { ...form, ...patch };
}

/** Where `redirect_url` has the new record's id put in. */
export const RECORD_ID_TOKEN = "{record_id}";

/**
 * Where to send people after a submission: the form's redirect address with the new record's id in
 * place of `{record_id}`, or null when the form has none (or it is not an http or https address).
 */
export function redirectAfterSubmit(url: string | null | undefined, recordId: string | null | undefined): string | null {
  if (!url) return null;
  return safeRedirect(url.split(RECORD_ID_TOKEN).join(encodeURIComponent(recordId ?? "")));
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
  const out: FormField = { field_id: entry.field_id, required: entry.block ? false : entry.required, label: trim(entry.label), help: trim(entry.help) };
  if (entry.show_if && entry.show_if.items.length > 0) out.show_if = entry.show_if;
  if (entry.block) out.block = entry.block;
  return out;
}

/** What gets saved: cleaned entries and an empty redirect as `null`. */
export function cleanForm(form: FormConfig): FormConfig {
  const redirect = form.redirect_url?.trim() ?? "";
  return { ...form, fields: form.fields.map(cleanFormField), redirect_url: redirect === "" ? null : redirect };
}

/** Why a show-if can read this question, or null when it can. */
export function showIfBlockedReason(field: Pick<Field, "type">): string | null {
  return canTestInShowIf(field) ? null : "Only text, number, rating, checkbox and select questions can be tested.";
}

/** The questions an entry's show-if may read: the testable questions above it (`index` is its place among the form's entries). */
export function showIfSources(form: FormConfig, table: Pick<Table, "fields">, index: number): Field[] {
  const byId = new Map(table.fields.map((f) => [f.id, f] as const));
  const out: Field[] = [];
  for (const e of form.fields.slice(0, Math.max(index, 0))) {
    const f = !e.block ? byId.get(e.field_id) : undefined;
    if (f && canTestInShowIf(f) && !out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * Drop entries of fields that were deleted or became computed since the form was built; the
 * server refuses a form that names them (unless they were already there). Headings and paragraphs
 * stay, and so does each show-if as far as it reads a question above its entry that a form can test
 * (the server refuses the others).
 */
export function pruneForm(form: FormConfig, table: Pick<Table, "fields">): FormConfig {
  const live = new Set(table.fields.filter(canBeInForm).map((f) => f.id));
  const fields = form.fields.filter((f) => f.block || live.has(f.field_id));
  let changed = fields.length !== form.fields.length;
  const tidy = fields.map((entry, i) => {
    if (!entry.show_if) return entry;
    const showIf: Filter | null = restrictShowIf(entry.show_if, new Set(showIfSources({ ...form, fields }, table, i).map((f) => f.id)));
    if (showIf === entry.show_if) return entry;
    changed = true;
    return { ...entry, show_if: showIf };
  });
  return changed ? { ...form, fields: tidy } : form;
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

/**
 * The form's entries as a visitor of the public link gets them (what `GET /api/public/forms/{token}` would
 * answer), for the builder's preview: the same fields in the same order, with the label, help (the form's own,
 * else the field's description), default, show-if and required marker, and the headings and paragraphs that have
 * some text.
 */
export function previewPublicFields(form: FormConfig, table: Pick<Table, "fields">, hiddenFields: readonly string[]): PublicFormField[] {
  const out: PublicFormField[] = [];
  const known = new Set(table.fields.map((f) => f.id));
  for (const item of liveItems(form, table)) {
    const showIf = restrictShowIf(item.entry.show_if, known);
    if (item.kind === "block") {
      const text = blockText(item.entry);
      if (text === "") continue;
      out.push({
        id: item.entry.field_id,
        label: item.block === "heading" ? text : "",
        help: item.block === "text" ? text : null,
        required: false,
        type: "text",
        options: {},
        default: null,
        show_if: showIf,
        block: item.block,
      });
      continue;
    }
    const { entry, field } = item;
    if (!publicStatus(field, hiddenFields).public) continue;
    out.push({
      id: field.id,
      label: entry.label?.trim() || field.name,
      help: helpFor(entry, field),
      required: entry.required,
      type: field.type,
      options: field.options as PublicFormField["options"],
      default: fieldDefault(field),
      show_if: showIf,
      block: null,
    });
  }
  return out;
}

/** Add the person to the people the form notifies, or take them off. */
export function toggleNotify(form: FormConfig, userId: string, on: boolean): FormConfig {
  const has = form.notify_user_ids.includes(userId);
  if (on === has) return form;
  return { ...form, notify_user_ids: on ? [...form.notify_user_ids, userId] : form.notify_user_ids.filter((u) => u !== userId) };
}
