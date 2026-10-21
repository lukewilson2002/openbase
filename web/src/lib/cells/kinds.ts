/** Classification of fields for rendering, editing, filtering and aggregation. */
import type { AttachmentRef, DateOptions, Field, FieldType, LinkRef, ResultType, SelectChoice, ValueFormat } from "@/api/types";

/** The JSON value of a cell as it appears in `TableRecord.values`. */
export type CellJson = unknown;

/** Field types the server computes; clients never write them. */
const COMPUTED: ReadonlySet<FieldType> = new Set<FieldType>([
  "formula",
  "lookup",
  "rollup",
  "count",
  "created_time",
  "last_modified_time",
  "created_by",
  "last_modified_by",
  "autonumber",
  "button",
]);

/** Mirrors `FieldType::is_computed`. */
export function isComputedType(t: FieldType): boolean {
  return COMPUTED.has(t);
}

export function isComputed(field: Pick<Field, "type">): boolean {
  return isComputedType(field.type);
}

/** Mirrors `FieldType::can_be_primary`. */
export function canBePrimary(t: FieldType): boolean {
  return !["link", "attachment", "checkbox", "lookup", "rollup", "count", "button", "multiple_select", "rating"].includes(t);
}

export function resultTypeOf(field: Field): ResultType | null {
  switch (field.type) {
    case "formula":
    case "rollup":
    case "lookup":
      return field.options.result_type ?? "text";
    default:
      return null;
  }
}

/** Element type of an array result, or the type itself. */
export function unwrapResult(rt: ResultType): { array: boolean; item: Exclude<ResultType, { array: ResultType }> } {
  let array = false;
  let cur: ResultType = rt;
  while (typeof cur === "object") {
    array = true;
    cur = cur.array;
  }
  return { array, item: cur };
}

/** How a field behaves for filtering, sorting and aggregation (mirrors `query::Kind`). */
export type FieldKindClass = "text" | "number" | "bool" | "select" | "multi_select" | "date" | "attachment" | "link" | "user" | "user_multi" | "list" | "inert";

export function kindClassOf(field: Field): FieldKindClass {
  switch (field.type) {
    case "text":
    case "rich_text":
    case "email":
    case "url":
    case "phone":
    case "barcode":
      return "text";
    case "number":
    case "currency":
    case "percent":
    case "duration":
    case "rating":
    case "autonumber":
    case "count":
      return "number";
    case "checkbox":
      return "bool";
    case "single_select":
      return "select";
    case "multiple_select":
      return "multi_select";
    case "date":
    case "created_time":
    case "last_modified_time":
      return "date";
    case "attachment":
      return "attachment";
    case "link":
      return "link";
    case "user":
      return field.options.multiple ? "user_multi" : "user";
    case "created_by":
    case "last_modified_by":
      return "user";
    case "formula":
    case "rollup":
    case "lookup": {
      const rt = resultTypeOf(field) ?? "text";
      if (typeof rt === "object") return "list";
      switch (rt) {
        case "text":
          return "text";
        case "number":
          return "number";
        case "bool":
          return "bool";
        case "date":
        case "date_time":
          return "date";
      }
      return "text";
    }
    case "button":
      return "inert";
  }
}

/** Text that keeps line breaks: rich text, or text with Multiline on. */
export function isMultilineText(field: Field): boolean {
  return field.type === "rich_text" || (field.type === "text" && field.options.multiline);
}

/** Shape used to draw and edit a cell. */
export type DisplayShape =
  | "text"
  | "multiline"
  | "number"
  | "rating"
  | "checkbox"
  | "select"
  | "multi_select"
  | "date"
  | "link"
  | "user"
  | "attachment"
  | "button"
  | "url"
  | "email"
  | "phone"
  | "list";

export function displayShapeOf(field: Field): DisplayShape {
  switch (field.type) {
    case "text":
      return field.options.multiline ? "multiline" : "text";
    case "barcode":
      return "text";
    case "rich_text":
      return "multiline";
    case "number":
    case "currency":
    case "percent":
    case "duration":
    case "autonumber":
    case "count":
      return "number";
    case "rating":
      return "rating";
    case "checkbox":
      return "checkbox";
    case "single_select":
      return "select";
    case "multiple_select":
      return "multi_select";
    case "date":
    case "created_time":
    case "last_modified_time":
      return "date";
    case "email":
      return "email";
    case "url":
      return "url";
    case "phone":
      return "phone";
    case "attachment":
      return "attachment";
    case "link":
      return "link";
    case "user":
    case "created_by":
    case "last_modified_by":
      return "user";
    case "button":
      return "button";
    case "formula":
    case "rollup":
    case "lookup": {
      const rt = resultTypeOf(field) ?? "text";
      if (typeof rt === "object") return "list";
      if (rt === "number") return "number";
      if (rt === "bool") return "checkbox";
      if (rt === "date" || rt === "date_time") return "date";
      return "text";
    }
  }
}

export function numberFieldOptionsOf(field: Field): { precision: number; allowNegative: boolean } | null {
  switch (field.type) {
    case "number":
    case "percent":
      return { precision: field.options.precision, allowNegative: field.options.allow_negative };
    case "currency":
      return { precision: field.options.precision, allowNegative: field.options.allow_negative };
    default:
      return null;
  }
}

/** Date display options of a field, when it shows dates. */
export function dateOptionsOf(field: Field): DateOptions | null {
  switch (field.type) {
    case "date":
    case "created_time":
      return field.options;
    case "last_modified_time":
      return field.options.date;
    case "formula":
    case "rollup":
      return field.options.format?.kind === "date" ? field.options.format : fallbackDateOptions(field.options.result_type);
    case "lookup":
      return fallbackDateOptions(field.options.result_type);
    default:
      return null;
  }
}

function fallbackDateOptions(rt: ResultType | undefined): DateOptions | null {
  if (!rt) return null;
  const { item } = unwrapResult(rt);
  if (item === "date" || item === "date_time") {
    return { include_time: item === "date_time", date_format: "us", time_format: "h12", timezone: null };
  }
  return null;
}

export function valueFormatOf(field: Field): ValueFormat | null {
  switch (field.type) {
    case "formula":
    case "rollup":
      return field.options.format ?? null;
    default:
      return null;
  }
}

export function selectChoicesOf(field: Field): SelectChoice[] {
  return field.type === "single_select" || field.type === "multiple_select" ? field.options.choices : [];
}

export function isLinkRef(v: unknown): v is LinkRef {
  return !!v && typeof v === "object" && typeof (v as LinkRef).id === "string" && "name" in (v as object);
}

export function isAttachmentRef(v: unknown): v is AttachmentRef {
  return !!v && typeof v === "object" && typeof (v as AttachmentRef).id === "string" && typeof (v as AttachmentRef).filename === "string";
}

/** Items of a stored array (or a lone string), dropping empties. */
export function stringItems(v: CellJson): string[] {
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const x of v) {
      if (typeof x === "string" && x) out.push(x);
      else if (x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string") out.push((x as { id: string }).id);
    }
    return out;
  }
  return typeof v === "string" && v ? [v] : [];
}

/** Linked records from a response value (`[{id,name}]`, tolerating bare id strings). */
export function linkRefs(v: CellJson): LinkRef[] {
  if (!Array.isArray(v)) return [];
  const out: LinkRef[] = [];
  for (const x of v) {
    if (isLinkRef(x)) out.push({ id: x.id, name: String(x.name ?? "") });
    else if (typeof x === "string" && x) out.push({ id: x, name: x });
  }
  return out;
}

export function attachmentRefs(v: CellJson): AttachmentRef[] {
  return Array.isArray(v) ? v.filter(isAttachmentRef) : [];
}
