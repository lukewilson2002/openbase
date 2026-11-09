/**
 * A record card's properties (COL-7): the values that have something in them, on one line under the
 * title. A choice is a status chip, a date or a text is quiet text, and a number sits at the right end
 * in tabular figures so a column of cards lines up. The same line closes a List row and a Board card,
 * which is what makes the two look alike. A property's name is its tooltip: the line has room for
 * values, not labels.
 */
import type { Field, TableRecord } from "@/api/types";
import { CellValue } from "@/components/record/CellValue";
import { cn } from "@/lib/cn";
import type { FormatCtx } from "@/lib/cells/format";
import { displayShapeOf } from "@/lib/cells/kinds";
import { fieldsToShow } from "./cardFields";

/** How many properties a List row and a Board card show by default. */
export const CARD_PROPERTY_LIMIT = 3;

/** The properties of `record` a card shows: those with a value, in the view's order, at most `limit`. */
export function cardProperties(fields: readonly Field[], record: TableRecord, format: FormatCtx, limit = CARD_PROPERTY_LIMIT): Field[] {
  return fieldsToShow(fields, record, format, limit);
}

export interface CardPropertiesProps {
  /** Already chosen with `cardProperties`. */
  fields: readonly Field[];
  record: TableRecord;
  format: FormatCtx;
  emails: ReadonlyMap<string, string>;
  className?: string;
}

export function CardProperties({ fields, record, format, emails, className }: CardPropertiesProps) {
  if (fields.length === 0) return null;
  return (
    <div data-card-properties className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted", className)}>
      {fields.map((f) => {
        const numeric = displayShapeOf(f) === "number";
        return (
          <span key={f.id} title={f.name} className={cn("min-w-0 max-w-full", numeric && "num ml-auto text-fg")}>
            {/* The property's name for a screen reader: the card's name is its drawn text, and a bare "3" or "Active" would not say what it is. */}
            <span className="sr-only">{f.name}: </span>
            <CellValue field={f} value={record.values[f.id] ?? null} format={format} emails={emails} className="truncate text-meta" markdown={false} />
          </span>
        );
      })}
    </div>
  );
}
