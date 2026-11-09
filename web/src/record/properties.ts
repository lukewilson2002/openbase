/**
 * What the record page shows of a record, decided without any React: which property is the title and how it is
 * edited, which properties are listed, which fold away because they are empty or hidden from pages (REC-2, REC-3),
 * and the tile's initials and image.
 */
import type { AttachmentRef, Field, Table, ViewConfig } from "@/api/types";
import { resolveFieldOrder } from "@/components/viewbar/config";
import { attachmentRefs, isComputed, isMultilineText } from "@/lib/cells/kinds";

/**
 * How the title is edited in place:
 * - `inline`: as one line of text, parsed like the grid's cells are (text, numbers, email, web address, phone).
 * - `readonly`: a computed value (formula, autonumber, created time ...) is shown and cannot be typed over.
 * - `row`: the type needs an editor of its own (a choice, a date, a person, long text), so the title is a plain
 *   heading and the property keeps its row in the list, where that editor is.
 */
export type TitleMode = "inline" | "readonly" | "row";

const INLINE_TYPES: ReadonlySet<Field["type"]> = new Set(["text", "number", "currency", "percent", "duration", "email", "url", "phone", "barcode"]);

export function titleModeOf(field: Field | undefined): TitleMode {
  if (!field) return "readonly";
  if (isComputed(field)) return "readonly";
  return INLINE_TYPES.has(field.type) && !isMultilineText(field) ? "inline" : "row";
}

/** Whether a property has anything to show (a checked box or a rating above 0 are values; text of "" is not). */
export function hasValue(field: Pick<Field, "type">, value: unknown): boolean {
  if (value === null || value === undefined || value === "" || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (field.type === "rating" && value === 0) return false;
  return true;
}

export interface PropertyGroups {
  /** Listed: they have a value (or had one when the page opened). */
  shown: Field[];
  /** Folded under "Show N empty properties". */
  empty: Field[];
  /** Folded under "Show N hidden properties": hidden from pages in the default view. */
  hidden: Field[];
}

export interface SplitInput {
  table: Pick<Table, "fields" | "primary_field_id" | "body_field_id">;
  /** The collection's default view: its order and hidden properties are every record's layout. */
  layout: Pick<ViewConfig, "field_order" | "hidden_fields"> | undefined;
  values: Readonly<Record<string, unknown>>;
  title: TitleMode;
  /** Properties that stay listed although they are empty now: they had a value a moment ago, so clearing one does not pull the row away. */
  pinned?: ReadonlySet<string>;
}

/** The properties of a record in the order and visibility of the default view, less the title and the Page. */
export function splitProperties({ table, layout, values, title, pinned }: SplitInput): PropertyGroups {
  const { visible, hidden } = resolveFieldOrder(table, layout ?? { field_order: [], hidden_fields: [] });
  const left = (f: Field) => !(f.id === table.body_field_id || (f.id === table.primary_field_id && title !== "row"));
  const shown: Field[] = [];
  const empty: Field[] = [];
  // A title that is a row is never folded away, even when it is empty.
  for (const f of visible.filter(left)) (hasValue(f, values[f.id]) || pinned?.has(f.id) || f.id === table.primary_field_id ? shown : empty).push(f);
  return { shown, empty, hidden: hidden.filter(left) };
}

/** "Show 2 empty properties", "Show 1 hidden property". */
export function foldLabel(kind: "empty" | "hidden", count: number, open: boolean): string {
  return `${open ? "Hide" : "Show"} ${count} ${kind} ${count === 1 ? "property" : "properties"}`;
}

/** The first letters of the first two words of the title, capitalised: "Q3 launch plan" is "QL". */
export function recordInitials(title: string): string {
  const letters = title
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "");
  return letters.join("").toLocaleUpperCase();
}

/**
 * The picture that fills the tile: the first attachment property, in the default view's order, whose first file
 * on this record is an image (a PDF or a video there is not the record's picture, so the next property is looked at).
 */
export function tileImage(table: Pick<Table, "fields" | "primary_field_id">, values: Readonly<Record<string, unknown>>, layout?: Pick<ViewConfig, "field_order" | "hidden_fields">): AttachmentRef | null {
  const { visible, hidden } = resolveFieldOrder(table, layout ?? { field_order: [], hidden_fields: [] });
  for (const property of [...visible, ...hidden]) {
    if (property.type !== "attachment") continue;
    const first = attachmentRefs(values[property.id])[0];
    if (first?.mime.startsWith("image/")) return first;
  }
  return null;
}
