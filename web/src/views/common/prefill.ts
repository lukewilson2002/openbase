/**
 * What a record added from a view starts with, so it is still there when the view shows it: the
 * values its filter pins down (`Status is Todo` starts it as Todo), and, inside a group, the value
 * of that group. Only simple equality is read: conditions joined by "and" (or a lone condition), with
 * `is` on text, numbers, checkboxes and selects, `is any of` with one choice, and the "has" set
 * operators on multiple selects and people. Everything else (ranges, dates, "is not", an "or"
 * between several conditions) cannot be satisfied with one value and is left out, as is a field
 * two conditions pin to different values.
 */
import type { Condition, Field, Filter, FilterItem } from "@/api/types";
import { isComputed, kindClassOf } from "@/lib/cells/kinds";
import { isEmptyValue } from "@/lib/cells/wire";

const ME = "me";

interface Ctx {
  fields: ReadonlyMap<string, Field>;
  currentUserId: string | null;
}

/** The value (view form) a condition pins its field to, or undefined when it does not pin one. */
function pinned(field: Field, c: Condition, ctx: Ctx): unknown {
  if (isComputed(field)) return undefined;
  const v = c.value as unknown;
  const one = (x: unknown): string | undefined => (typeof x === "string" ? x : Array.isArray(x) && x.length === 1 && typeof x[0] === "string" ? x[0] : undefined);
  const person = (id: string | undefined) => (id === ME ? (ctx.currentUserId ?? undefined) : id);
  switch (kindClassOf(field)) {
    case "text":
      return c.op === "is" && typeof v === "string" && v !== "" ? v : undefined;
    case "number":
      return c.op === "is" && typeof v === "number" && Number.isFinite(v) ? v : undefined;
    case "bool":
      return c.op === "is" && v === true ? true : undefined;
    case "select":
      return c.op === "is" || c.op === "is_any_of" ? one(v) : undefined;
    case "user": {
      if (c.op !== "is" && c.op !== "is_any_of") return undefined;
      const id = person(one(v));
      return id ? [id] : undefined;
    }
    case "multi_select":
    case "user_multi": {
      if (c.op !== "has_any_of" && c.op !== "has_all_of" && c.op !== "is_exactly") return undefined;
      const ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => (field.type === "user" ? person(x) : x)).filter((x): x is string => !!x) : [];
      if (ids.length === 0) return undefined;
      // "Has any of A, B" is met by A alone; the other two need all of them.
      return c.op === "has_any_of" ? ids.slice(0, 1) : ids;
    }
    default:
      return undefined;
  }
}

function collect(filter: Filter, ctx: Ctx, out: Map<string, unknown>, conflicts: Set<string>): void {
  // "Or" over several conditions does not pin anything: the record may match through any other branch.
  const items: FilterItem[] = filter.conjunction === "or" && filter.items.length !== 1 ? [] : filter.items;
  for (const item of items) {
    if ("items" in item) {
      collect(item, ctx, out, conflicts);
      continue;
    }
    const field = ctx.fields.get(item.field_id);
    if (!field) continue;
    const value = pinned(field, item, ctx);
    if (value === undefined) continue;
    if (out.has(field.id) && JSON.stringify(out.get(field.id)) !== JSON.stringify(value)) conflicts.add(field.id);
    out.set(field.id, value);
  }
}

/** Field values (view form, keyed by field id) a record added under `filter` starts with. */
export function filterPrefill(fields: readonly Field[], filter: Filter | null | undefined, currentUserId: string | null = null): Record<string, unknown> {
  if (!filter || filter.items.length === 0) return {};
  const out = new Map<string, unknown>();
  const conflicts = new Set<string>();
  collect(filter, { fields: new Map(fields.map((f) => [f.id, f] as const)), currentUserId }, out, conflicts);
  for (const id of conflicts) out.delete(id);
  return Object.fromEntries(out);
}

/**
 * Values to start a record with in a view: those of its filter, then those of the group it is
 * added to (`group`: field id to raw value, as `GroupHeader.value`; blank groups add nothing).
 */
export function prefillFor(fields: readonly Field[], filter: Filter | null | undefined, group: Record<string, unknown> = {}, currentUserId: string | null = null): Record<string, unknown> {
  const out = filterPrefill(fields, filter, currentUserId);
  for (const [id, v] of Object.entries(group)) if (!isEmptyValue(v)) out[id] = v;
  return out;
}
