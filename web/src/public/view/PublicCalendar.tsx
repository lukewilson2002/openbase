/**
 * A shared calendar: the signed-in calendar's own surface (`CalendarSurface`: header, Month | Week | List, chips, the phone's day
 * sheet) with every editing gesture off. It asks the link only for the days on screen (`QueryRequest.range`). Records without a
 * date are not listed, and a record has no page to open from here.
 */
import { useMemo, useState } from "react";
import type { DateRange, TransientConfig } from "@/api/types";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { CalendarSurface, type ChipDescription } from "@/views/calendar/CalendarSurface";
import { recordsToEvents } from "@/views/calendar/eventMath";
import { firstDayOf, loadWeekStart } from "@/views/calendar/layout";
import type { DateFields } from "@/views/common/dateFields";
import { cardFieldsFor } from "./PublicCards";
import { useShare } from "./ShareContext";
import { usePublicAll } from "./usePublicRecords";
import type { SharedFields } from "./publicFields";

const noop = () => {};

export interface PublicCalendarProps {
  fields: SharedFields;
  dates: DateFields;
  descriptionId?: string | null;
  search: string;
  transient: TransientConfig | null;
}

export function PublicCalendar({ fields, dates, descriptionId, search, transient }: PublicCalendarProps) {
  const { token, password, format } = useShare();
  const zone = format.timeZone;
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [visible, setVisible] = useState<{ from: string; to: string } | null>(null);
  const range = useMemo<DateRange | null>(() => (visible ? { field_id: dates.start.field.id, end_field_id: dates.end?.field.id ?? null, from: visible.from, to: visible.to } : null), [dates, visible]);
  const records = usePublicAll({ token, password, fields, search, timeZone: zone, range, transient, cap: 2000, enabled: !!range });

  // What a chip shows under its title, and the description a hover reads: the view's own, from the properties the link shares.
  const card = useMemo(() => cardFieldsFor(fields.list, fields.title, null, new Set([dates.start.field.id, dates.end?.field.id ?? ""]), descriptionId), [fields, dates, descriptionId]);
  const events = useMemo(
    () => (records.data ? recordsToEvents(records.data.records, { fields: dates, primary: fields.title, format, colors: records.data.colors, canEdit: false, chipFields: card.rest }) : []),
    [records.data, dates, fields.title, format, card.rest],
  );
  const description = useMemo<ChipDescription | null>(
    () => (card.description && records.data ? { field: card.description, byId: new Map(records.data.records.map((r) => [r.id, r] as const)), format } : null),
    [card.description, records.data, format],
  );
  const firstDay = useMemo(() => firstDayOf(loadWeekStart()), []);
  const data = records.data;

  return (
    <section aria-label="Calendar" className="flex flex-col gap-3">
      <div className="relative flex h-[min(44rem,78vh)] min-h-[28rem] overflow-hidden rounded-lg border border-line bg-surface">
        <div className="absolute inset-0 flex">
          <CalendarSurface
            stateKey={`share:${token}`}
            fields={dates}
            events={events}
            timeZone={zone}
            desktop={desktop}
            firstDay={firstDay}
            sorted={false}
            fetching={records.fetching}
            description={description}
            onVisibleRange={setVisible}
            onOpen={noop}
          />
        </div>
      </div>
      {records.error && !data && <p role="alert" className="text-label text-danger">Could not load records: {records.error.message}</p>}
      {data?.truncated && <p className="text-meta text-muted">Showing the first {data.records.length.toLocaleString()} of {data.total.toLocaleString()} records of this stretch.</p>}
    </section>
  );
}
