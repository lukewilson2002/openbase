/** Editor for an ordered list of {field, direction} pairs: view sorts (up to 10) and groups (up to 3). */
import { useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, Plus, X } from "lucide-react";
import type { Direction, Field, Sort } from "@/api/types";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { InlineSelect } from "./InlineSelect";
import { kindClassOf } from "@/lib/cells/kinds";

export interface SortListEditorProps {
  /** Noun used in labels: "sort" or "group". */
  noun: "sort" | "group";
  items: readonly Sort[];
  fields: readonly Field[];
  max: number;
  readOnly?: boolean;
  onAdd: (fieldId: string) => void;
  onUpdate: (index: number, patch: Partial<Sort>) => void;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
}

function directionLabels(field: Field | undefined): [string, string] {
  switch (field ? kindClassOf(field) : "text") {
    case "number":
      return ["1 → 9", "9 → 1"];
    case "date":
      return ["oldest → newest", "newest → oldest"];
    case "bool":
      return ["unchecked → checked", "checked → unchecked"];
    default:
      return ["A → Z", "Z → A"];
  }
}

export function SortListEditor({ noun, items, fields, max, readOnly, onAdd, onUpdate, onRemove, onMove }: SortListEditorProps) {
  const [dragging, setDragging] = useState<number | null>(null);
  const byId = new Map(fields.map((f) => [f.id, f] as const));
  const used = new Set(items.map((s) => s.field_id));
  const free = fields.filter((f) => !used.has(f.id));

  return (
    <div>
      {items.length === 0 && <p className="mb-2 text-[0.8125rem] text-muted">{noun === "sort" ? "No sorts. Records appear in manual order." : "No grouping applied."}</p>}
      <ul className="flex flex-col gap-1.5">
        {items.map((s, i) => {
          const field = byId.get(s.field_id);
          const [asc, desc] = directionLabels(field);
          return (
            <li
              key={s.field_id}
              draggable={!readOnly}
              onDragStart={(e) => {
                setDragging(i);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(i));
              }}
              onDragOver={(e) => {
                if (dragging !== null) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging !== null && dragging !== i) onMove(dragging, i);
                setDragging(null);
              }}
              onDragEnd={() => setDragging(null)}
              className="flex items-center gap-1.5"
              aria-label={`${noun} ${i + 1}`}
            >
              <GripVertical aria-hidden className="size-4 shrink-0 cursor-grab text-faint" />
              <span className="w-14 shrink-0 text-[0.8125rem] text-muted">{i === 0 ? (noun === "sort" ? "Sort by" : "Group by") : "then by"}</span>
              <InlineSelect aria-label={`Field for ${noun} ${i + 1}`} width="w-40" disabled={readOnly} value={s.field_id} onChange={(e) => onUpdate(i, { field_id: e.target.value })}>
                {field ? null : <option value={s.field_id}>(deleted field)</option>}
                {[...(field ? [field] : []), ...free].map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </InlineSelect>
              <InlineSelect aria-label={`Direction for ${noun} ${i + 1}`} width="w-44" disabled={readOnly} value={s.direction} onChange={(e) => onUpdate(i, { direction: e.target.value as Direction })}>
                <option value="asc">{asc}</option>
                <option value="desc">{desc}</option>
              </InlineSelect>
              <IconButton label={`Move ${noun} ${i + 1} up`} size="sm" noTooltip disabled={readOnly || i === 0} onClick={() => onMove(i, i - 1)}>
                <ArrowUp aria-hidden className="size-4" />
              </IconButton>
              <IconButton label={`Move ${noun} ${i + 1} down`} size="sm" noTooltip disabled={readOnly || i === items.length - 1} onClick={() => onMove(i, i + 1)}>
                <ArrowDown aria-hidden className="size-4" />
              </IconButton>
              <IconButton label={`Remove ${noun} ${i + 1}`} size="sm" noTooltip disabled={readOnly} onClick={() => onRemove(i)}>
                <X aria-hidden className="size-4" />
              </IconButton>
            </li>
          );
        })}
      </ul>
      {!readOnly && (
        <Button size="sm" variant="ghost" className="mt-2" disabled={items.length >= max || free.length === 0} onClick={() => free[0] && onAdd(free[0].id)}>
          <Plus aria-hidden className="size-4" /> {noun === "sort" ? "Add sort" : "Add group level"}
        </Button>
      )}
      {items.length >= max && <p className="mt-1 text-xs text-muted">At most {max} {noun === "sort" ? "sorts" : "group levels"}.</p>}
    </div>
  );
}
