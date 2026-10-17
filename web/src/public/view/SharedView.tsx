/**
 * The body of a shared view: search, paging and the renderer for the view's type.
 *
 * Approach (documented in web/README.md): the signed-in views are wired to the signed-in API, so
 * the public page does not reuse them wholesale. It reuses what is presentational and pure
 * (cell display, card helpers, kanban stacking, the timeline chart, calendar date math) and puts
 * simple read-only layouts around it:
 *   - grid, list  -> a clean read-only table (grouped rows, click a header to sort, paging);
 *   - gallery     -> cards with the cover image;
 *   - kanban      -> read-only stacks;
 *   - calendar    -> a month grid (one query per month);
 *   - timeline    -> the timeline chart with every editing gesture off.
 * A board, calendar or timeline whose configured field is not visible in the share falls back to
 * the table and says so.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
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
import { PublicTable } from "./PublicTable";
import { PublicTimeline } from "./PublicTimeline";
import { ShareProvider } from "./ShareContext";
import { sharedFields } from "./publicFields";
import { PUBLIC_PAGE, usePublicAll, usePublicPage } from "./usePublicRecords";

export interface SharedViewProps {
  token: string;
  password: string | null;
  view: PublicView;
}

function Toolbar({ search, onSearch, summary, children }: { search: string; onSearch: (s: string) => void; summary: ReactNode; children?: ReactNode }) {
  return (
    <div role="toolbar" aria-label="Shared view toolbar" className="mb-3 flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-2 top-2 size-4 text-muted" />
        <Input type="search" aria-label="Search records" placeholder="Search records" value={search} onChange={(e) => onSearch(e.target.value)} className="h-8 w-56 pl-8" />
      </div>
      <span className="text-[0.8125rem] text-muted" aria-live="polite">
        {summary}
      </span>
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

const count = (n: number) => `${n.toLocaleString()} record${n === 1 ? "" : "s"}`;

function ErrorLine({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div role="alert" className="mb-3 flex items-center gap-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-[0.8125rem] text-danger">
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
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<Sort | null>(null);
  const transient = useMemo<TransientConfig | null>(() => (sort ? { sorts: [sort] } : null), [sort]);

  // A new search or sort starts at the first page.
  useEffect(() => setOffset(0), [search, sort]);

  const cfg = view.config;
  const type = view.type;
  const dates = useMemo(() => {
    if (type === "calendar") return resolveDateFields(fields.list, cfg.calendar_date_field_id, cfg.calendar_end_field_id);
    if (type === "timeline") return resolveDateFields(fields.list, cfg.timeline_start_field_id, cfg.timeline_end_field_id);
    return null;
  }, [type, fields.list, cfg.calendar_date_field_id, cfg.calendar_end_field_id, cfg.timeline_start_field_id, cfg.timeline_end_field_id]);
  const stackField = type === "kanban" ? fields.byId.get(cfg.kanban_stack_field_id ?? "") : undefined;

  const mode: "table" | "gallery" | "kanban" | "calendar" | "timeline" =
    type === "gallery" ? "gallery" : type === "kanban" && stackKind(stackField) ? "kanban" : type === "calendar" && dates ? "calendar" : type === "timeline" && dates ? "timeline" : "table";
  const fallback = mode === "table" && (type === "kanban" || type === "calendar" || type === "timeline");

  return (
    <ShareProvider value={{ token, password, format }}>
      {fallback && (
        <p className="mb-3 rounded-md bg-subtle px-3 py-2 text-[0.8125rem] text-muted">
          This {type} needs a field that is not shared, so its records are shown as a table.
        </p>
      )}
      {mode === "table" && <TableBody view={view} fields={fields} token={token} password={password} search={search} searchText={searchText} onSearch={setSearchText} offset={offset} onOffset={setOffset} sort={sort} onSort={setSort} transient={transient} timeZone={timeZone} />}
      {mode === "gallery" && <GalleryBody fields={fields} token={token} password={password} search={search} searchText={searchText} onSearch={setSearchText} coverId={cfg.gallery_cover_field_id} descriptionId={cfg.description_field_id} timeZone={timeZone} />}
      {mode === "kanban" && stackField && <KanbanBody fields={fields} token={token} password={password} search={search} searchText={searchText} onSearch={setSearchText} stackFieldId={stackField.id} hideEmpty={cfg.kanban_hide_empty_stacks} coverId={cfg.kanban_cover_field_id} descriptionId={cfg.description_field_id} timeZone={timeZone} />}
      {mode === "calendar" && dates && (
        <>
          <Toolbar search={searchText} onSearch={setSearchText} summary={null} />
          <PublicCalendar fields={fields} dates={dates} search={search} transient={null} />
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

function TableBody(p: BodyProps & { view: PublicView; offset: number; onOffset: (n: number) => void; sort: Sort | null; onSort: (s: Sort | null) => void; transient: TransientConfig | null }) {
  const page = usePublicPage({ token: p.token, password: p.password, fields: p.fields, search: p.search, timeZone: p.timeZone, offset: p.offset, transient: p.transient });
  const data = page.data;
  const total = data?.total ?? 0;
  const first = total === 0 ? 0 : p.offset + 1;
  const last = Math.min(p.offset + (data?.records.length ?? 0), total);
  return (
    <>
      <Toolbar search={p.searchText} onSearch={p.onSearch} summary={data ? (total === 0 ? (p.search ? "No records match your search." : "No records.") : `${first.toLocaleString()}–${last.toLocaleString()} of ${count(total)}`) : "Loading…"}>
        {page.fetching && <Spinner className="size-4" label="Loading records" />}
        {total > PUBLIC_PAGE && (
          <>
            <Button size="sm" disabled={p.offset === 0} onClick={() => p.onOffset(Math.max(0, p.offset - PUBLIC_PAGE))}>
              <ChevronLeft aria-hidden className="size-4" /> Previous
            </Button>
            <Button size="sm" disabled={p.offset + PUBLIC_PAGE >= total} onClick={() => p.onOffset(p.offset + PUBLIC_PAGE)}>
              Next <ChevronRight aria-hidden className="size-4" />
            </Button>
          </>
        )}
      </Toolbar>
      {page.error && !data && <ErrorLine error={page.error} onRetry={page.refetch} />}
      <PublicTable
        fields={p.fields.list}
        widths={p.view.config.field_widths}
        records={data?.records ?? []}
        offset={data?.offset ?? p.offset}
        groups={data?.groups ?? []}
        colors={data?.colors ?? {}}
        sort={p.sort}
        onSort={p.onSort}
        loading={page.loading}
      />
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
      {data?.truncated && <p className="mt-3 text-xs text-muted">Showing the first {data.records.length.toLocaleString()} of {data.total.toLocaleString()} records.</p>}
    </>
  );
}

function KanbanBody(p: BodyProps & { stackFieldId: string; hideEmpty: boolean; coverId: string | null | undefined; descriptionId: string | null | undefined }) {
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
      {data && <PublicKanban stackField={stackField} hideEmpty={p.hideEmpty} records={data.records} fields={card} colors={data.colors} />}
      {data?.truncated && <p className="mt-3 text-xs text-muted">Showing the first {data.records.length.toLocaleString()} of {data.total.toLocaleString()} cards.</p>}
    </>
  );
}
