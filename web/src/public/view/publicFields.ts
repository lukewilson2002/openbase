/**
 * Adapters between what a public share sends and the rendering helpers the signed-in views use.
 *
 * A shared view sends `PublicField`s (the field's type and display options, with formulas and link
 * wiring removed) and `PublicRecord`s (values of the visible fields only; people by name, never by
 * id). The shared helpers (`displayText`, `CellValue`, `buildStacks`, ...) read `Field` and
 * `TableRecord`, so fields are re-wrapped and the two shapes that differ are normalised:
 *
 *   - user cells arrive as `[{"name"}]`, created-by / modified-by as `{"name"}`; they become the
 *     names themselves, which the shared chip code shows when no id resolves to a name;
 *   - everything else is already the stored value.
 */
import type { Field, PublicField, PublicRecord, PublicView, TableRecord } from "@/api/types";

/** A `Field` the display helpers can read. Only the parts a public field carries are filled in. */
export function toField(pf: PublicField, tableId = ""): Field {
  return { id: pf.id, table_id: tableId, name: pf.name, description: pf.description ?? null, type: pf.type, options: pf.options } as unknown as Field;
}

function nameOf(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string") return (v as { name: string }).name || null;
  return null;
}

/** The value in the form the shared display helpers expect. */
export function normalizeValue(field: Pick<Field, "type">, value: unknown): unknown {
  switch (field.type) {
    case "user": {
      const names = (Array.isArray(value) ? value : [value]).map(nameOf).filter((n): n is string => n !== null);
      return names.length > 0 ? names : null;
    }
    case "created_by":
    case "last_modified_by":
      return nameOf(value);
    default:
      return value ?? null;
  }
}

export interface SharedFields {
  /** In the view's display order. */
  list: Field[];
  byId: ReadonlyMap<string, Field>;
  /** The field that titles a card or row label: the first visible field (the primary field comes first unless the view reorders it). */
  title: Field | undefined;
}

export function sharedFields(view: Pick<PublicView, "fields">): SharedFields {
  const list = view.fields.map((f) => toField(f));
  return { list, byId: new Map(list.map((f) => [f.id, f] as const)), title: list[0] };
}

/** A public record as a `TableRecord` with normalised values, so the card helpers can read it. */
export function toRecord(r: PublicRecord, fields: SharedFields): TableRecord {
  const values: Record<string, unknown> = {};
  for (const [id, v] of Object.entries(r.values)) {
    const f = fields.byId.get(id);
    values[id] = f ? normalizeValue(f, v) : v;
  }
  return { id: r.id, table_id: "", created_at: 0, updated_at: 0, created_by: null, updated_by: null, autonumber: 0, values: values as TableRecord["values"] };
}
