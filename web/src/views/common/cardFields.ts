/**
 * Which fields a card (kanban, gallery, list row) shows and how to find its cover image.
 * Hiding a field in the toolbar removes it from every card; the primary field is the card title.
 */
import { attachmentsApi } from "@/api/records";
import type { Field, TableRecord, ViewConfig } from "@/api/types";
import { resolveFieldOrder } from "@/components/viewbar/config";
import { displayText, isFormulaError, type FormatCtx } from "@/lib/cells/format";
import { attachmentRefs, displayShapeOf } from "@/lib/cells/kinds";

/** Most fields one card shows (non-empty ones, in the view's field order). */
export const CARD_FIELD_LIMIT = 6;

/** Fields shown on cards: visible, not the title, not excluded (cover, stack...). */
export function cardFields(table: { fields: Field[]; primary_field_id: string }, config: Pick<ViewConfig, "field_order" | "hidden_fields">, exclude: ReadonlySet<string> = new Set()): Field[] {
  const { visible } = resolveFieldOrder(table, config);
  return visible.filter((f) => f.id !== table.primary_field_id && !exclude.has(f.id) && displayShapeOf(f) !== "button");
}

/** Whether a cell has something worth drawing on a card (empty values are skipped). */
export function hasCardValue(field: Field, value: unknown, format: FormatCtx): boolean {
  if (value === null || value === undefined) return false;
  const shape = displayShapeOf(field);
  if (shape === "checkbox") return value === true;
  if (shape === "attachment") return attachmentRefs(value).length > 0;
  if (shape === "rating") return typeof value === "number" && value > 0;
  if (isFormulaError(value)) return true;
  return displayText(field, value, format) !== "";
}

/** The non-empty card fields of one record, capped at `limit`. */
export function fieldsToShow(fields: readonly Field[], record: TableRecord, format: FormatCtx, limit = CARD_FIELD_LIMIT): Field[] {
  const out: Field[] = [];
  for (const f of fields) {
    if (out.length >= limit) break;
    if (hasCardValue(f, record.values[f.id], format)) out.push(f);
  }
  return out;
}

/** Thumbnail URL of the first image in the cover attachment field, if any. */
export function coverUrl(coverField: Field | undefined, record: TableRecord): string | null {
  if (!coverField || coverField.type !== "attachment") return null;
  const img = attachmentRefs(record.values[coverField.id]).find((a) => a.mime.startsWith("image/"));
  return img ? attachmentsApi.thumbUrl(img.id) : null;
}

/** Title of a card: the primary field's text. */
export function cardTitle(primary: Field | undefined, record: TableRecord, format: FormatCtx): string {
  if (!primary) return "Untitled";
  return displayText(primary, record.values[primary.id], format).trim() || "Untitled";
}
