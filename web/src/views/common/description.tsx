/**
 * A view's description field (`ViewConfig.description_field_id`): any text field the view reads as
 * each record's description, under its title. Kanban, gallery and list show a clamped excerpt and
 * the full text on hover; calendar events and timeline bars show it on hover only. Nothing forces a
 * table to have one: a view without a description field simply shows titles. On a phone there is
 * no hover; tapping opens the record, which shows the whole field.
 */
import { useMemo, type ReactNode } from "react";
import { HoverCard } from "radix-ui";
import type { Field, Table, TableRecord, ViewConfig } from "@/api/types";
import { Markdown } from "@/components/record/Markdown";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { displayText, isFormulaError, type FormatCtx } from "@/lib/cells/format";
import { descriptionText, isDescriptionField } from "./cardFields";
import { FieldSelect } from "./ViewSettings";

/** The fields that can be a view's description, and the one the view chose (if it still can be). */
export function useDescriptionField(table: Pick<Table, "fields" | "primary_field_id">, config: Pick<ViewConfig, "description_field_id">): { candidates: Field[]; field: Field | undefined } {
  // The primary field is already the title. A field that stopped being text (converted) simply
  // goes back to being a field like the others; the saved setting is kept.
  const candidates = useMemo(() => table.fields.filter((f) => f.id !== table.primary_field_id && isDescriptionField(f)), [table.fields, table.primary_field_id]);
  const field = candidates.find((f) => f.id === config.description_field_id);
  return { candidates, field };
}

export function setDescriptionField(config: ViewConfig, id: string | null): ViewConfig {
  return { ...config, description_field_id: id };
}

/** The "Description" choice in a view's settings. */
export function DescriptionSelect({ candidates, field, disabled, onChange, hint }: { candidates: readonly Field[]; field: Field | undefined; disabled?: boolean; onChange: (id: string | null) => void; hint?: ReactNode }) {
  return (
    <FieldSelect
      label="Description"
      fields={candidates}
      value={field?.id ?? ""}
      noneLabel="No description"
      disabled={disabled}
      onChange={onChange}
      hint={hint ?? (candidates.length === 0 ? "Add a text field to show a description under each title." : "A text field read under each record's title. Point at it to read all of it.")}
    />
  );
}

/** The whole description: rich long text as markdown, anything else as text with its line breaks. */
function FullDescription({ field, value, format }: { field: Field; value: TableRecord["values"][string]; format: FormatCtx }) {
  if (field.type === "long_text" && field.options.rich && typeof value === "string") return <Markdown source={value} className="text-[0.8125rem]" />;
  return <p className="whitespace-pre-wrap break-words text-[0.8125rem] leading-[1.5]">{displayText(field, value, format)}</p>;
}

/** The primary pointer can hover (a mouse or trackpad); touch-first screens tap to open instead. */
const CAN_HOVER = "(hover: hover)";

/** What a chart needs to show a record's description on hover (see `DescriptionHover`). */
export interface DescriptionSource {
  field: Field;
  record: TableRecord;
  format: FormatCtx;
}

/** Whether `record` has anything to show for `field`. */
export function hasDescription(field: Field | undefined, record: TableRecord, format: FormatCtx): boolean {
  return descriptionText(field, record.values[field?.id ?? ""], format) !== "";
}

/**
 * Hovering (or focusing) `children` shows the record's title and its whole description in a card.
 * Without a description, or on a screen that cannot hover, it renders `children` as they are: Radix's
 * trigger cancels `touchstart`, which would stop a tap opening the record and a swipe scrolling.
 */
export function DescriptionHover({
  field,
  record,
  title,
  format,
  side = "bottom",
  suppress = false,
  children,
}: {
  field: Field | undefined;
  record: TableRecord;
  title: string;
  format: FormatCtx;
  side?: "top" | "bottom" | "left" | "right";
  /** Keep the card closed (while the child is being dragged); the child stays mounted. */
  suppress?: boolean;
  children: ReactNode;
}) {
  const canHover = useMediaQuery(CAN_HOVER);
  const value = field ? record.values[field.id] : undefined;
  if (!canHover || !field || value === null || value === undefined || isFormulaError(value) || !hasDescription(field, record, format)) return <>{children}</>;
  return (
    <HoverCard.Root openDelay={350} closeDelay={120} open={suppress ? false : undefined}>
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side={side}
          align="start"
          sideOffset={6}
          collisionPadding={12}
          data-description-hover
          onClick={(e) => e.stopPropagation()}
          className="ob-fade-in z-[60] flex max-h-[min(24rem,60dvh)] w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-1.5 overflow-y-auto rounded-lg border border-line bg-surface p-3 text-fg shadow-pop"
        >
          <p className="break-words text-[0.875rem] font-semibold">{title}</p>
          <p className="text-xs text-faint">{field.name}</p>
          <FullDescription field={field} value={value} format={format} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
