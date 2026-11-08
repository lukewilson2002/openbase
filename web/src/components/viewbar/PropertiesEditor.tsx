/**
 * The Properties screen of View options: which properties the view shows and in what order, each
 * with a switch, a drag handle (or Space and the arrow keys) and Move up and down for a touch screen.
 * The description property and a card layout's own property settings follow, in `children`.
 */
import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type Modifier } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Table, ViewConfig } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/checkbox";
import { FieldTypeIcon } from "@/components/ui/field-type-icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { moveField, resolveFieldOrder, setAllHidden, setHiddenField } from "./config";

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

export interface PropertiesEditorProps {
  table: Table;
  config: ViewConfig;
  update: (mutate: (c: ViewConfig) => ViewConfig) => void;
  /** Settings that belong with the properties (the description property, how many a card shows). */
  children?: ReactNode;
}

export function PropertiesEditor({ table, config, update, children }: PropertiesEditorProps) {
  const [q, setQ] = useState("");
  const { all } = resolveFieldOrder(table, config);
  const hidden = new Set(config.hidden_fields);
  const search = q.trim().toLowerCase();
  const shown = all.filter((f) => f.name.toLowerCase().includes(search));
  // Moving within a filtered list would be a guess about the properties in between.
  const reorderable = search === "" && all.length > 2;
  const move = (fromId: string, toId: string) => update((c) => moveField(c, table, fromId, toId));
  // Properties are put in order by their handles only, so a swipe elsewhere still scrolls the list.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onSortEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) move(String(e.active.id), String(e.over.id));
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Input aria-label="Find a property" placeholder="Find a property" value={q} onChange={(e) => setQ(e.target.value)} className="mb-2 h-control-md max-md:h-control-touch" />
        <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]} onDragEnd={onSortEnd}>
          {/* The title property stays first: it is not one of the items that can be moved. */}
          <SortableContext items={all.filter((f) => f.id !== table.primary_field_id).map((f) => f.id)} strategy={verticalListSortingStrategy}>
            <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
              {shown.map((f) => {
                const primary = f.id === table.primary_field_id;
                const at = all.indexOf(f);
                return (
                  <PropertyRow
                    key={f.id}
                    field={f}
                    primary={primary}
                    shown={primary || !hidden.has(f.id)}
                    reorderable={reorderable}
                    canUp={at > 1}
                    canDown={at < all.length - 1}
                    onToggle={(on) => update((c) => setHiddenField(c, table, f.id, !on))}
                    onUp={() => move(f.id, all[at - 1]!.id)}
                    onDown={() => move(f.id, all[at + 1]!.id)}
                  />
                );
              })}
              {shown.length === 0 && <li className="px-1 py-2 text-label text-muted">No matching properties.</li>}
            </ul>
          </SortableContext>
        </DndContext>
        <div className="mt-2 flex gap-2 border-t border-line pt-2">
          <Button size="sm" variant="secondary" onClick={() => update((c) => setAllHidden(c, table, true))}>
            Hide all
          </Button>
          <Button size="sm" variant="secondary" onClick={() => update((c) => setAllHidden(c, table, false))}>
            Show all
          </Button>
        </div>
      </div>
      {children}
    </div>
  );
}

/** One property: its handle, the switch, and Move up and down. */
function PropertyRow({
  field,
  primary,
  shown,
  reorderable,
  canUp,
  canDown,
  onToggle,
  onUp,
  onDown,
}: {
  field: Table["fields"][number];
  primary: boolean;
  shown: boolean;
  reorderable: boolean;
  canUp: boolean;
  canDown: boolean;
  onToggle: (on: boolean) => void;
  onUp: () => void;
  onDown: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id, disabled: primary || !reorderable });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn("flex items-center gap-1 rounded-md bg-surface px-1 py-1 hover:bg-hover", isDragging && "relative z-10 shadow-pop")}>
      {reorderable &&
        (primary ? (
          <span aria-hidden className="inline-block h-6 w-5 shrink-0" />
        ) : (
          <button
            type="button"
            aria-label={`Drag ${field.name} to reorder`}
            className="inline-flex h-6 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-xs text-faint hover:text-fg active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical aria-hidden className="size-4" />
          </button>
        ))}
      <FieldTypeIcon type={field.type} />
      <Switch className="min-w-0 flex-1 flex-row-reverse justify-between" label={<span className="truncate">{field.name}</span>} checked={shown} disabled={primary} onCheckedChange={onToggle} />
      {reorderable && (
        <>
          <IconButton label={`Move ${field.name} up`} size="sm" noTooltip disabled={primary || !canUp} onClick={onUp} className={primary ? "invisible" : undefined}>
            <ArrowUp aria-hidden className="size-4" />
          </IconButton>
          <IconButton label={`Move ${field.name} down`} size="sm" noTooltip disabled={primary || !canDown} onClick={onDown} className={primary ? "invisible" : undefined}>
            <ArrowDown aria-hidden className="size-4" />
          </IconButton>
        </>
      )}
    </li>
  );
}
