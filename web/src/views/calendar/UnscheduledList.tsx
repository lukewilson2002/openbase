/** Sidebar of records without a start date; each can be dragged onto the calendar to schedule it. */
import { useEffect, useRef } from "react";
import { Draggable } from "@fullcalendar/interaction";
import type { Field, TableRecord } from "@/api/types";
import { Spinner } from "@/components/ui/spinner";
import type { FormatCtx } from "@/lib/cells/format";
import { cardTitle } from "../common/cardFields";

export function UnscheduledList({
  records,
  primary,
  format,
  loading,
  truncated,
  draggable,
  onOpen,
}: {
  records: readonly TableRecord[];
  primary: Field | undefined;
  format: FormatCtx;
  loading: boolean;
  truncated: boolean;
  /** Dragging needs permission to edit the start date. */
  draggable: boolean;
  onOpen(recordId: string): void;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = list.current;
    if (!el || !draggable) return;
    const d = new Draggable(el, {
      itemSelector: "[data-unscheduled]",
      eventData: (item) => ({ title: item.getAttribute("data-title") ?? "", create: false }),
    });
    return () => d.destroy();
  }, [draggable]);

  return (
    <aside aria-label="Unscheduled records" className="flex w-64 shrink-0 flex-col border-l border-line bg-surface">
      <div className="border-b border-line px-3 py-2">
        <h3 className="text-[0.8125rem] font-semibold">Unscheduled</h3>
        <p className="text-xs text-muted">{draggable ? "Drag a record onto a day to schedule it." : "Records without a date."}</p>
      </div>
      {loading ? (
        <div className="flex justify-center p-6">
          <Spinner className="size-4" label="Loading unscheduled records" />
        </div>
      ) : (
        <ul ref={list} className="min-h-0 flex-1 overflow-y-auto p-2">
          {records.map((r) => {
            const title = cardTitle(primary, r, format);
            return (
              <li
                key={r.id}
                data-unscheduled
                data-record-id={r.id}
                data-title={title}
                className={`mb-1.5 flex items-center rounded-md border border-line bg-subtle px-2 py-1.5 text-[0.8125rem] ${draggable ? "cursor-grab" : ""}`}
              >
                <button type="button" onClick={() => onOpen(r.id)} className="min-w-0 flex-1 truncate text-left hover:underline" title={title}>
                  {title}
                </button>
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
