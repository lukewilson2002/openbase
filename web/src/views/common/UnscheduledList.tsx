/**
 * The right-hand column of records without a start date, beside the calendar and the timeline; each
 * can be dragged onto a day to schedule it. It folds into a narrow strip that still says how many
 * there are. The calendar attaches FullCalendar's own drag helper (`attachDrag`); elsewhere
 * (`nativeDrag`) an item is an HTML drag carrying its record id as `RECORD_DRAG_TYPE`. Nothing here
 * imports FullCalendar, so a view without a calendar does not load its styles.
 *
 * On a phone (`stacked`) there is no room beside the view: the closed column becomes a pill at the
 * bottom of it, and the open one a sheet over its lower part, full width, so the days stay in reach.
 */
import { useEffect, useRef, type Ref } from "react";
import { ChevronsLeft, ChevronsRight, ChevronDown, GripVertical, Inbox } from "lucide-react";
import type { Field, Table, TableRecord } from "@/api/types";
import { RecordSummary } from "@/components/record/RecordSummary";
import { RecordPeek } from "@/components/record/linked/LinkedRecords";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import type { FormatCtx } from "@/lib/cells/format";
import { cardTitle } from "../common/cardFields";

/** The drag data type of a record dragged out of the list (`nativeDrag`): its id. */
export const RECORD_DRAG_TYPE = "application/x-openbase-record";

export interface UnscheduledListProps {
  open: boolean;
  onToggle(): void;
  records: readonly TableRecord[];
  primary: Field | undefined;
  /** The fields a record's summary is drawn from (see `RecordSummary`), in order. */
  fields: readonly Field[];
  /** The view's description field, if it has one (else a record's first text field describes it). */
  descriptionField?: Field;
  /** The records' table and the person's role there: hovering a record shows all its fields. */
  table?: Table;
  role?: string;
  format: FormatCtx;
  emails: ReadonlyMap<string, string>;
  loading: boolean;
  truncated: boolean;
  /** Dragging needs permission to edit the start date. */
  draggable: boolean;
  /** Drag with the browser's own drag and drop (see `RECORD_DRAG_TYPE`). */
  nativeDrag?: boolean;
  /** Makes the list's `[data-unscheduled]` items draggable some other way (the calendar's helper); returns its cleanup. */
  attachDrag?: (list: HTMLUListElement) => () => void;
  /** What dragging does, under the heading. */
  hint?: string;
  /** Something dragged over the column will be unscheduled when dropped (a timeline bar): it shows it takes it. */
  dropActive?: boolean;
  /** Phone layout (see the file comment). The list's parent must be positioned: the pill and the sheet sit at its bottom. */
  stacked?: boolean;
  /** The column's outer element, for a view that tests where a dragged item was dropped. */
  zoneRef?: Ref<HTMLElement>;
  onOpen(recordId: string): void;
}

const columnBg = "bg-[color-mix(in_srgb,var(--bg)_55%,var(--surface))]";
const dropClass = "bg-primary-soft ring-2 ring-inset ring-ring";

export function UnscheduledList({ open, onToggle, records, primary, fields, descriptionField, table, role, format, emails, loading, truncated, draggable, nativeDrag, attachDrag, hint, dropActive = false, stacked = false, zoneRef, onOpen }: UnscheduledListProps) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    // The list is not mounted while loading or folded, so those re-run this once it is.
    const el = list.current;
    if (!el || !draggable || nativeDrag || !attachDrag || loading || !open) return;
    return attachDrag(el);
  }, [draggable, nativeDrag, attachDrag, loading, open]);

  const count = loading ? null : records.length;
  // Every field on hover (a held finger is a drag here, so it does not open them).
  const peek = (r: TableRecord, card: React.ReactElement) =>
    table && role ? (
      <RecordPeek table={table} recordId={r.id} record={r} format={format} emails={emails} role={role} onOpen={() => onOpen(r.id)} side="left" touchHold={false} className="min-w-0 flex-1">
        {card}
      </RecordPeek>
    ) : (
      card
    );

  if (!open) {
    const label = count === null ? "Show unscheduled records" : `Show unscheduled records, ${count}`;
    if (stacked) {
      return (
        <button
          ref={zoneRef as Ref<HTMLButtonElement>}
          type="button"
          onClick={onToggle}
          aria-expanded={false}
          aria-label={label}
          className={cn("absolute bottom-3 left-3 z-10 flex h-10 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-[0.8125rem] font-semibold shadow-pop", dropActive && dropClass)}
        >
          <Inbox aria-hidden className="size-4 text-muted" />
          Unscheduled{count === null ? "" : ` · ${count}`}
        </button>
      );
    }
    return (
      <button
        ref={zoneRef as Ref<HTMLButtonElement>}
        type="button"
        onClick={onToggle}
        aria-expanded={false}
        aria-label={label}
        className={cn("flex w-11 shrink-0 flex-col items-center gap-2 border-l border-line py-3 text-[0.8125rem] font-semibold text-muted hover:bg-hover hover:text-fg", columnBg, dropActive && dropClass)}
      >
        <ChevronsLeft aria-hidden className="size-4" />
        <span className="[writing-mode:vertical-rl]">Unscheduled{count === null ? "" : ` · ${count}`}</span>
      </button>
    );
  }

  return (
    <aside
      ref={zoneRef as Ref<HTMLElement>}
      aria-label="Unscheduled records"
      data-drop-active={dropActive || undefined}
      data-stacked={stacked || undefined}
      className={cn(
        "flex shrink-0 flex-col",
        stacked ? "absolute inset-x-0 bottom-0 z-20 max-h-[55%] rounded-t-xl border-t border-line shadow-pop" : "w-52 border-l border-line",
        columnBg,
        dropActive && dropClass,
      )}
    >
      <div className="flex items-start gap-1.5 border-b border-[color-mix(in_srgb,var(--line)_60%,var(--surface))] py-3 pl-3.5 pr-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[0.875rem] font-[650]">
            Unscheduled {count !== null && <span className="font-semibold text-muted">{count}</span>}
          </h3>
          <p className="mt-0.5 text-xs leading-snug text-muted">{draggable ? (hint ?? (stacked ? "Hold a record, then drag it onto a day to give it a date." : "Drag a record onto a day to give it a date.")) : "Records without a date."}</p>
        </div>
        <IconButton label="Hide unscheduled records" size="sm" noTooltip aria-expanded onClick={onToggle}>
          {stacked ? <ChevronDown aria-hidden className="size-4" /> : <ChevronsRight aria-hidden className="size-4" />}
        </IconButton>
      </div>
      {loading ? (
        <div className="flex justify-center p-6">
          <Spinner className="size-4" label="Loading unscheduled records" />
        </div>
      ) : (
        <ul ref={list} className={cn("flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2.5", stacked && "pb-[max(0.625rem,env(safe-area-inset-bottom))] max-md:pb-16")}>
          {records.map((r) => {
            const title = cardTitle(primary, r, format);
            return (
              <li
                key={r.id}
                data-unscheduled
                data-record-id={r.id}
                data-title={title}
                draggable={draggable && nativeDrag ? true : undefined}
                onDragStart={
                  draggable && nativeDrag
                    ? (e) => {
                        e.dataTransfer.setData(RECORD_DRAG_TYPE, r.id);
                        e.dataTransfer.setData("text/plain", title);
                        e.dataTransfer.effectAllowed = "move";
                      }
                    : undefined
                }
                className={cn(
                  "flex select-none items-start gap-1.5 rounded-lg border border-line bg-surface py-2 pl-1.5 pr-2.5 transition-[border-color,box-shadow] hover:border-primary-soft-line hover:shadow-[0_4px_12px_rgb(15_20_30/0.08)]",
                  draggable && "cursor-grab",
                )}
              >
                {draggable && <GripVertical aria-hidden className="mt-0.5 size-3.5 shrink-0 text-faint" />}
                {peek(
                  r,
                  <RecordSummary
                    title={
                      <button type="button" onClick={() => onOpen(r.id)} className="max-w-full truncate text-left text-[0.8125rem] font-semibold hover:underline">
                        {title}
                      </button>
                    }
                    record={r}
                    fields={fields}
                    descriptionField={descriptionField}
                    format={format}
                    emails={emails}
                    className="flex-1"
                  />,
                )}
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
