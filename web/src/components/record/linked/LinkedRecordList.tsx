/**
 * A link field's records as cards in their order, the same whether the field is being edited or not:
 * each a `RecordSummary` with every field on hover (`RecordPeek`). Given `onChange`, a card can be
 * dragged by its grip into another place (or moved with the keyboard on the grip: Space, the arrows,
 * Space) and removed with its ✕; the new list is reported at once.
 */
import type { ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent, type UniqueIdentifier } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X } from "lucide-react";
import type { Field, LinkRef, Table, TableRecord } from "@/api/types";
import { cn } from "@/lib/cn";
import type { FormatCtx } from "@/lib/cells/format";
import { RecordSummary } from "../RecordSummary";
import { RecordPeek } from "./LinkedRecords";

export interface LinkedRecordListProps {
  /** The field's name, for the list's label ("Linked records in Blocks"). */
  fieldName: string;
  table: Table;
  refs: readonly LinkRef[];
  records: ReadonlyMap<string, TableRecord>;
  /** The fields a card's summary is drawn from (the linked table's layout, without its title). */
  fields: readonly Field[];
  format: FormatCtx;
  emails?: ReadonlyMap<string, string>;
  role: string;
  /** Opens a record (from its details on hover). */
  onOpen?: (recordId: string) => void;
  /** The records reordered or one removed; without it the cards only show. */
  onChange?: (refs: LinkRef[]) => void;
  className?: string;
}

export function LinkedRecordList({ fieldName, table, refs, records, fields, format, emails, role, onOpen, onChange, className }: LinkedRecordListProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  // Said by screen readers as a card is moved: its name and place, not its id.
  const nameOf = (id: UniqueIdentifier) => refs.find((r) => r.id === id)?.name || "Untitled";
  const placeOf = (id: UniqueIdentifier | undefined) => `${refs.findIndex((r) => r.id === id) + 1} of ${refs.length}`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}, ${placeOf(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${nameOf(active.id)} moved to ${placeOf(over.id)}.` : `${nameOf(active.id)} is not over the list.`),
    onDragEnd: ({ active, over }) => (over ? `${nameOf(active.id)} dropped at ${placeOf(over.id)}.` : `${nameOf(active.id)} put back.`),
    onDragCancel: ({ active }) => `Moving ${nameOf(active.id)} cancelled.`,
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!onChange || !over || active.id === over.id) return;
    const from = refs.findIndex((r) => r.id === active.id);
    const to = refs.findIndex((r) => r.id === over.id);
    if (from >= 0 && to >= 0) onChange(arrayMove([...refs], from, to));
  };
  const list = (
    <ul aria-label={`Linked records in ${fieldName}`} className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {refs.map((r) => (
        <Card
          key={r.id}
          refItem={r}
          table={table}
          record={records.get(r.id)}
          fields={fields}
          format={format}
          emails={emails}
          role={role}
          onOpen={onOpen ? () => onOpen(r.id) : undefined}
          sortable={!!onChange && refs.length > 1}
          onRemove={onChange ? () => onChange(refs.filter((x) => x.id !== r.id)) : undefined}
        />
      ))}
    </ul>
  );
  if (!onChange) return list;
  // Always inside the drag context while editable, so the list is not rebuilt as cards come and go.
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ announcements }}>
      <SortableContext items={refs.map((r) => r.id)} strategy={verticalListSortingStrategy}>
        {list}
      </SortableContext>
    </DndContext>
  );
}

function Card({
  refItem: r,
  table,
  record,
  fields,
  format,
  emails,
  role,
  onOpen,
  sortable,
  onRemove,
}: {
  refItem: LinkRef;
  table: Table;
  record: TableRecord | undefined;
  fields: readonly Field[];
  format: FormatCtx;
  emails?: ReadonlyMap<string, string>;
  role: string;
  onOpen?: () => void;
  sortable: boolean;
  onRemove?: () => void;
}) {
  const s = useSortable({ id: r.id, disabled: !sortable });
  const title = r.name || "Untitled";
  const grip: ReactNode = sortable && (
    <button
      type="button"
      aria-label={`Move ${title}`}
      {...s.attributes}
      {...s.listeners}
      className="-ml-1 mt-px inline-flex h-5 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded text-faint hover:text-fg active:cursor-grabbing pointer-coarse:h-9 pointer-coarse:w-6"
    >
      <GripVertical aria-hidden className="size-3.5" />
    </button>
  );
  return (
    <li ref={s.setNodeRef} style={{ transform: CSS.Translate.toString(s.transform), transition: s.transition }} className={cn("min-w-0", s.isDragging && "relative z-10")}>
      <RecordPeek table={table} recordId={r.id} record={record} format={format} emails={emails} role={role} onOpen={onOpen} side="left" touchHold={!sortable}>
        <div data-linked-record={r.id} className={cn("flex min-w-0 items-start gap-1.5 rounded-md border border-line bg-surface py-1.5 pr-1.5 text-left", sortable ? "pl-1.5" : "pl-2.5", s.isDragging && "shadow-pop")}>
          {grip}
          <RecordSummary title={<span className="max-w-full truncate text-[0.8125rem] font-medium text-primary-text">{title}</span>} record={record} fields={fields} format={format} emails={emails} className="flex-1" />
          {onRemove && (
            <button type="button" aria-label={`Remove ${title}`} onClick={onRemove} className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg pointer-coarse:size-9">
              <X aria-hidden className="size-3.5" />
            </button>
          )}
        </div>
      </RecordPeek>
    </li>
  );
}
