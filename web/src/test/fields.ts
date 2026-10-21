/** Field fixtures for tests: one realistic field per type plus builders for tables and records. */
import type { Field, FieldType, Table, TableRecord } from "@/api/types";
import { makeView } from "./utils";

const DATE_US = { include_time: false, date_format: "us", time_format: "h12", timezone: null } as const;

type Opts<T extends FieldType> = Extract<Field, { type: T }>["options"];

export function field<T extends FieldType>(type: T, options: Opts<T>, over: { id?: string; name?: string } = {}): Field {
  return { id: over.id ?? `fld_${type}`, table_id: "tbl1", name: over.name ?? type, type, options } as unknown as Field;
}

export const CHOICES = [
  { id: "chs1", name: "Todo", color: "gray" },
  { id: "chs2", name: "In progress", color: "blue" },
  { id: "chs3", name: "Done", color: "green" },
];

/** One field of every one of the 28 types, keyed by type. */
export const ALL_FIELDS: Record<FieldType, Field> = {
  text: field("text", { multiline: false }),
  rich_text: field("rich_text", {}),
  number: field("number", { precision: 2, allow_negative: true }),
  currency: field("currency", { precision: 2, symbol: "$", allow_negative: true }),
  percent: field("percent", { precision: 1, allow_negative: true }),
  duration: field("duration", { format: "h_mm_ss" }),
  rating: field("rating", { max: 5, icon: "star", color: "yellow" }),
  checkbox: field("checkbox", { icon: "check", color: "green" }),
  single_select: field("single_select", { choices: CHOICES }),
  multiple_select: field("multiple_select", { choices: CHOICES }),
  date: field("date", { ...DATE_US }),
  email: field("email", {}),
  url: field("url", {}),
  phone: field("phone", {}),
  attachment: field("attachment", {}),
  link: field("link", { linked_table_id: "tbl2", inverse_field_id: "fld_inv", single: false }),
  user: field("user", { multiple: true, notify: false }),
  formula: field("formula", { expression: "{a}*2", result_type: "number", format: { kind: "number", precision: 1 } }),
  lookup: field("lookup", { link_field_id: "fld_link", target_field_id: "fld_t", result_type: { array: "text" } }),
  rollup: field("rollup", { link_field_id: "fld_link", target_field_id: "fld_t", expression: "SUM(values)", result_type: "number", format: { kind: "currency", precision: 0, symbol: "€" } }),
  count: field("count", { link_field_id: "fld_link" }),
  created_time: field("created_time", { include_time: true, date_format: "iso", time_format: "h24", timezone: null }),
  last_modified_time: field("last_modified_time", { fields: [], date: { include_time: true, date_format: "us", time_format: "h12", timezone: "Asia/Tokyo" } }),
  created_by: field("created_by", {}),
  last_modified_by: field("last_modified_by", { fields: [], date: { ...DATE_US } }),
  autonumber: field("autonumber", {}),
  barcode: field("barcode", {}),
  button: field("button", { label: "Open", url_formula: "{url}" }),
};

export function makeTable(fields: Field[], over: Partial<Table> = {}): Table {
  return { id: "tbl1", base_id: "app1", name: "Tasks", description: null, primary_field_id: fields[0]?.id ?? "fld1", fields, views: [makeView({ id: "viw1" })], ...over };
}

export function makeRecord(values: Record<string, unknown>, id = "rec1"): TableRecord {
  return { id, table_id: "tbl1", created_at: 1_700_000_000_000, updated_at: 1_700_000_100_000, created_by: "usr1", updated_by: "usr1", autonumber: 1, values: values as TableRecord["values"] };
}

export const PEOPLE = [
  { id: "usr1", name: "Ada Lovelace", email: "ada@example.com" },
  { id: "usr2", name: "Grace Hopper", email: "grace@example.com" },
];
