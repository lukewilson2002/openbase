/**
 * Which fields a card (kanban, gallery, list row) shows and how to find its cover (an image, or the
 * preview of a PDF or a video).
 * Hiding a field in the toolbar removes it from every card; the primary field is the card title.
 */
import { attachmentsApi } from "@/api/records";
import type { AttachmentRef, Field, TableRecord, ViewConfig } from "@/api/types";
import { markdownToText } from "@/components/record/Markdown";
import { resolveFieldOrder } from "@/components/viewbar/config";
import { displayText, isFormulaError, type FormatCtx } from "@/lib/cells/format";
import { attachmentRefs, displayShapeOf, resultTypeOf, unwrapResult } from "@/lib/cells/kinds";
import { coverFile } from "@/lib/filePreview";

/** Text of a count line: "1 item", "8 items". */
export function itemsLabel(n: number): string {
  return `${n.toLocaleString()} item${n === 1 ? "" : "s"}`;
}

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

/** The file shown as the card's cover (see `coverFile`), if any. */
export function coverOf(coverField: Field | undefined, record: TableRecord): AttachmentRef | null {
  if (!coverField || coverField.type !== "attachment") return null;
  return coverFile(attachmentRefs(record.values[coverField.id])) ?? null;
}

/** Preview URL of the card's cover file, if any. */
export function coverUrl(coverField: Field | undefined, record: TableRecord): string | null {
  const file = coverOf(coverField, record);
  return file ? attachmentsApi.thumbUrl(file.id) : null;
}

/** Title of a card: the primary field's text. */
export function cardTitle(primary: Field | undefined, record: TableRecord, format: FormatCtx): string {
  if (!primary) return "Untitled";
  return displayText(primary, record.values[primary.id], format).trim() || "Untitled";
}

/** Fields that can be a card's description: text, rich text, and formulas, rollups or lookups giving text. */
export function isDescriptionField(field: Field): boolean {
  if (field.type === "text" || field.type === "rich_text") return true;
  const rt = resultTypeOf(field);
  return rt !== null && unwrapResult(rt).item === "text";
}

/**
 * A card's description as one run of plain text (the card clamps it): rich text loses its
 * markdown, and line breaks and runs of spaces collapse so three lines hold as many words as they can.
 */
export function descriptionText(field: Field | undefined, value: TableRecord["values"][string] | undefined, format: FormatCtx): string {
  if (!field) return "";
  if (value === null || value === undefined || isFormulaError(value)) return "";
  const text = field.type === "rich_text" && typeof value === "string" ? markdownToText(value) : displayText(field, value, format);
  return text.replace(/\s+/g, " ").trim();
}
