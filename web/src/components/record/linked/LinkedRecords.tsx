/**
 * Linked records shown as more than their names, so "why is this linked?" can be answered without
 * leaving the record:
 *
 * - `LinkedRecordCards`: a link field's records as cards, each a `RecordSummary` (title, description,
 *   labels) drawn from the linked table's grid layout (the grid lays out every record: see gridRecordLayout).
 *   A click on a card edits the field; its details on hover open the record when the host offers that
 *   (the record panel, with a way back).
 * - `RecordPeek`: hovering a card or a picker row with a mouse, or holding a finger on it, shows
 *   the linked record's full details beside it, read-only, with Open.
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
import { resolveFieldOrder } from "@/components/viewbar/config";
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
 * What the host lets a linked record do. Provided by the record panel around its fields: link fields
 * there are cards, and `open` shows a linked record in the panel (from the Open of its details on
 * hover). Absent elsewhere (link fields are chips).
 */
export interface LinkedRecordsHost {
  open?: (tableId: string, recordId: string) => void;
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
export function layoutFields(table: Table, role: string): Field[] {
  return resolveFieldOrder(table, gridRecordLayout(table, role) ?? { field_order: [], hidden_fields: [] }).visible;
}

/** The fields a linked record's card may show under its title: its grid's first ones, after the primary field. */
export function previewFields(table: Table, role: string): Field[] {
  return layoutFields(table, role).filter((f) => f.id !== table.primary_field_id);
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

/** Fields and values in two columns, as the record preview shows them. */
function FieldList({ fields, record, format, emails }: { fields: readonly Field[]; record: TableRecord; format: FormatCtx; emails?: ReadonlyMap<string, string> }) {
  return (
    <dl className="grid min-w-0 grid-cols-[minmax(4rem,auto)_minmax(0,1fr)] items-baseline gap-x-2.5 gap-y-1.5 text-[0.8125rem]">
      {fields.map((f) => (
        <div key={f.id} className="contents">
          <dt className="max-w-[9rem] truncate text-muted">{f.name}</dt>
          <dd className="min-w-0">
            <CellValue field={f} value={record.values[f.id]} format={format} emails={emails} className="line-clamp-6" />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A linked record's full details: every filled field of its grid's layout, read-only. */
export function RecordPeekBody({ table, record, format, emails, role, onOpen }: { table: Table; record: TableRecord | undefined; format: FormatCtx; emails?: ReadonlyMap<string, string>; role: string; onOpen?: () => void }) {
  const fields = layoutFields(table, role).filter((f) => f.id !== table.primary_field_id);
  const filled = record ? fields.filter((f) => hasCardValue(f, record.values[f.id], format)) : [];
  const empty = fields.length - filled.length;
  return (
    // Links inside the preview are plain chips: a preview of a preview would never end.
    <InsidePeekProvider value>
    <LinkedRecordsProvider value={null}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-words text-[0.875rem] font-semibold">{titleOf(table, record, "", format)}</p>
          <p className="text-xs text-faint">{table.name}</p>
        </div>
        {onOpen && (
          <button type="button" onClick={onOpen} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-line px-2 text-xs font-medium hover:bg-hover pointer-coarse:h-10">
            Open <ArrowUpRight aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      {!record ? (
        <p className="py-2 text-xs text-muted">Loading…</p>
      ) : filled.length > 0 ? (
        <FieldList fields={filled} record={record} format={format} emails={emails} />
      ) : (
        <p className="text-xs text-muted">Nothing else is filled in.</p>
      )}
      {record && empty > 0 && filled.length > 0 && <p className="text-xs text-faint">{empty === 1 ? "1 empty field" : `${empty} empty fields`}</p>}
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
  role,
  onOpen,
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
  role: string;
  onOpen?: () => void;
  onClose: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  return (
    <HoverCard.Portal>
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
        // Clicks inside stay inside: the field around the trigger must not start an edit.
        onClick={(e) => e.stopPropagation()}
        className="ob-fade-in z-[70] flex max-h-[min(28rem,70dvh)] w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2.5 overflow-y-auto rounded-lg border border-line bg-surface p-3 text-fg shadow-pop"
      >
        <RecordPeekBody
          table={table}
          record={record}
          format={format}
          emails={emails}
          role={role}
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
  role: string;
  onOpen?: () => void;
  side?: "top" | "right" | "bottom" | "left";
  /** Whether holding a finger on it opens the details (off where a held finger starts a drag). */
  touchHold?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Shows a record's details beside `children`: after a moment's hover with a mouse (Radix HoverCard,
 * which leaves touch alone), or after holding a finger on it. A press that opened the details is not
 * also a tap. A tap outside, Escape or moving the mouse away closes them.
 */
export function RecordPeek({ table, recordId, record, format, emails, role, onOpen, side = "right", touchHold = true, className, children }: RecordPeekProps) {
  const [open, setOpen] = useState(false);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const opened = useRef(false);
  // Cards scrolling past a still pointer are not being pointed at: a preview asked for while a list
  // scrolls waits for it to stop, and opens then if the card is still pointed at (the mouse is on it,
  // or the keyboard's focus is in it).
  const pointedAt = useRef({ mouse: false, focus: false });
  const settle = useRef(() => {});
  useEffect(() => {
    watchScrolling();
    return () => {
      clearTimeout(press.current?.timer);
      settle.current();
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    // An open preview goes when the list under it scrolls (its card is moving away), not when it is
    // the preview itself being scrolled.
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Element && e.target.closest("[data-record-peek]"))) setOpen(false);
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [open]);
  const onOpenChange = (next: boolean) => {
    settle.current();
    if (next && scrolledRecently()) {
      settle.current = whenScrollSettles(() => (pointedAt.current.mouse || pointedAt.current.focus) && setOpen(true));
      return;
    }
    setOpen(next);
  };
  const fetched = useQuery({ queryKey: recordKeys.record(table.id, recordId), queryFn: () => recordsApi.get(table.id, recordId), enabled: open && !record });
  const cancel = () => {
    clearTimeout(press.current?.timer);
    press.current = null;
  };
  return (
    <HoverCard.Root open={open} onOpenChange={onOpenChange} openDelay={400} closeDelay={150}>
      <HoverCard.Trigger asChild>
        <div
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
            if (e.pointerType === "mouse" || !touchHold) return;
            cancel();
            press.current = {
              x: e.clientX,
              y: e.clientY,
              timer: setTimeout(() => {
                opened.current = true;
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
      <PeekContent side={side} sideOffset={8} table={table} record={record ?? fetched.data} format={format} emails={emails} role={role} onOpen={onOpen} onClose={() => setOpen(false)} />
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
      fields={previewFields(table, schema.role)}
      format={format}
      emails={emails}
      role={schema.role}
      onOpen={host?.open ? (id) => host.open!(table.id, id) : undefined}
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
  /** Opens the record (Open in the preview). */
  open?: () => void;
}

/** `at` is what the pointer is over now; the preview keeps what it shows (its table too) until it moves on. */
export function FloatingRecordPeek({ at, format, emails, role }: { at: FloatingPeekTarget | null; format: FormatCtx; emails?: ReadonlyMap<string, string>; role: string }) {
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
  const { table, open } = shown;
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
        role={role}
        onOpen={open}
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
  const table = inside ? undefined : linkedTableOf(env?.schema, field);
  const shown = all ? chips : chips.slice(0, LINK_CHIPS_SHOWN);
  const more = chips.length - shown.length;
  const toggle = (e: React.MouseEvent) => {
    // Showing more is not an edit of the field around it, nor a way into the card it is on.
    e.stopPropagation();
    setAll((a) => !a);
  };
  return (
    <div className={cn("min-w-0 text-[0.8125rem]", className)}>
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {shown.map((c, i) => {
          const chip = <LinkChip key={c.id ?? `${c.text}-${i}`} name={c.text} />;
          return table && env?.schema && c.id ? (
            <RecordPeek key={c.id} table={table} recordId={c.id} format={format} emails={emails} role={env.schema.role} onOpen={host?.open ? () => host.open!(table.id, c.id!) : undefined} side="bottom" className="min-w-0 max-w-full">
              {chip}
            </RecordPeek>
          ) : (
            chip
          );
        })}
        {more > 0 && (
          <button type="button" onClick={toggle} className="shrink-0 text-xs text-muted hover:text-fg hover:underline">
            +{more} more
          </button>
        )}
        {all && chips.length > LINK_CHIPS_SHOWN && (
          <button type="button" onClick={toggle} className="shrink-0 text-xs text-muted hover:text-fg hover:underline">
            Show less
          </button>
        )}
      </span>
    </div>
  );
}
