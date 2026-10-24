/**
 * Turns what a visitor typed into a public form into the `values` of `POST /submit`, and finds
 * the problems the visitor can fix before sending: required fields and values the field cannot
 * hold. The server validates again (and wins); this only makes the errors immediate and precise.
 *
 * A public form field arrives as `PublicFormField {id, label, type, options, required}`. Its
 * `options` are the field's own options for every type a public form can collect, so the shared
 * cell parsing (`lib/cells/parse`) is reused through a stand-in `Field`.
 */
import type { AttachmentRef, DateOptions, Field, FormSubmission, PublicFormField, SelectChoice } from "@/api/types";
import { fromInputValue } from "@/lib/cells/dates";
import { parseText } from "@/lib/cells/parse";
import { shownEntries } from "./showIf";

/** What one input holds while the visitor is filling it in. */
export type FormInput = string | number | boolean | string[] | AttachmentRef[] | null | undefined;
export type FormInputs = Readonly<Record<string, FormInput>>;

export type ControlKind = "text" | "textarea" | "email" | "url" | "tel" | "number" | "date" | "datetime" | "select" | "multiselect" | "checkbox" | "rating" | "attachment";

const DATE_DEFAULTS: DateOptions = { include_time: false, date_format: "us", time_format: "h12", timezone: null };

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The date options of a date field of the form. */
export function dateOptionsOfInput(f: Pick<PublicFormField, "options">): DateOptions {
  return { ...DATE_DEFAULTS, ...(obj(f.options) as Partial<DateOptions>) };
}

export function choicesOfInput(f: Pick<PublicFormField, "options">): SelectChoice[] {
  const choices = obj(f.options)["choices"];
  return Array.isArray(choices) ? (choices as SelectChoice[]) : [];
}

export function ratingMaxOfInput(f: Pick<PublicFormField, "options">): number {
  const max = obj(f.options)["max"];
  return typeof max === "number" && max >= 1 ? max : 5;
}

/** Which control a public form field is filled in with. */
export function controlKindOf(f: Pick<PublicFormField, "type" | "options">): ControlKind {
  switch (f.type) {
    case "rich_text":
      return "textarea";
    case "text":
      return obj(f.options)["multiline"] === true ? "textarea" : "text";
    case "number":
    case "currency":
    case "percent":
    case "duration":
      return "number";
    case "email":
      return "email";
    case "url":
      return "url";
    case "phone":
      return "tel";
    case "date":
      return dateOptionsOfInput(f).include_time ? "datetime" : "date";
    case "single_select":
      return "select";
    case "multiple_select":
      return "multiselect";
    case "checkbox":
      return "checkbox";
    case "rating":
      return "rating";
    case "attachment":
      return "attachment";
    default:
      return "text";
  }
}

/** A `Field` that carries the form field's type and options, so the shared parsers can read it. */
export function asField(f: PublicFormField): Field {
  return { id: f.id, table_id: "", name: f.label, description: f.help ?? null, type: f.type, options: f.options } as unknown as Field;
}

/** The input a field starts with (nothing, or unchecked). */
export function emptyInput(f: Pick<PublicFormField, "type" | "options">): FormInput {
  switch (controlKindOf(f)) {
    case "checkbox":
      return false;
    case "multiselect":
    case "attachment":
      return [];
    case "rating":
      return 0;
    default:
      return "";
  }
}

/** The input a field starts with: its default when it has one, else nothing (or unchecked). */
export function initialInput(f: Pick<PublicFormField, "type" | "options" | "default">): FormInput {
  const d = f.default;
  if ((typeof d === "string" && d !== "") || typeof d === "number") return typeof d === "number" ? String(d) : d;
  return emptyInput(f);
}

export function isEmptyInput(v: FormInput): boolean {
  if (v === null || v === undefined || v === false || v === 0) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

export interface Submission {
  values: FormSubmission["values"];
  /** Problems by field id; empty when the form can be sent. */
  errors: Record<string, string>;
}

export interface SubmissionCtx {
  /** The visitor's IANA zone, for dates and times without a fixed zone. */
  timeZone: string;
}

function attachmentJson(a: AttachmentRef): FormSubmission["values"][string] {
  return { id: a.id, filename: a.filename, mime: a.mime, size: a.size, width: a.width ?? null, height: a.height ?? null };
}

/** The value of one input in its stored form: `{ok: true, value: null}` when it is empty. */
function convert(f: PublicFormField, input: FormInput, ctx: SubmissionCtx): { ok: true; value: FormSubmission["values"][string] } | { ok: false; error: string } {
  const none = { ok: true, value: null } as const;
  if (isEmptyInput(input)) return none;
  switch (controlKindOf(f)) {
    case "checkbox":
      return input === true ? { ok: true, value: true } : none;
    case "rating": {
      const max = ratingMaxOfInput(f);
      const n = typeof input === "number" ? input : Number(input);
      if (!Number.isFinite(n) || n < 1 || n > max) return { ok: false, error: `Choose a rating from 1 to ${max}.` };
      return { ok: true, value: Math.round(n) };
    }
    case "select": {
      const id = typeof input === "string" ? input : "";
      return choicesOfInput(f).some((c) => c.id === id) ? { ok: true, value: id } : { ok: false, error: "Choose one of the options." };
    }
    case "multiselect": {
      const ids = Array.isArray(input) ? (input as string[]) : [];
      const known = new Set(choicesOfInput(f).map((c) => c.id));
      return ids.every((id) => known.has(id)) ? { ok: true, value: ids } : { ok: false, error: "Choose from the options." };
    }
    case "date":
    case "datetime": {
      const stored = fromInputValue(String(input), dateOptionsOfInput(f), ctx.timeZone);
      return stored ? { ok: true, value: stored } : { ok: false, error: "Enter a valid date." };
    }
    case "attachment":
      return { ok: true, value: (input as AttachmentRef[]).map(attachmentJson) };
    default: {
      // Stray spaces around a one-line answer are never meant.
      const text = controlKindOf(f) === "textarea" ? String(input) : String(input).trim();
      const parsed = parseText(asField(f), text, { timeZone: ctx.timeZone });
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, value: parsed.value as FormSubmission["values"][string] };
    }
  }
}

/** What an input holds in its stored form (what a show-if reads), or null when it is empty or not valid yet. */
export function answerOf(f: PublicFormField, input: FormInput, ctx: SubmissionCtx): unknown {
  const res = convert(f, input, ctx);
  return res.ok ? res.value : null;
}

/**
 * The ids of the entries a visitor is shown: those whose show-if holds for the answers above them. A condition on a
 * question the form does not collect counts as unanswered (as on the server).
 */
export function shownFields(fields: readonly PublicFormField[], inputs: FormInputs, ctx: SubmissionCtx): Set<string> {
  const byId = new Map(fields.filter((f) => !f.block).map((f) => [f.id, f] as const));
  return shownEntries(
    fields.map((f) => ({ id: f.id, showIf: f.show_if, answer: f.block ? undefined : () => answerOf(f, inputs[f.id], ctx) })),
    (id) => byId.get(id),
    "unanswered",
  );
}

/**
 * Check every field and build the submission. Empty optional fields are left out; headings and paragraphs
 * and the questions a show-if hides are neither checked nor sent.
 */
export function buildSubmission(fields: readonly PublicFormField[], inputs: FormInputs, ctx: SubmissionCtx): Submission {
  const values: FormSubmission["values"] = {};
  const errors: Record<string, string> = {};
  const shown = shownFields(fields, inputs, ctx);
  for (const f of fields) {
    if (f.block || !shown.has(f.id)) continue;
    const input = inputs[f.id];
    const res = convert(f, input, ctx);
    if (!res.ok) {
      errors[f.id] = res.error;
      continue;
    }
    if (res.value === null || (Array.isArray(res.value) && res.value.length === 0)) {
      if (f.required) errors[f.id] = controlKindOf(f) === "checkbox" ? "This box must be checked." : "This field is required.";
      continue;
    }
    values[f.id] = res.value;
  }
  return { values, errors };
}

/** Whether anything at all was entered (the server refuses an empty form). */
export function hasAnyValue(values: FormSubmission["values"]): boolean {
  return Object.keys(values).length > 0;
}
