/**
 * A record told apart at a glance, the same wherever records are listed as cards: a linked record in
 * the record panel, one picked or being picked in a link field, an undated record beside the calendar
 * or the timeline. It shows the title, one line of description and the record's labels (its filled
 * single and multiple selects); a record without labels shows its first couple of other filled fields
 * instead, each on a line after its name ("Tasks", then the chips). `detailed` (the picker, while choosing) gives the description two lines and adds a few
 * more fields. Every field is one hover away: callers wrap the card in `RecordPeek`.
 */
import type { ReactNode } from "react";
import type { Field, TableRecord } from "@/api/types";
import { cn } from "@/lib/cn";
import type { FormatCtx } from "@/lib/cells/format";
import { displayShapeOf } from "@/lib/cells/kinds";
import { descriptionText, fieldsToShow, isDescriptionField } from "@/views/common/cardFields";
import { CellValue } from "./CellValue";
import { CompactLinksProvider } from "./linked/LinkedRecords";

/** Labels a summary shows at most (`detailed`: the extra fields after them). */
const LABELS = 3;
const EXTRA_DETAILED = 3;
const EXTRA_PLAIN = 2;

const isLabel = (f: Field) => {
  const shape = displayShapeOf(f);
  return shape === "select" || shape === "multi_select";
};

export interface SummaryParts {
  description: string;
  /** Filled fields shown as chips or short values under the description, in order. */
  details: Field[];
}

/**
 * What a record's summary shows. `fields` are the record's fields in their order without the title
 * (the table's layout, or a view's card fields); `descriptionField` is the view's chosen one, if any,
 * else the first text field with something in it describes the record.
 */
export function summaryParts(fields: readonly Field[], record: TableRecord, format: FormatCtx, { descriptionField, detailed = false }: { descriptionField?: Field; detailed?: boolean } = {}): SummaryParts {
  const describing = descriptionField ?? fields.find((f) => isDescriptionField(f) && descriptionText(f, record.values[f.id], format) !== "");
  const description = descriptionText(describing, describing ? record.values[describing.id] : undefined, format);
  const rest = fields.filter((f) => f.id !== describing?.id && !(isDescriptionField(f) && displayShapeOf(f) === "multiline") && displayShapeOf(f) !== "button");
  const labels = fieldsToShow(rest.filter(isLabel), record, format, LABELS);
  const others = fieldsToShow(
    rest.filter((f) => !isLabel(f) && displayShapeOf(f) !== "attachment"),
    record,
    format,
    detailed ? EXTRA_DETAILED : labels.length > 0 ? 0 : EXTRA_PLAIN,
  );
  return { description, details: [...labels, ...others] };
}

export interface RecordSummaryProps {
  /** The title as shown: plain text, or a button or link of the caller's. */
  title: ReactNode;
  record: TableRecord | undefined;
  fields: readonly Field[];
  descriptionField?: Field;
  format: FormatCtx;
  emails?: ReadonlyMap<string, string>;
  detailed?: boolean;
  className?: string;
}

export function RecordSummary({ title, record, fields, descriptionField, format, emails, detailed = false, className }: RecordSummaryProps) {
  const parts = record ? summaryParts(fields, record, format, { descriptionField, detailed }) : { description: "", details: [] };
  const labels = parts.details.filter(isLabel);
  const others = parts.details.filter((f) => !isLabel(f));
  return (
    <span className={cn("flex min-w-0 flex-col items-start gap-1", className)}>
      {title}
      {parts.description && <span className={cn("w-full break-words text-xs leading-snug text-muted", detailed ? "line-clamp-2" : "line-clamp-1")}>{parts.description}</span>}
      {parts.details.length > 0 && record && (
        // A link field here is a value among others: small chips, not cards of its own.
        <CompactLinksProvider value>
          {labels.length > 0 && (
            <span className="flex w-full min-w-0 flex-wrap items-center gap-1">
              {labels.map((f) => (
                <CellValue key={f.id} field={f} value={record.values[f.id] ?? null} format={format} emails={emails} className="truncate text-xs" markdown={false} />
              ))}
            </span>
          )}
          {/* The other fields each on a line, named, as in a list: "Tasks" says what the chips after it are. */}
          {others.map((f) => (
            <span key={f.id} className="flex w-full min-w-0 items-baseline gap-1.5 text-xs">
              <span className="max-w-[40%] shrink-0 truncate text-faint">{f.name}</span>
              <CellValue field={f} value={record.values[f.id] ?? null} format={format} emails={emails} className="min-w-0 flex-1 truncate text-xs text-muted" markdown={false} />
            </span>
          ))}
        </CompactLinksProvider>
      )}
    </span>
  );
}
