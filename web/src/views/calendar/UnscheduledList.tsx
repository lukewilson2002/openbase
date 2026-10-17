/**
 * The calendar's right-hand column of records without a start date; each can be dragged onto a
 * day to schedule it. It folds into a narrow strip that still says how many there are.
 */
import { Fragment, useEffect, useRef } from "react";
import { Draggable } from "@fullcalendar/interaction";
import { ChevronsLeft, ChevronsRight, GripVertical } from "lucide-react";
import type { Field, TableRecord } from "@/api/types";
import { CellValue } from "@/components/record/CellValue";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import type { FormatCtx } from "@/lib/cells/format";
import { cardTitle, fieldsToShow } from "../common/cardFields";
import { DescriptionHover } from "../common/description";

export interface UnscheduledListProps {
  open: boolean;
  onToggle(): void;
  records: readonly TableRecord[];
  primary: Field | undefined;
  /** Fields a record may show under its title (the first two that have a value are shown). */
  fields: readonly Field[];
  /** The view's description field, read in full when pointing at a record's title. */
  descriptionField?: Field;
  format: FormatCtx;
  emails: ReadonlyMap<string, string>;
  loading: boolean;
  truncated: boolean;
  /** Dragging needs permission to edit the start date. */
  draggable: boolean;
  onOpen(recordId: string): void;
}

const columnBg = "bg-[color-mix(in_srgb,var(--bg)_55%,var(--surface))]";

export function UnscheduledList({ open, onToggle, records, primary, fields, descriptionField, format, emails, loading, truncated, draggable, onOpen }: UnscheduledListProps) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    // The list is not mounted while loading or folded, so those re-run this once it is.
    const el = list.current;
    if (!el || !draggable || loading || !open) return;
    const d = new Draggable(el, {
      itemSelector: "[data-unscheduled]",
      eventData: (item) => ({ title: item.getAttribute("data-title") ?? "", create: false }),
    });
    return () => d.destroy();
  }, [draggable, loading, open]);

  const count = loading ? null : records.length;

  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={false}
        aria-label={count === null ? "Show unscheduled records" : `Show unscheduled records, ${count}`}
        className={cn("flex w-11 shrink-0 flex-col items-center gap-2 border-l border-line py-3 text-[0.8125rem] font-semibold text-muted hover:bg-hover hover:text-fg", columnBg)}
      >
        <ChevronsLeft aria-hidden className="size-4" />
        <span className="[writing-mode:vertical-rl]">Unscheduled{count === null ? "" : ` · ${count}`}</span>
      </button>
    );
  }

  return (
    <aside aria-label="Unscheduled records" className={cn("flex w-52 shrink-0 flex-col border-l border-line", columnBg)}>
      <div className="flex items-start gap-1.5 border-b border-[color-mix(in_srgb,var(--line)_60%,var(--surface))] py-3 pl-3.5 pr-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[0.875rem] font-[650]">
            Unscheduled {count !== null && <span className="font-semibold text-muted">{count}</span>}
          </h3>
          <p className="mt-0.5 text-xs leading-snug text-muted">{draggable ? "Drag a record onto a day to give it a date." : "Records without a date."}</p>
        </div>
        <IconButton label="Hide unscheduled records" size="sm" noTooltip aria-expanded onClick={onToggle}>
          <ChevronsRight aria-hidden className="size-4" />
        </IconButton>
      </div>
      {loading ? (
        <div className="flex justify-center p-6">
          <Spinner className="size-4" label="Loading unscheduled records" />
        </div>
      ) : (
        <ul ref={list} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2.5">
          {records.map((r) => {
            const title = cardTitle(primary, r, format);
            const shown = fieldsToShow(fields, r, format, 2);
            return (
              <li
                key={r.id}
                data-unscheduled
                data-record-id={r.id}
                data-title={title}
                className={cn(
                  "flex select-none items-start gap-1.5 rounded-lg border border-line bg-surface py-2 pl-1.5 pr-2.5 transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-[0_4px_12px_rgb(15_20_30/0.08)]",
                  draggable && "cursor-grab",
                )}
              >
                {draggable && <GripVertical aria-hidden className="mt-0.5 size-3.5 shrink-0 text-faint" />}
                <span className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
                  <DescriptionHover field={descriptionField} record={r} title={title} format={format} side="left">
                    <button type="button" onClick={() => onOpen(r.id)} className="max-w-full truncate text-left text-[0.8125rem] font-semibold hover:underline" title={descriptionField ? undefined : title}>
                      {title}
                    </button>
                  </DescriptionHover>
                  {shown.length > 0 && (
                    <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-muted">
                      {shown.map((f, i) => (
                        <Fragment key={f.id}>
                          {i > 0 && <span aria-hidden>·</span>}
                          <CellValue field={f} value={r.values[f.id] ?? null} format={format} emails={emails} className="truncate text-xs" markdown={false} />
                        </Fragment>
                      ))}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
          {records.length === 0 && <li className="px-1 py-4 text-center text-xs text-faint">Every record has a date.</li>}
          {truncated && <li className="px-1 py-2 text-center text-xs text-muted">Showing the first records only.</li>}
        </ul>
      )}
    </aside>
  );
}
