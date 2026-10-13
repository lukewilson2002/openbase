/**
 * A shared calendar: a month grid (Sunday first) with the records on their dates. Each month asks
 * the server only for its visible days (`QueryRequest.range`). Read-only: nothing can be dragged.
 */
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { DateRange, TransientConfig } from "@/api/types";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { paletteColor } from "@/lib/cells/palette";
import { todayIn } from "@/lib/cells/dates";
import type { DateFields } from "@/views/common/dateFields";
import { cardTitle } from "@/views/common/cardFields";
import { chipsByDay, cursorOf, monthDays, monthTitle, shiftMonth, type DayChip } from "./monthGrid";
import { useShare } from "./ShareContext";
import { usePublicAll } from "./usePublicRecords";
import type { SharedFields } from "./publicFields";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHOWN_PER_DAY = 3;

function Chip({ chip }: { chip: DayChip }) {
  const p = chip.color ? paletteColor(chip.color) : null;
  return (
    <li
      title={chip.time ? `${chip.time} ${chip.title}` : chip.title}
      data-record-id={chip.id}
      className={cn("truncate rounded px-1.5 py-0.5 text-xs", !p && "bg-primary-soft text-primary")}
      style={p ? { background: p.bg, color: p.fg } : undefined}
    >
      {chip.time && <span className="mr-1 opacity-80">{chip.time}</span>}
      {chip.title}
    </li>
  );
}

export interface PublicCalendarProps {
  fields: SharedFields;
  dates: DateFields;
  search: string;
  transient: TransientConfig | null;
}

export function PublicCalendar({ fields, dates, search, transient }: PublicCalendarProps) {
  const { token, password, format } = useShare();
  const zone = format.timeZone;
  const today = todayIn(zone);
  const [cursor, setCursor] = useState(() => cursorOf(today));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const days = useMemo(() => monthDays(cursor), [cursor]);
  const range = useMemo<DateRange>(() => ({ field_id: dates.start.field.id, end_field_id: dates.end?.field.id ?? null, from: days[0]!, to: days[41]! }), [dates, days]);
  const records = usePublicAll({ token, password, fields, search, timeZone: zone, range, transient, cap: 2000 });

  const chips = useMemo(
    () => (records.data ? chipsByDay(records.data.records, dates, zone, days, (r) => cardTitle(fields.title, r, format), records.data.colors) : new Map<string, DayChip[]>()),
    [records.data, dates, zone, days, fields.title, format],
  );
  const monthNo = cursor.month;

  return (
    <section aria-label="Calendar" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <IconButton label="Previous month" variant="secondary" onClick={() => setCursor((c) => shiftMonth(c, -1))}>
          <ChevronLeft aria-hidden className="size-4" />
        </IconButton>
        <IconButton label="Next month" variant="secondary" onClick={() => setCursor((c) => shiftMonth(c, 1))}>
          <ChevronRight aria-hidden className="size-4" />
        </IconButton>
        <Button size="sm" onClick={() => setCursor(cursorOf(today))}>
          Today
        </Button>
        <h2 className="text-base font-semibold" aria-live="polite">
          {monthTitle(cursor)}
        </h2>
        {records.fetching && <Spinner className="size-4" label="Loading records" />}
      </div>
      {records.error && !records.data && <p role="alert" className="text-[0.8125rem] text-danger">Could not load records: {records.error.message}</p>}
      <div className="overflow-x-auto">
        <div className="min-w-[44rem] overflow-hidden rounded-lg border border-line bg-surface">
          <div className="grid grid-cols-7 border-b border-line bg-subtle text-center text-xs font-medium text-muted">
            {WEEKDAYS.map((d) => (
              <div key={d} className="py-1.5">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7" role="grid" aria-label={monthTitle(cursor)}>
            {days.map((ymd) => {
              const list = chips.get(ymd) ?? [];
              const open = expanded.has(ymd);
              const shown = open ? list : list.slice(0, SHOWN_PER_DAY);
              const inMonth = Number(ymd.slice(5, 7)) === monthNo;
              return (
                <div key={ymd} role="gridcell" data-date={ymd} aria-label={ymd} className={cn("min-h-24 border-b border-r border-line p-1", !inMonth && "bg-subtle/60 text-faint")}>
                  <div className={cn("mb-1 text-right text-xs", ymd === today && "font-semibold")}>
                    <span className={cn("inline-flex size-5 items-center justify-center rounded-full", ymd === today && "bg-primary text-primary-fg")}>{Number(ymd.slice(8, 10))}</span>
                  </div>
                  <ul className="flex flex-col gap-0.5">
                    {shown.map((c) => (
                      <Chip key={`${c.id}`} chip={c} />
                    ))}
                  </ul>
                  {!open && list.length > SHOWN_PER_DAY && (
                    <button type="button" onClick={() => setExpanded((s) => new Set(s).add(ymd))} className="mt-0.5 px-1 text-xs text-muted hover:text-fg">
                      +{list.length - SHOWN_PER_DAY} more
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {records.data?.truncated && <p className="text-xs text-muted">Showing the first {records.data.records.length.toLocaleString()} of {records.data.total.toLocaleString()} records of this month.</p>}
    </section>
  );
}

