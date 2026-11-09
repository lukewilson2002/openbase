/**
 * The body of a shared view: search, paging and the renderer for the view's type.
 *
 * Each layout is the signed-in view's own drawing, told it only shows, over records read from the link
 * (`/api/public/shares/*`) rather than the signed-in API:
 *   - grid        -> the signed-in grid's canvas (`GlideGrid`) over the page loader the grid uses;
 *   - list        -> the signed-in List's outline (`ListOutline`);
 *   - gallery     -> the signed-in gallery's card body in its grid;
 *   - kanban      -> the signed-in board (`KanbanBoard`);
 *   - calendar    -> the signed-in calendar's surface (`CalendarSurface`), one query per range on screen;
 *   - timeline    -> the timeline chart with every editing gesture off.
 * A board, calendar or timeline whose configured field is not visible in the share falls back to
 * the table and says so.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import type { PublicView, Sort, TransientConfig } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useDebounced } from "@/components/record/editors/useDebounced";
import { browserTimeZone } from "@/lib/format";
import { resolveDateFields } from "@/views/common/dateFields";
import { stackKind } from "@/views/kanban/stacks";
import { PublicCalendar } from "./PublicCalendar";
import { PublicGallery, PublicKanban, cardFieldsFor } from "./PublicCards";
import { PublicList } from "./PublicList";
import { PublicGrid, usePublicGridData } from "./PublicGrid";
import { PublicTimeline } from "./PublicTimeline";
import { ShareProvider } from "./ShareContext";
import { sharedFields } from "./publicFields";
import { usePublicAll } from "./usePublicRecords";

export interface SharedViewProps {
  token: string;
  password: string | null;
  view: PublicView;
}

function Toolbar({ search, onSearch, summary, children }: { search: string; onSearch: (s: string) => void; summary: ReactNode; children?: ReactNode }) {
  return (
    <div role="toolbar" aria-label="Shared view toolbar" className="mb-3 flex flex-wrap items-center gap-2">
      <div className="relative max-md:w-full">
        <Search aria-hidden className="pointer-events-none absolute left-2 top-2 size-4 text-muted max-md:top-3.5" />
        <Input type="search" aria-label="Search records" placeholder="Search records" value={search} onChange={(e) => onSearch(e.target.value)} className="h-8 w-56 pl-8 max-md:h-control-touch max-md:w-full max-md:text-read-phone" />
      </div>
      <span className="text-label text-muted" aria-live="polite">
        {summary}
      </span>
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

/** The layouts that can fall back to a table, by the names the interface gives them. */
const LAYOUT_NAME = { kanban: "Board", calendar: "Calendar", timeline: "Timeline" } as const;

const count = (n: number) => `${n.toLocaleString()} record${n === 1 ? "" : "s"}`;

function ErrorLine({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div role="alert" className="mb-3 flex items-center gap-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-label text-danger">
      <span className="flex-1">Could not load records: {error.message}</span>
      <Button size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function SharedView({ token, password, view }: SharedViewProps) {
  const timeZone = useMemo(() => browserTimeZone(), []);
  const format = useMemo(() => ({ timeZone, userName: () => undefined }), [timeZone]);
  const fields = useMemo(() => sharedFields(view), [view]);
  const [searchText, setSearchText] = useState("");
  const search = useDebounced(searchText.trim(), 300);
  const [sort, setSort] = useState<Sort | null>(null);
  const transient = useMemo<TransientConfig | null>(() => (sort ? { sorts: [sort] } : null), [sort]);

  const cfg = view.config;
  const type = view.type;
  const dates = useMemo(() => {
    if (type === "calendar") return resolveDateFields(fields.list, cfg.calendar_date_field_id, cfg.calendar_end_field_id);
    if (type === "timeline") return resolveDateFields(fields.list, cfg.timeline_start_field_id, cfg.timeline_end_field_id);
    return null;
  }, [type, fields.list, cfg.calendar_date_field_id, cfg.calendar_end_field_id, cfg.timeline_start_field_id, cfg.timeline_end_field_id]);
  const stackField = type === "kanban" ? fields.byId.get(cfg.kanban_stack_field_id ?? "") : undefined;

  const mode: "table" | "list" | "gallery" | "kanban" | "calendar" | "timeline" =
    type === "list" ? "list" : type === "gallery" ? "gallery" : type === "kanban" && stackKind(stackField) ? "kanban" : type === "calendar" && dates ? "calendar" : type === "timeline" && dates ? "timeline" : "table";
  const fallback = mode === "table" && (type === "kanban" || type === "calendar" || type === "timeline");

  return (
    <ShareProvider value={{ token, password, format }}>
      {fallback && (
        <p className="mb-3 rounded-md bg-subtle px-3 py-2 text-label text-muted">
          This {LAYOUT_NAME[type as "kanban" | "calendar" | "timeline"]} needs a property that is not shared, so its records are shown as a table.
        </p>
      )}
      {mode === "table" && <TableBody view={view} fields={fields} token={token} password={password} search={search} searchText={searchText} onSearch={setSearchText} sort={sort} onSort={setSort} transient={transient} timeZone={timeZone} />}
      {mode === "list" && <ListBody fields={fields} token={token} password={password} search={search} searchText={searchText} onSearch={setSearchText} descriptionId={cfg.description_field_id} timeZone={timeZone} />}
      {mode === "gallery" && <GalleryBody fields={fields} token={token} password={password} search={search} searchText={searchText} onSearch={setSearchText} coverId={cfg.gallery_cover_field_id} descriptionId={cfg.description_field_id} timeZone={timeZone} />}
      {mode === "kanban" && stackField && <KanbanBody fields={fields} token={token} password={password} search={search} searchText={searchText} onSearch={setSearchText} stackFieldId={stackField.id} hideEmpty={cfg.kanban_hide_empty_stacks} stackOrder={cfg.kanban_stack_order} hiddenStacks={cfg.kanban_hidden_stacks} cardFieldLimit={cfg.kanban_card_field_limit ?? undefined} coverFit={cfg.kanban_cover_fit} coverId={cfg.kanban_cover_field_id} descriptionId={cfg.description_field_id} timeZone={timeZone} />}
      {mode === "calendar" && dates && (
        <>
          <Toolbar search={searchText} onSearch={setSearchText} summary={null} />
          <PublicCalendar fields={fields} dates={dates} descriptionId={cfg.description_field_id} search={search} transient={null} />
        </>
      )}
      {mode === "timeline" && dates && (
        <>
          <Toolbar search={searchText} onSearch={setSearchText} summary={null} />
          <PublicTimeline fields={fields} dates={dates} groupField={fields.byId.get(cfg.timeline_group_field_id ?? "")} search={search} transient={null} />
        </>
      )}
    </ShareProvider>
  );
}

type BodyProps = { fields: ReturnType<typeof sharedFields>; token: string; password: string | null; search: string; searchText: string; onSearch: (s: string) => void; timeZone: string };

function TableBody(p: BodyProps & { view: PublicView; sort: Sort | null; onSort: (s: Sort | null) => void; transient: TransientConfig | null }) {
  const data = usePublicGridData({ token: p.token, password: p.password, fields: p.fields, search: p.search, timeZone: p.timeZone, transient: p.transient });
  const summary = data.loading ? "Loading…" : data.total === 0 ? (p.search ? "No records match your search." : "No records.") : count(data.total);
  return (
    <>
      <Toolbar search={p.searchText} onSearch={p.onSearch} summary={summary}>
        {data.loading && <Spinner className="size-4" label="Loading records" />}
      </Toolbar>
      {data.error && data.total === 0 && !data.loading && <ErrorLine error={data.error} onRetry={data.refresh} />}
      <PublicGrid fields={p.fields} widths={p.view.config.field_widths} data={data} search={p.search} sort={p.sort} onSort={p.onSort} />
    </>
  );
}

/**
 * A list loads whole, like a board: the outline reads each group's rows from the group headers' positions in the one ordered
 * result, so a page of it (whose records start somewhere in the middle of the headers' numbering) would put rows under the wrong group.
 */
function ListBody(p: BodyProps & { descriptionId: string | null | undefined }) {
  const all = usePublicAll({ token: p.token, password: p.password, fields: p.fields, search: p.search, timeZone: p.timeZone });
  const data = all.data;
  return (
    <>
      <Toolbar search={p.searchText} onSearch={p.onSearch} summary={data ? (data.total === 0 ? (p.search ? "No records match your search." : "No records.") : count(data.total)) : "Loading…"}>
        {all.fetching && <Spinner className="size-4" label="Loading records" />}
      </Toolbar>
      {all.error && !data && <ErrorLine error={all.error} onRetry={all.refetch} />}
      {data && <PublicList fields={p.fields} records={data.records} groups={data.groups} colors={data.colors} descriptionField={p.fields.byId.get(p.descriptionId ?? "")} />}
      {data?.truncated && <p className="mt-3 text-meta text-muted">Showing the first {data.records.length.toLocaleString()} of {data.total.toLocaleString()} records.</p>}
    </>
  );
}

function GalleryBody(p: BodyProps & { coverId: string | null | undefined; descriptionId: string | null | undefined }) {
  const all = usePublicAll({ token: p.token, password: p.password, fields: p.fields, search: p.search, timeZone: p.timeZone });
  const data = all.data;
  const card = useMemo(() => cardFieldsFor(p.fields.list, p.fields.title, p.coverId, new Set(), p.descriptionId), [p.fields, p.coverId, p.descriptionId]);
  return (
    <>
      <Toolbar search={p.searchText} onSearch={p.onSearch} summary={data ? (data.total === 0 ? "No records." : count(data.total)) : "Loading…"}>
        {all.fetching && <Spinner className="size-4" label="Loading records" />}
      </Toolbar>
      {all.error && !data && <ErrorLine error={all.error} onRetry={all.refetch} />}
      {data && <PublicGallery records={data.records} fields={card} colors={data.colors} fit="cover" />}
      {data?.truncated && <p className="mt-3 text-meta text-muted">Showing the first {data.records.length.toLocaleString()} of {data.total.toLocaleString()} records.</p>}
    </>
  );
}

function KanbanBody(p: BodyProps & { stackFieldId: string; hideEmpty: boolean; stackOrder: readonly string[]; hiddenStacks: readonly string[]; cardFieldLimit?: number; coverFit: boolean; coverId: string | null | undefined; descriptionId: string | null | undefined }) {
  const all = usePublicAll({ token: p.token, password: p.password, fields: p.fields, search: p.search, timeZone: p.timeZone });
  const data = all.data;
  const stackField = p.fields.byId.get(p.stackFieldId)!;
  const card = useMemo(() => cardFieldsFor(p.fields.list, p.fields.title, p.coverId, new Set([p.stackFieldId]), p.descriptionId), [p.fields, p.coverId, p.stackFieldId, p.descriptionId]);
  return (
    <>
      <Toolbar search={p.searchText} onSearch={p.onSearch} summary={data ? (data.total === 0 ? "No cards." : `${data.total.toLocaleString()} card${data.total === 1 ? "" : "s"}`) : "Loading…"}>
        {all.fetching && <Spinner className="size-4" label="Loading records" />}
      </Toolbar>
      {all.error && !data && <ErrorLine error={all.error} onRetry={all.refetch} />}
      {data && <PublicKanban stackField={stackField} hideEmpty={p.hideEmpty} stackOrder={p.stackOrder} hiddenStacks={p.hiddenStacks} cardFieldLimit={p.cardFieldLimit} coverFit={p.coverFit} records={data.records} fields={card} colors={data.colors} />}
      {data?.truncated && <p className="mt-3 text-meta text-muted">Showing the first {data.records.length.toLocaleString()} of {data.total.toLocaleString()} cards.</p>}
    </>
  );
}
