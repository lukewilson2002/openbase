/**
 * Pure helpers for the field dialog: default options per type (the `options: {}` defaults of
 * og_core::field::FieldKind::default_for plus sensible references for the types that need them),
 * validation, the CreateField / UpdateField payloads, and a warning model for type changes.
 */
import type { CreateField, Field, FieldKind, FieldType, Table, UpdateField } from "@/api/types";
import { canBePrimary, isComputedType } from "@/lib/cells/kinds";
import { jsonEqual } from "@/lib/cells/parse";

export const FIELD_TYPES: readonly FieldType[] = [
  "single_line_text",
  "long_text",
  "number",
  "currency",
  "percent",
  "duration",
  "rating",
  "checkbox",
  "single_select",
  "multiple_select",
  "date",
  "email",
  "url",
  "phone",
  "attachment",
  "link",
  "user",
  "formula",
  "lookup",
  "rollup",
  "count",
  "created_time",
  "last_modified_time",
  "created_by",
  "last_modified_by",
  "autonumber",
  "barcode",
  "button",
];

export const FIELD_TYPE_GROUPS: readonly { label: string; types: readonly FieldType[] }[] = [
  { label: "Text", types: ["single_line_text", "long_text", "email", "url", "phone", "barcode"] },
  { label: "Numbers", types: ["number", "currency", "percent", "duration", "rating", "autonumber"] },
  { label: "Choices", types: ["single_select", "multiple_select", "checkbox"] },
  { label: "Dates and people", types: ["date", "user", "created_time", "last_modified_time", "created_by", "last_modified_by"] },
  { label: "Files and links", types: ["attachment", "link", "button"] },
  { label: "Computed", types: ["formula", "lookup", "rollup", "count"] },
];

/** What the type picker needs to know about the surroundings to build valid default options. */
export interface KindContext {
  /** The table being edited. */
  table: Table;
  /** Every table of the base (link targets). */
  tables: readonly Table[];
}

export function linkFields(table: Table): Extract<Field, { type: "link" }>[] {
  return table.fields.filter((f): f is Extract<Field, { type: "link" }> => f.type === "link");
}

/** The first table a new link field points at: another table when there is one, else this one. */
function defaultLinkTarget(ctx: KindContext): string {
  return ctx.tables.find((t) => t.id !== ctx.table.id)?.id ?? ctx.table.id;
}

/** Default `{type, options}` for a freshly chosen type (options `{}` where the server fills defaults). */
export function defaultKind(type: FieldType, ctx: KindContext): FieldKind {
  switch (type) {
    case "single_line_text":
      return { type, options: {} };
    case "long_text":
      return { type, options: { rich: false } };
    case "number":
    case "percent":
      return { type, options: { precision: 0, allow_negative: true } };
    case "currency":
      return { type, options: { precision: 2, symbol: "$", allow_negative: true } };
    case "duration":
      return { type, options: { format: "h_mm" } };
    case "rating":
      return { type, options: { max: 5, icon: "star", color: "yellow" } };
    case "checkbox":
      return { type, options: { icon: "check", color: "green" } };
    case "single_select":
    case "multiple_select":
      return { type, options: { choices: [] } };
    case "date":
    case "created_time":
      return { type, options: { include_time: false, date_format: "us", time_format: "h12", timezone: null } };
    case "last_modified_time":
      return { type, options: { fields: [], date: { include_time: true, date_format: "us", time_format: "h12", timezone: null } } };
    case "email":
    case "url":
    case "phone":
    case "attachment":
    case "created_by":
    case "autonumber":
    case "barcode":
      return { type, options: {} };
    case "last_modified_by":
      return { type, options: { fields: [], date: { include_time: false, date_format: "us", time_format: "h12", timezone: null } } };
    case "link":
      return { type, options: { linked_table_id: defaultLinkTarget(ctx), inverse_field_id: "", single: false } };
    case "user":
      return { type, options: { multiple: false, notify: false } };
    case "formula":
      return { type, options: { expression: "", result_type: "text" } };
    case "lookup": {
      const link = linkFields(ctx.table)[0];
      return { type, options: { link_field_id: link?.id ?? "", target_field_id: "", result_type: "text" } };
    }
    case "rollup": {
      const link = linkFields(ctx.table)[0];
      return { type, options: { link_field_id: link?.id ?? "", target_field_id: "", expression: "SUM(values)", result_type: "number" } };
    }
    case "count": {
      const link = linkFields(ctx.table)[0];
      return { type, options: { link_field_id: link?.id ?? "" } };
    }
    case "button":
      return { type, options: { label: "Open", url_formula: "" } };
  }
}

export interface FieldDraft {
  name: string;
  description: string;
  kind: FieldKind;
  /** Link fields only: name of the inverse field created in the linked table. */
  inverseName: string;
}

export function draftFromField(field: Field): FieldDraft {
  const { type, options } = field as { type: FieldType; options: unknown };
  return { name: field.name, description: field.description ?? "", kind: { type, options } as FieldKind, inverseName: "" };
}

export interface DraftIssue {
  field: "name" | "options";
  message: string;
}

/** Client-side checks that mirror what the server rejects, so errors show before the request. */
export function validateDraft(draft: FieldDraft, ctx: KindContext, existing?: Field): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const name = draft.name.trim();
  if (!name) issues.push({ field: "name", message: "Give the field a name." });
  else if (name.length > 255) issues.push({ field: "name", message: "Field names can have at most 255 characters." });
  else if (ctx.table.fields.some((f) => f.id !== existing?.id && f.name.trim().toLowerCase() === name.toLowerCase())) issues.push({ field: "name", message: "Another field in this table already has that name." });
  const k = draft.kind;
  switch (k.type) {
    case "single_select":
    case "multiple_select": {
      const names = k.options.choices.map((c) => c.name.trim().toLowerCase());
      if (names.some((n) => !n)) issues.push({ field: "options", message: "Every option needs a name." });
      else if (new Set(names).size !== names.length) issues.push({ field: "options", message: "Option names must be unique." });
      break;
    }
    case "link":
      if (!k.options.linked_table_id) issues.push({ field: "options", message: "Choose the table to link to." });
      break;
    case "formula":
      if (!k.options.expression.trim()) issues.push({ field: "options", message: "Enter a formula." });
      break;
    case "lookup":
      if (!k.options.link_field_id) issues.push({ field: "options", message: "Choose a link field." });
      else if (!k.options.target_field_id) issues.push({ field: "options", message: "Choose the field to look up." });
      break;
    case "rollup":
      if (!k.options.link_field_id) issues.push({ field: "options", message: "Choose a link field." });
      else if (!k.options.target_field_id) issues.push({ field: "options", message: "Choose the field to roll up." });
      else if (!k.options.expression.trim()) issues.push({ field: "options", message: "Enter a rollup formula." });
      break;
    case "count":
      if (!k.options.link_field_id) issues.push({ field: "options", message: "Choose a link field." });
      break;
    case "button":
      if (!k.options.label.trim()) issues.push({ field: "options", message: "Give the button a label." });
      if (!k.options.url_formula.trim()) issues.push({ field: "options", message: "Enter a formula that produces the URL." });
      break;
    case "rating":
      if (k.options.max < 1 || k.options.max > 10) issues.push({ field: "options", message: "A rating has 1 to 10 steps." });
      break;
    case "number":
    case "percent":
    case "currency":
      if (k.options.precision < 0 || k.options.precision > 8) issues.push({ field: "options", message: "Precision is 0 to 8 decimal places." });
      break;
    default:
      break;
  }
  return issues;
}

/** The `POST /api/tables/{id}/fields` body. `options` is always present (the server requires it). */
export function toCreateField(draft: FieldDraft): CreateField {
  const base = { name: draft.name.trim(), description: draft.description.trim() || null } as const;
  const kind = cleanKind(draft.kind);
  if (kind.type === "link") return { ...base, ...kind, inverse_name: draft.inverseName.trim() || null };
  return { ...base, ...kind };
}

/** Drop transient or ignored parts (e.g. empty strings the server would reject). */
export function cleanKind(kind: FieldKind): FieldKind {
  switch (kind.type) {
    case "single_select":
    case "multiple_select":
      return { ...kind, options: { choices: kind.options.choices.map((c) => ({ ...c, name: c.name.trim() })) } };
    case "single_line_text":
      return { type: kind.type, options: kind.options.default ? { default: kind.options.default } : {} };
    case "date":
    case "created_time":
      return { ...kind, options: { ...kind.options, timezone: kind.options.timezone || null } };
    default:
      return kind;
  }
}

/** The `PATCH /api/fields/{id}` body for the changes made to `existing`; null when nothing changed. */
export function toUpdateField(existing: Field, draft: FieldDraft): UpdateField | null {
  const out: UpdateField = {};
  if (draft.name.trim() !== existing.name) out.name = draft.name.trim();
  const description = draft.description.trim();
  if (description !== (existing.description ?? "")) out.description = description;
  const before = { type: existing.type, options: (existing as { options: unknown }).options };
  const after = cleanKind(draft.kind);
  if (!jsonEqual(before, { type: after.type, options: after.options })) {
    return { ...out, ...after } as UpdateField;
  }
  return Object.keys(out).length === 0 ? null : (out as UpdateField);
}

export type ConversionRisk = "none" | "safe" | "lossy";

const TEXTY: ReadonlySet<FieldType> = new Set(["single_line_text", "long_text", "email", "url", "phone", "barcode"]);
const NUMBERY: ReadonlySet<FieldType> = new Set(["number", "currency", "percent", "duration", "rating"]);
const SELECTY: ReadonlySet<FieldType> = new Set(["single_select", "multiple_select"]);

/**
 * How risky converting existing values from one type to another is: `none` (same type),
 * `safe` (every value survives, possibly reformatted), `lossy` (some values may be dropped or
 * reinterpreted, or computed types discard stored data).
 */
export function conversionRisk(from: FieldType, to: FieldType): ConversionRisk {
  if (from === to) return "none";
  if (isComputedType(to)) return "lossy";
  if (isComputedType(from)) return "safe"; // computed values are not stored; nothing to lose
  if (TEXTY.has(to) && (TEXTY.has(from) || NUMBERY.has(from) || SELECTY.has(from) || from === "date" || from === "checkbox")) return from === "long_text" && to !== "long_text" ? "lossy" : "safe";
  if (SELECTY.has(from) && SELECTY.has(to)) return from === "multiple_select" && to === "single_select" ? "lossy" : "safe";
  if (NUMBERY.has(from) && NUMBERY.has(to)) return "lossy";
  if (from === "single_select" && to === "multiple_select") return "safe";
  return "lossy";
}

/** Explanation shown before saving a risky type change. */
export function conversionWarning(from: FieldType, to: FieldType): string | null {
  switch (conversionRisk(from, to)) {
    case "none":
      return null;
    case "safe":
      return "Existing values are converted to the new type.";
    case "lossy":
      return isComputedType(to)
        ? "Computed fields are calculated, not typed in: the values stored in this field will be discarded."
        : "Values that do not fit the new type are cleared, and some may change meaning. This cannot be undone automatically.";
  }
}

export { canBePrimary };
