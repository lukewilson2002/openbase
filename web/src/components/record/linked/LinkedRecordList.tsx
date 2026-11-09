/**
 * A link property's records as cards in their order, the same whether the property is being edited or not:
 * each a `RecordSummary` with every property on hover (`RecordPeek`). Given `onChange`, a card can be
 * dragged by its grip into another place (or moved with the keyboard on the grip: Space, the arrows,
 * Space) and removed with its x; the new list is reported at once.
 */
import type { ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent, type UniqueIdentifier } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X } from "lucide-react";
import type { Field, LinkRef, Table, TableRecord } from "@/api/types";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
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
  /** Opens a record's page (from Open page in its details). */
  onOpen?: (recordId: string) => void;
  /** The address of a record's page, so Open page is a link. */
  hrefOf?: (recordId: string) => string;
  /** The records reordered or one removed; without it the cards only show. */
  onChange?: (refs: LinkRef[]) => void;
  className?: string;
}

export function LinkedRecordList({ fieldName, table, refs, records, fields, format, emails, onOpen, hrefOf, onChange, className }: LinkedRecordListProps) {
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
        <LinkedCard
          key={r.id}
          refItem={r}
          table={table}
          record={records.get(r.id)}
          fields={fields}
          format={format}
          emails={emails}
          onOpen={onOpen ? () => onOpen(r.id) : undefined}
          href={hrefOf?.(r.id)}
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

function LinkedCard({
  refItem: r,
  table,
  record,
  fields,
  format,
  emails,
  onOpen,
  href,
  sortable,
  onRemove,
}: {
  refItem: LinkRef;
  table: Table;
  record: TableRecord | undefined;
  fields: readonly Field[];
  format: FormatCtx;
  emails?: ReadonlyMap<string, string>;
  onOpen?: () => void;
  href?: string;
  sortable: boolean;
  onRemove?: () => void;
}) {
  const s = useSortable({ id: r.id, disabled: !sortable });
  const title = r.name || "Untitled";
  const grip: ReactNode = sortable && (
    <IconButton label={`Move ${title}`} size="sm" noTooltip className="-ml-1 cursor-grab touch-none active:cursor-grabbing" {...s.attributes} {...s.listeners}>
      <Icon icon={GripVertical} />
    </IconButton>
  );
  return (
    <li ref={s.setNodeRef} style={{ transform: CSS.Translate.toString(s.transform), transition: s.transition }} className={cn("min-w-0", s.isDragging && "relative z-10")}>
      <RecordPeek table={table} recordId={r.id} record={record} format={format} emails={emails} onOpen={onOpen} href={href} side="left">
        <Card padded={false} data-linked-record={r.id} className={cn("flex min-w-0 items-start gap-1.5 py-1.5 pr-1.5 text-left", sortable ? "pl-1.5" : "pl-2.5", s.isDragging && "shadow-pop")}>
          {grip}
          <RecordSummary title={<span className="max-w-full truncate text-label font-semibold text-primary-text">{title}</span>} record={record} fields={fields} format={format} emails={emails} className="flex-1 self-center" />
          {onRemove && (
            <IconButton label={`Remove ${title}`} size="sm" noTooltip onClick={onRemove}>
              <Icon icon={X} />
            </IconButton>
          )}
        </Card>
      </RecordPeek>
    </li>
  );
}
