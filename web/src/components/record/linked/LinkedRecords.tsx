/**
 * Linked records shown as more than their names, so "why is this linked?" can be answered without
 * leaving the record:
 *
 * - `LinkedRecordCards`: a link field's records as cards, each a `RecordSummary` (title, description,
 *   labels) drawn from the linked table's grid layout (the grid lays out every record: see gridRecordLayout).
 *   A click on a card edits the field; its details on hover open the record when the host offers that
 *   (the record panel, with a way back).
 * - `RecordPeek`: hovering a card or a picker row with a mouse shows the linked record's details beside
 *   it, read-only, with Open page; holding a finger on one shows them in a bottom sheet (PH-3).
 *
 * The records come from `POST /api/tables/{id}/records/get`, under the linked table's record keys,
 * so live changes to them refresh the cards.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { HoverCard } from "radix-ui";
import { ArrowUpRight } from "lucide-react";
import { recordKeys, recordsApi } from "@/api/records";
import type { BaseSchema, Field, LinkRef, Table, TableRecord } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ColorMark } from "@/components/ui/color-mark";
import { menuSurfaceClass } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { usePortalHost } from "@/components/ui/portal-host";
import { PropertyList, PropertyRow } from "@/components/ui/property-list";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { resolveFieldOrder } from "@/components/viewbar/config";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { displayText, type FormatCtx } from "@/lib/cells/format";
import { linkRefs } from "@/lib/cells/kinds";
import { hasCardValue } from "@/views/common/cardFields";
import { scrolledRecently, watchScrolling, whenScrollSettles } from "@/lib/scrollSettle";
import { gridRecordLayout } from "@/views/grid/useViewConfig";
import { CellValue } from "../CellValue";
import { useOptionalEditorEnv } from "../editors/env";
import { LinkChip } from "../editors/LinkEditor";
import { LinkedRecordList } from "./LinkedRecordList";

/** Fields a card shows under its title, at most. */
export const PREVIEW_FIELDS = 3;
/** Ids per `records/get` request (the server's cap). */
const GET_CHUNK = 100;
/** How long a finger rests on a card before its details open. */
const LONG_PRESS_MS = 450;

/**
 * What the host lets a linked record do. Provided by the record page around its properties: link fields
 * there are cards, and `open` goes to a linked record's page (from the Open of its details on hover, and
 * from its chips). Absent elsewhere (link fields are chips).
 */
export interface LinkedRecordsHost {
  open?: (tableId: string, recordId: string) => void;
  /** The address of a linked record's page, which its chips link to. */
  href?: (tableId: string, recordId: string) => string;
}
const LinkedRecordsContext = createContext<LinkedRecordsHost | null>(null);
export const LinkedRecordsProvider = LinkedRecordsContext.Provider;

/** Inside a record's summary: its link fields are values among others, small chips rather than cards. */
const CompactLinks = createContext(false);
export const CompactLinksProvider = CompactLinks.Provider;

/** Whether link fields here show as cards (the record panel's own fields, not a summary inside them). */
export function useLinkCards(): boolean {
  const compact = useContext(CompactLinks);
  return useContext(LinkedRecordsContext) !== null && !compact;
}

/** The table a link field points to, if the project is known here. */
export function linkedTableOf(schema: BaseSchema | undefined, field: Field): Table | undefined {
  if (field.type !== "link" || !schema) return undefined;
  return schema.tables.find((t) => t.id === field.options.linked_table_id);
}

/** A table's fields in its grid's order, without the hidden ones (the layout of every record of it). */
export function layoutFields(table: Table): Field[] {
  return resolveFieldOrder(table, gridRecordLayout(table) ?? { field_order: [], hidden_fields: [] }).visible;
}

/** The fields a linked record's card may show under its title: its grid's first ones, after the primary field. */
export function previewFields(table: Table): Field[] {
  return layoutFields(table).filter((f) => f.id !== table.primary_field_id);
}

/** Records of `tableId` by id, fetched together (and refreshed with the table's other record queries). */
export function useRecordsById(tableId: string | undefined, ids: readonly string[]): { records: ReadonlyMap<string, TableRecord>; loading: boolean } {
  const query = useQuery({
    queryKey: recordKeys.byIds(tableId ?? "", ids),
    queryFn: async ({ signal }) => {
      const out: TableRecord[] = [];
      for (let i = 0; i < ids.length; i += GET_CHUNK) out.push(...(await recordsApi.getMany(tableId!, ids.slice(i, i + GET_CHUNK), signal)).records);
      return out;
    },
    enabled: !!tableId && ids.length > 0,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
  const records = useMemo(() => new Map((query.data ?? []).map((r) => [r.id, r] as const)), [query.data]);
  return { records, loading: query.isPending && ids.length > 0 };
}

export function titleOf(table: Table, record: TableRecord | undefined, fallback: string, format: FormatCtx): string {
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const text = record && primary ? displayText(primary, record.values[primary.id], format) : fallback;
  return text || "Untitled record";
}

/** The button that goes from a peek to the record's own page: a link where the page has an address (so it can be opened in a new tab), else a button. */
function OpenPage({ onOpen, href }: { onOpen?: () => void; href?: string }) {
  if (!onOpen && !href) return null;
  const label = (
    <>
      Open page <Icon icon={ArrowUpRight} />
    </>
  );
  if (href) {
    return (
      <Button asChild variant="secondary" size="sm">
        <a
          href={href}
          onClick={
            onOpen
              ? (e) => {
                  // A plain click goes through the router; the other ways of using a link take the address.
                  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  onOpen();
                }
              : undefined
          }
        >
          {label}
        </a>
      </Button>
    );
  }
  return (
    <Button variant="secondary" size="sm" onClick={onOpen}>
      {label}
    </Button>
  );
}

/**
 * A linked record's details: its title and collection, then every filled property of its grid's layout as
 * a `PropertyList`, read-only. `showOpen` is false where the caller puts Open page elsewhere (the sheet's footer), and
 * `showTitle` where it has already put the title in a heading of its own (the sheet's).
 */
export function RecordPeekBody({
  table,
  record,
  format,
  emails,
  onOpen,
  href,
  showOpen = true,
  showTitle = true,
}: {
  table: Table;
  record: TableRecord | undefined;
  format: FormatCtx;
  emails?: ReadonlyMap<string, string>;
  onOpen?: () => void;
  href?: string;
  showOpen?: boolean;
  showTitle?: boolean;
}) {
  const fields = layoutFields(table).filter((f) => f.id !== table.primary_field_id);
  const filled = record ? fields.filter((f) => hasCardValue(f, record.values[f.id], format)) : [];
  const empty = fields.length - filled.length;
  return (
    // Links inside the preview are plain chips: a preview of a preview would never end.
    <InsidePeekProvider value>
      <LinkedRecordsProvider value={null}>
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              {showTitle && <p className="break-words text-ui font-semibold">{titleOf(table, record, "", format)}</p>}
              <p className={cn("flex items-center gap-1.5 text-meta text-muted", showTitle && "mt-0.5")}>
                <ColorMark hue={table.color} name={table.name} size={8} />
                <span className="truncate">{table.name}</span>
              </p>
            </div>
            {showOpen && <OpenPage onOpen={onOpen} href={href} />}
          </div>
          {!record ? (
            // Placeholders in the shape of the rows, not a spinner (the record is a moment away).
            <div aria-busy="true" className="flex flex-col gap-2 py-1">
              <span className="sr-only">Loading</span>
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : filled.length > 0 ? (
            <PropertyList>
              {filled.map((f) => (
                <PropertyRow key={f.id} label={f.name} className="items-start py-1.5">
                  <CellValue field={f} value={record.values[f.id]} format={format} emails={emails} className="line-clamp-6" />
                </PropertyRow>
              ))}
            </PropertyList>
          ) : (
            <p className="text-label text-muted">Nothing else is filled in.</p>
          )}
          {record && empty > 0 && filled.length > 0 && <p className="text-meta text-faint">{empty === 1 ? "1 empty property" : `${empty} empty properties`}</p>}
        </div>
      </LinkedRecordsProvider>
    </InsidePeekProvider>
  );
}

/** The preview's panel, beside what it previews: shared by `RecordPeek` and `FloatingRecordPeek`. */
function PeekContent({
  side,
  sideOffset,
  table,
  record,
  format,
  emails,
  onOpen,
  href,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: {
  side: "top" | "right" | "bottom" | "left";
  sideOffset: number;
  table: Table;
  record: TableRecord | undefined;
  format: FormatCtx;
  emails?: ReadonlyMap<string, string>;
  onOpen?: () => void;
  href?: string;
  onClose: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const host = usePortalHost();
  return (
    <HoverCard.Portal container={host.container}>
      <HoverCard.Content
        side={side}
        align="start"
        sideOffset={sideOffset}
        collisionPadding={12}
        data-record-peek=""
        onEscapeKeyDown={onClose}
        onPointerDownOutside={onClose}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        // Clicks inside stay inside: the property around the trigger must not start an edit.
        onClick={(e) => e.stopPropagation()}
        className={cn("ob-pop-in z-[70] max-h-[min(28rem,70dvh)] w-[min(26rem,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain", menuSurfaceClass, "p-3")}
      >
        <RecordPeekBody
          table={table}
          record={record}
          format={format}
          emails={emails}
          href={href}
          onOpen={
            onOpen
              ? () => {
                  onClose();
                  onOpen();
                }
              : undefined
          }
        />
      </HoverCard.Content>
    </HoverCard.Portal>
  );
}

export interface RecordPeekProps {
  table: Table;
  recordId: string;
  /** The record, when the caller has it already. */
  record?: TableRecord;
  format: FormatCtx;
  emails?: ReadonlyMap<string, string>;
  /** Opens the record's page (Open page in the details). */
  onOpen?: () => void;
  /** The address of the record's page, so Open page is a link that can be opened in a new tab. */
  href?: string;
  side?: "top" | "right" | "bottom" | "left";
  /** Whether holding a finger on it opens the details (off in the picker, where a held finger scrolls the list). */
  touchHold?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Shows a record's details beside `children`: after a moment's hover with a mouse (Radix HoverCard,
 * which leaves touch alone), or after holding a finger on it, which on a phone opens a bottom sheet (PH-3)
 * with Open page at its foot. A press that opened the details is not also a tap. A tap outside, Escape or
 * moving the mouse away closes them.
 */
export function RecordPeek({ table, recordId, record, format, emails, onOpen, href, side = "right", touchHold = true, className, children }: RecordPeekProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [open, setOpen] = useState(false);
  // How it was opened decides what it is: a held finger on a phone is a sheet, anything else the hover card.
  const [asSheet, setAsSheet] = useState(false);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const opened = useRef(false);
  const trigger = useRef<HTMLDivElement>(null);
  // Cards scrolling past a still pointer are not being pointed at: a preview asked for while a list
  // scrolls waits for it to stop, and opens then if the card is still pointed at (the mouse is on it,
  // or the keyboard's focus is in it).
  const pointedAt = useRef({ mouse: false, focus: false });
  const settle = useRef(() => {});
  useEffect(() => {
    watchScrolling();
    // Radix's HoverCard trigger cancels every touchstart it hears, and React hears touches as passive, so the
    // browser logs an error for each tap on a linked record. A touch is handled here (the long press below),
    // so it never reaches Radix's handler: it is stopped on its way up to React's root.
    const el = trigger.current;
    const stopTouch = (e: Event) => e.stopPropagation();
    el?.addEventListener("touchstart", stopTouch, { passive: true });
    return () => {
      el?.removeEventListener("touchstart", stopTouch);
      clearTimeout(press.current?.timer);
      settle.current();
    };
  }, []);
  useEffect(() => {
    // A sheet is not beside a card that can move away, so scrolling the page does not close it.
    if (!open || asSheet) return;
    // An open preview goes when the list under it scrolls (its card is moving away), not when it is
    // the preview itself being scrolled.
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Element && e.target.closest("[data-record-peek]"))) setOpen(false);
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [open, asSheet]);
  const onOpenChange = (next: boolean) => {
    settle.current();
    if (next && scrolledRecently()) {
      settle.current = whenScrollSettles(() => {
        if (pointedAt.current.mouse || pointedAt.current.focus) {
          setAsSheet(false);
          setOpen(true);
        }
      });
      return;
    }
    if (next) setAsSheet(false);
    setOpen(next);
  };
  const fetched = useQuery({ queryKey: recordKeys.record(table.id, recordId), queryFn: () => recordsApi.get(table.id, recordId), enabled: open && !record });
  const cancel = () => {
    clearTimeout(press.current?.timer);
    press.current = null;
  };
  return (
    <HoverCard.Root open={open && !asSheet} onOpenChange={onOpenChange} openDelay={400} closeDelay={150}>
      <HoverCard.Trigger asChild>
        <div
          ref={trigger}
          className={cn("select-none [-webkit-touch-callout:none]", className)}
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse") pointedAt.current.mouse = true;
          }}
          onPointerLeave={() => {
            pointedAt.current.mouse = false;
          }}
          onFocus={() => {
            pointedAt.current.focus = true;
          }}
          onBlur={() => {
            pointedAt.current.focus = false;
          }}
          onPointerDown={(e) => {
            opened.current = false;
            // A press on a button of the card (its grip, which drags it, or its remove button) is that button's own.
            if (e.pointerType === "mouse" || !touchHold || (e.target instanceof Element && e.target.closest("button, a"))) return;
            cancel();
            press.current = {
              x: e.clientX,
              y: e.clientY,
              timer: setTimeout(() => {
                opened.current = true;
                setAsSheet(!desktop);
                setOpen(true);
              }, LONG_PRESS_MS),
            };
          }}
          onPointerMove={(e) => {
            // A finger that moves is scrolling, not holding.
            if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8) cancel();
          }}
          onPointerUp={cancel}
          onPointerCancel={cancel}
          onContextMenu={(e) => {
            if (opened.current || press.current) e.preventDefault();
          }}
          onClickCapture={(e) => {
            if (!opened.current) return;
            opened.current = false;
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {children}
        </div>
      </HoverCard.Trigger>
      <PeekContent side={side} sideOffset={8} table={table} record={record ?? fetched.data} format={format} emails={emails} onOpen={onOpen} href={href} onClose={() => setOpen(false)} />
      {asSheet && (
        <Sheet
          open={open}
          onOpenChange={setOpen}
          title={titleOf(table, record ?? fetched.data, "", format)}
          doneLabel="Close"
          footer={
            onOpen || href ? (
              <Button
                variant="primary"
                onClick={() => {
                  setOpen(false);
                  onOpen?.();
                }}
              >
                Open page <Icon icon={ArrowUpRight} />
              </Button>
            ) : undefined
          }
        >
          <div data-record-peek="">
            <RecordPeekBody table={table} record={record ?? fetched.data} format={format} emails={emails} showOpen={false} showTitle={false} />
          </div>
        </Sheet>
      )}
    </HoverCard.Root>
  );
}

/**
 * A link field's records as cards (see the top of this file); chips when the linked table is not known
 * here. With `onChange` (an editable field) the cards can be reordered and removed in place.
 */
export function LinkedRecordCards({ field, value, format, emails, fallback, onChange }: { field: Field; value: unknown; format: FormatCtx; emails?: ReadonlyMap<string, string>; fallback: ReactNode; onChange?: (refs: LinkRef[]) => void }) {
  const env = useOptionalEditorEnv();
  const host = useContext(LinkedRecordsContext);
  const schema = env?.schema;
  const table = linkedTableOf(schema, field);
  const refs = useMemo(() => linkRefs(value), [value]);
  const ids = useMemo(() => refs.map((r) => r.id), [refs]);
  const { records } = useRecordsById(table?.id, ids);
  if (!table || !schema) return <>{fallback}</>;
  return (
    <LinkedRecordList
      fieldName={field.name}
      table={table}
      refs={refs.map((r) => ({ ...r, name: titleOf(table, records.get(r.id), r.name, format) }))}
      records={records}
      fields={previewFields(table)}
      format={format}
      emails={emails}
      onOpen={host?.open ? (id) => host.open!(table.id, id) : undefined}
      hrefOf={host?.href ? (id) => host.href!(table.id, id) : undefined}
      onChange={onChange && ((next) => onChange(next.map((r) => refs.find((x) => x.id === r.id) ?? r)))}
    />
  );
}

/**
 * A record's preview (as `RecordPeek` shows it) at a spot on screen rather than beside an element: a
 * linked record's chip in the grid, drawn on a canvas. It opens after a moment's hover over `at`,
 * stays while the pointer is on it, and closes a moment after the pointer is on neither.
 */
/** How long the pointer stays somewhere else before the floating preview follows it (or closes). */
const SWITCH_MS = 300;

export interface FloatingPeekTarget {
  /** Which chip this is (its cell and record): the preview moves to another chip, even of the same record. */
  key: string;
  table: Table;
  recordId: string;
  rect: { x: number; y: number; width: number; height: number };
  /** Opens the record (Open page in the preview). */
  open?: () => void;
  /** The address of the record's page, so Open page is a link. */
  href?: string;
}

/** `at` is what the pointer is over now; the preview keeps what it shows (its table too) until it moves on. */
export function FloatingRecordPeek({ at, format, emails }: { at: FloatingPeekTarget | null; format: FormatCtx; emails?: ReadonlyMap<string, string> }) {
  const [shown, setShown] = useState<typeof at>(null);
  const over = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settle = useRef(() => {});
  useEffect(() => {
    clearTimeout(timer.current);
    settle.current();
    if (over.current) return;
    if (at && shown && at.key === shown.key) return;
    // The pointer on its way to the preview crosses the cells under the chip: what it passes over only
    // takes the preview's place (or closes it) after a moment there, so it can get to the preview first.
    // Chips scrolling past a still pointer wait for the scrolling to stop.
    if (at) timer.current = setTimeout(() => (settle.current = whenScrollSettles(() => setShown(at))), shown ? SWITCH_MS : 400);
    else
      timer.current = setTimeout(() => {
        if (!over.current) setShown(null);
      }, SWITCH_MS);
    return () => {
      clearTimeout(timer.current);
      settle.current();
    };
    // `shown` is read, not followed: it only says whether to wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at?.key]);
  useEffect(() => {
    // A closed preview is not under the pointer (it may have closed from inside: Open, Escape).
    if (!shown) over.current = false;
  }, [shown]);
  useEffect(() => {
    watchScrolling();
    // The grid scrolling moves the chip away from under the pointer (and reports no move): the preview
    // goes, unless it is the preview itself being scrolled.
    const onScroll = () => {
      if (!over.current) setShown(null);
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, []);
  const fetched = useQuery({ queryKey: recordKeys.record(shown?.table.id ?? "", shown?.recordId ?? ""), queryFn: () => recordsApi.get(shown!.table.id, shown!.recordId), enabled: !!shown });
  if (!shown) return null;
  const { table, open, href } = shown;
  const r = shown.rect;
  return (
    // Open while `shown`: the timers above decide, not Radix's own (it would close as the pointer
    // passes between the chip and the preview). Escape or a press elsewhere closes it.
    <HoverCard.Root open>
      <HoverCard.Trigger asChild>
        <span aria-hidden className="pointer-events-none fixed" style={{ left: r.x, top: r.y, width: r.width, height: r.height }} />
      </HoverCard.Trigger>
      <PeekContent
        side="bottom"
        sideOffset={2}
        table={table}
        record={fetched.data}
        format={format}
        emails={emails}
        onOpen={open}
        href={href}
        onClose={() => setShown(null)}
        onPointerEnter={() => {
          over.current = true;
          clearTimeout(timer.current);
        }}
        onPointerLeave={() => {
          over.current = false;
          timer.current = setTimeout(() => setShown(null), SWITCH_MS);
        }}
      />
    </HoverCard.Root>
  );
}

/** Inside a record's preview: the links there do not open previews of their own (one would never end). */
const InsidePeek = createContext(false);
export const InsidePeekProvider = InsidePeek.Provider;

/** How many linked records a compact list shows before "+N more". */
export const LINK_CHIPS_SHOWN = 3;

/**
 * A link field's records as small chips (as in the grid's cells), the first few and then "+N more",
 * which shows them all ("Show less" folds them again). Hovering a chip shows the record's preview
 * where the project is known. Used wherever a link field is a value among others: inside a record's
 * card, on kanban and gallery cards, in lists.
 */
export function LinkChipList({ field, chips, format, emails, className }: { field: Field; chips: readonly { id?: string; text: string }[]; format: FormatCtx; emails?: ReadonlyMap<string, string>; className?: string }) {
  const [all, setAll] = useState(false);
  const env = useOptionalEditorEnv();
  const inside = useContext(InsidePeek);
  const host = useContext(LinkedRecordsContext);
  const linked = linkedTableOf(env?.schema, field);
  const table = inside ? undefined : linked;
  const shown = all ? chips : chips.slice(0, LINK_CHIPS_SHOWN);
  const more = chips.length - shown.length;
  const toggle = (e: React.MouseEvent) => {
    // Showing more is not an edit of the field around it, nor a way into the card it is on.
    e.stopPropagation();
    setAll((a) => !a);
  };
  return (
    <div className={cn("min-w-0 text-label", className)}>
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {shown.map((c, i) => {
          // Where the host can open a record (a record's page), its chips are links to the linked record's page.
          const chip = (
            <LinkChip
              key={c.id ?? `${c.text}-${i}`}
              name={c.text}
              hue={linked?.color}
              markName={linked?.name}
              href={linked && c.id && host?.href ? host.href(linked.id, c.id) : undefined}
              onOpen={linked && c.id && host?.open ? () => host.open!(linked.id, c.id!) : undefined}
            />
          );
          return table && env?.schema && c.id ? (
            <RecordPeek
              key={c.id}
              table={table}
              recordId={c.id}
              format={format}
              emails={emails}
              onOpen={host?.open ? () => host.open!(table.id, c.id!) : undefined}
              href={host?.href ? host.href(table.id, c.id) : undefined}
              side="bottom"
              className="min-w-0 max-w-full"
            >
              {chip}
            </RecordPeek>
          ) : (
            chip
          );
        })}
        {more > 0 && (
          <button type="button" onClick={toggle} className="inline-flex min-h-6 shrink-0 items-center rounded-xs px-1 text-meta text-muted hover:text-fg hover:underline max-md:min-h-control-touch">
            +{more} more
          </button>
        )}
        {all && chips.length > LINK_CHIPS_SHOWN && (
          <button type="button" onClick={toggle} className="inline-flex min-h-6 shrink-0 items-center rounded-xs px-1 text-meta text-muted hover:text-fg hover:underline max-md:min-h-control-touch">
            Show less
          </button>
        )}
      </span>
    </div>
  );
}
