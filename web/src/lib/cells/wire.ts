/**
 * "View values" (what the API returns in `TableRecord.values`) versus "wire values" (what the
 * API accepts when writing). They differ only for links: responses carry `[{id,name}]`, writes
 * take an array of record ids. The grid keeps view values in its cache so cells can show names
 * immediately, and converts at the API boundary.
 */
import type { Field, LinkRef } from "@/api/types";
import { isComputed, linkRefs, stringItems } from "./kinds";

/** Empty values are never stored: null, "", false and [] all mean "clear". */
export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0);
}

/** Value to send to the API for a cell value held in view form. `null` clears the cell. */
export function toWire(field: Field, view: unknown): unknown {
  if (isEmptyValue(view)) return null;
  if (field.type === "link") return linkRefs(view).map((r) => r.id);
  if (field.type === "user") return stringItems(view);
  return view;
}

/** View-form value for a wire value, using known names for links. */
export function toView(field: Field, wire: unknown, names?: ReadonlyMap<string, string>): unknown {
  if (isEmptyValue(wire)) return null;
  if (field.type === "link") {
    const refs: LinkRef[] = stringItems(wire).map((id) => ({ id, name: names?.get(id) ?? "" }));
    return refs;
  }
  return wire;
}

/** Whether a field's value can be copied into a new record (computed fields cannot). */
export function isWritable(field: Field): boolean {
  return !isComputed(field);
}

/** The writable values of a record in wire form (used by Duplicate record). */
export function writableValues(fields: readonly Field[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!isWritable(f)) continue;
    const v = values[f.id];
    if (!isEmptyValue(v)) out[f.id] = toWire(f, v);
  }
  return out;
}
