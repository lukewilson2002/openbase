/**
 * Linked records shown as more than their names, so "why is this linked?" can be answered without
 * leaving the record:
 *
 * - `LinkedRecordCards`: a link field's records as cards, each with its title and the first few
 *   filled fields of the linked table's grid (the grid lays out every record: see gridRecordLayout).
 *   A card opens its record when the host offers that (the record panel, with a way back).
 * - `RecordPeek`: hovering a card or a picker row with a mouse, or holding a finger on it, shows
 *   the linked record's full details beside it, read-only, with Open.
 *
 * The records come from `POST /api/tables/{id}/records/get`, under the linked table's record keys,
 * so live changes to them refresh the cards.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { HoverCard } from "radix-ui";
import { ArrowUpRight } from "lucide-react";
import { recordKeys, recordsApi } from "@/api/records";
import type { BaseSchema, Field, Table, TableRecord } from "@/api/types";
import { resolveFieldOrder } from "@/components/viewbar/config";
import { cn } from "@/lib/cn";
import { displayText, type FormatCtx } from "@/lib/cells/format";
import { linkRefs } from "@/lib/cells/kinds";
import { fieldsToShow, hasCardValue } from "@/views/common/cardFields";
import { gridRecordLayout } from "@/views/grid/useViewConfig";
import { CellValue } from "../CellValue";
import { useOptionalEditorEnv } from "../editors/env";

/** Fields a card shows under its title, at most. */
export const PREVIEW_FIELDS = 3;
/** Ids per `records/get` request (the server's cap). */
const GET_CHUNK = 100;
/** How long a finger rests on a card before its details open. */
const LONG_PRESS_MS = 450;

/**
 * What the host lets a linked record do. Provided by the record panel around its fields: link fields
 * there are cards, and `open` shows a linked record in the panel. Absent elsewhere (link fields are chips).
 */
export interface LinkedRecordsHost {
  open?: (tableId: string, recordId: string) => void;
}
const LinkedRecordsContext = createContext<LinkedRecordsHost | null>(null);
export const LinkedRecordsProvider = LinkedRecordsContext.Provider;

/** Whether link fields here show as cards (inside the record panel's fields). */
export function useLinkCards(): boolean {
  return useContext(LinkedRecordsContext) !== null;
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

function titleOf(table: Table, record: TableRecord | undefined, fallback: string, format: FormatCtx): string {
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const text = record && primary ? displayText(primary, record.values[primary.id], format) : fallback;
  return text || "Untitled record";
}

/** Fields and values in two columns, as cards and the record preview show them. */
function FieldList({ fields, record, format, emails, dense }: { fields: readonly Field[]; record: TableRecord; format: FormatCtx; emails?: ReadonlyMap<string, string>; dense?: boolean }) {
  return (
    <dl className={cn("grid min-w-0 grid-cols-[minmax(4rem,auto)_minmax(0,1fr)] items-baseline gap-x-2.5", dense ? "gap-y-0.5 text-xs" : "gap-y-1.5 text-[0.8125rem]")}>
      {fields.map((f) => (
        <div key={f.id} className="contents">
          <dt className="max-w-[9rem] truncate text-muted">{f.name}</dt>
          <dd className="min-w-0">
            <CellValue field={f} value={record.values[f.id]} format={format} emails={emails} className={dense ? "truncate text-xs" : "line-clamp-6"} />
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
  className?: string;
  children: ReactNode;
}

/**
 * Shows a record's details beside `children`: after a moment's hover with a mouse (Radix HoverCard,
 * which leaves touch alone), or after holding a finger on it. A press that opened the details is not
 * also a tap. A tap outside, Escape or moving the mouse away closes them.
 */
export function RecordPeek({ table, recordId, record, format, emails, role, onOpen, side = "right", className, children }: RecordPeekProps) {
  const [open, setOpen] = useState(false);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const opened = useRef(false);
  useEffect(() => () => clearTimeout(press.current?.timer), []);
  const fetched = useQuery({ queryKey: recordKeys.record(table.id, recordId), queryFn: () => recordsApi.get(table.id, recordId), enabled: open && !record });
  const cancel = () => {
    clearTimeout(press.current?.timer);
    press.current = null;
  };
  return (
    <HoverCard.Root open={open} onOpenChange={setOpen} openDelay={400} closeDelay={150}>
      <HoverCard.Trigger asChild>
        <div
          className={cn("select-none [-webkit-touch-callout:none]", className)}
          onPointerDown={(e) => {
            opened.current = false;
            if (e.pointerType === "mouse") return;
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
      <HoverCard.Portal>
        <HoverCard.Content
          side={side}
          align="start"
          sideOffset={8}
          collisionPadding={12}
          data-record-peek=""
          onPointerDownOutside={() => setOpen(false)}
          // Clicks inside stay inside: the field around the trigger must not start an edit.
          onClick={(e) => e.stopPropagation()}
          className="ob-fade-in z-[70] flex max-h-[min(28rem,70dvh)] w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2.5 overflow-y-auto rounded-lg border border-line bg-surface p-3 text-fg shadow-pop"
        >
          <RecordPeekBody
            table={table}
            record={record ?? fetched.data}
            format={format}
            emails={emails}
            role={role}
            onOpen={
              onOpen
                ? () => {
                    setOpen(false);
                    onOpen();
                  }
                : undefined
            }
          />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

/** One linked record as a card: its title and its first few filled fields. */
function LinkedCard({ table, id, name, record, fields, format, emails, role, onOpen }: { table: Table; id: string; name: string; record: TableRecord | undefined; fields: readonly Field[]; format: FormatCtx; emails?: ReadonlyMap<string, string>; role: string; onOpen?: () => void }) {
  const shown = record ? fieldsToShow(fields, record, format, PREVIEW_FIELDS) : [];
  const title = titleOf(table, record, name, format);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (onOpen && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
      e.preventDefault();
      onOpen();
    }
  };
  return (
    <RecordPeek table={table} recordId={id} record={record} format={format} emails={emails} role={role} onOpen={onOpen} side="left">
      <div
        // A card is the way to its record; links and files inside it still do their own thing.
        role={onOpen ? "button" : undefined}
        tabIndex={onOpen ? 0 : undefined}
        aria-label={onOpen ? `Open ${title}` : undefined}
        data-linked-record={id}
        onClick={onOpen}
        onKeyDown={onKeyDown}
        className={cn("flex min-w-0 flex-col gap-1 rounded-md border border-line bg-surface px-2.5 py-1.5 text-left", onOpen && "cursor-pointer hover:border-line-strong hover:bg-hover focus-visible:border-ring focus-visible:outline-none")}
      >
        <span className="truncate text-[0.8125rem] font-medium text-primary">{title}</span>
        {shown.length > 0 && record && <FieldList fields={shown} record={record} format={format} emails={emails} dense />}
      </div>
    </RecordPeek>
  );
}

/** A link field's records as cards (see the top of this file); chips when the linked table is not known here. */
export function LinkedRecordCards({ field, value, format, emails, fallback }: { field: Field; value: unknown; format: FormatCtx; emails?: ReadonlyMap<string, string>; fallback: ReactNode }) {
  const env = useOptionalEditorEnv();
  const host = useContext(LinkedRecordsContext);
  const schema = env?.schema;
  const table = linkedTableOf(schema, field);
  const refs = useMemo(() => linkRefs(value), [value]);
  const ids = useMemo(() => refs.map((r) => r.id), [refs]);
  const { records } = useRecordsById(table?.id, ids);
  if (!table || !schema) return <>{fallback}</>;
  const role = schema.role;
  const fields = previewFields(table, role);
  return (
    <ul aria-label={`Linked records in ${field.name}`} className="flex min-w-0 flex-col gap-1.5">
      {refs.map((r) => (
        <li key={r.id} className="min-w-0">
          <LinkedCard table={table} id={r.id} name={r.name} record={records.get(r.id)} fields={fields} format={format} emails={emails} role={role} onOpen={host?.open ? () => host.open!(table.id, r.id) : undefined} />
        </li>
      ))}
    </ul>
  );
}
