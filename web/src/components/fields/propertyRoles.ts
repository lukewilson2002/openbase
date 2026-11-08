/**
 * The two jobs a property can be given in its collection: the title (FLD-3, the primary property) and the
 * page (FLD-4, the rich text property that holds each record's body). Pure rules shared by the menus that
 * offer them and by Collection settings; the server enforces the same ones.
 */
import type { Field, Table } from "@/api/types";
import { FIELD_TYPE_LABELS } from "@/components/ui/field-type-icon";
import { canBePrimary } from "@/lib/cells/kinds";

/** Why a property cannot be the title, or null when it can. */
export function whyNotTitle(field: Pick<Field, "type">): string | null {
  return canBePrimary(field.type) ? null : `${FIELD_TYPE_LABELS[field.type]} properties can't be the title`;
}

/** Why a property cannot be the page, or null when it can. */
export function whyNotPage(field: Pick<Field, "id" | "type">, table: Pick<Table, "primary_field_id">): string | null {
  if (field.type !== "rich_text") return "Only rich text properties can be the page";
  // The server clears the page when its property becomes the title, so the two never name the same one.
  if (field.id === table.primary_field_id) return "The title can't also be the page";
  return null;
}
