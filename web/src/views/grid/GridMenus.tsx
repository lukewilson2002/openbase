/** Context menus of the grid: column header, row, and summary bar. */
import { ArrowDownAZ, ArrowLeftToLine, ArrowRightToLine, ArrowUpZA, CopyPlus, Eye, EyeOff, Filter, Group, Maximize2, Pencil, Pin, PinOff, Rows3, Trash2, Type } from "lucide-react";
import type { Aggregation, Field, Table, ViewConfig } from "@/api/types";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { addFilterCondition, addSortLike, isGroupable, isSortable, setFrozenColumns, setHiddenField, sortOnly } from "@/components/viewbar/config";
import { AGGREGATION_LABELS, aggregationsFor } from "@/lib/cells/aggregations";
import { isFilterable } from "@/lib/cells/filters";
import { kindClassOf } from "@/lib/cells/kinds";
import type { GridColumnSpec, ScreenRect } from "./adapter";
import { AnchoredMenu } from "@/components/ui/anchored-menu";
import type { ViewConfigApi } from "./useViewConfig";

/** Labels for the two sort directions, by what the field holds. */
export function sortLabels(field: Field): [string, string] {
  switch (kindClassOf(field)) {
    case "number":
      return ["Sort 1 → 9", "Sort 9 → 1"];
    case "date":
      return ["Sort oldest → newest", "Sort newest → oldest"];
    case "bool":
      return ["Sort unchecked → checked", "Sort checked → unchecked"];
    default:
      return ["Sort A → Z", "Sort Z → A"];
  }
}

export interface ColumnMenuProps {
  index: number;
  at: ScreenRect | null;
  columns: readonly GridColumnSpec[];
  table: Table;
  config: ViewConfig;
  cfg: ViewConfigApi;
  canManageFields: boolean;
  canSort: boolean;
  onClose: () => void;
  onEditField: (field: Field, focus?: "name" | "type") => void;
  onInsert: (side: "left" | "right") => void;
  onDelete: (field: Field) => void;
}

export function ColumnMenu({ index, at, columns, table, config, cfg, canManageFields, canSort, onClose, onEditField, onInsert, onDelete }: ColumnMenuProps) {
  const spec = columns[index];
  const field = spec?.field;
  const [asc, desc] = field ? sortLabels(field) : ["", ""];
  const frozenHere = config.frozen_columns === index && index > 0;
  return (
    <AnchoredMenu anchor={at} onClose={onClose} label={field ? `Column menu for ${field.name}` : "Column menu"}>
      {field && spec && (
        <>
          <DropdownMenuLabel>{field.name}</DropdownMenuLabel>
          <DropdownMenuItem disabled={!canManageFields} onSelect={() => onEditField(field, "name")}>
            <Pencil aria-hidden className="size-4" /> Rename field
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canManageFields} onSelect={() => onEditField(field)}>
            <Pencil aria-hidden className="size-4" /> Edit field…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canManageFields} onSelect={() => onEditField(field, "type")}>
            <Type aria-hidden className="size-4" /> Change field type…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!canManageFields} onSelect={() => onInsert("left")}>
            <ArrowLeftToLine aria-hidden className="size-4" /> Insert field left
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canManageFields} onSelect={() => onInsert("right")}>
            <ArrowRightToLine aria-hidden className="size-4" /> Insert field right
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!canSort || !isSortable(field)} onSelect={() => cfg.update((c) => sortOnly(c, field.id, "asc"))}>
            <ArrowDownAZ aria-hidden className="size-4" /> {asc}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canSort || !isSortable(field)} onSelect={() => cfg.update((c) => sortOnly(c, field.id, "desc"))}>
            <ArrowUpZA aria-hidden className="size-4" /> {desc}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canSort || !isFilterable(field)} onSelect={() => cfg.update((c) => addFilterCondition(c, field))}>
            <Filter aria-hidden className="size-4" /> Filter by this field
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canSort || !isGroupable(field)} onSelect={() => cfg.update((c) => addSortLike(c, "groups", field.id))}>
            <Group aria-hidden className="size-4" /> Group by this field
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {index > 0 && (
            <DropdownMenuItem onSelect={() => cfg.update((c) => setFrozenColumns(c, frozenHere ? 0 : index))}>
              {frozenHere ? <PinOff aria-hidden className="size-4" /> : <Pin aria-hidden className="size-4" />}
              {frozenHere ? "Unfreeze columns" : "Freeze up to this column"}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={spec.isPrimary} onSelect={() => cfg.update((c) => setHiddenField(c, table, field.id, true))}>
            <EyeOff aria-hidden className="size-4" /> Hide field
          </DropdownMenuItem>
          <DropdownMenuItem danger disabled={!canManageFields || spec.isPrimary} onSelect={() => onDelete(field)}>
            <Trash2 aria-hidden className="size-4" /> Delete field
          </DropdownMenuItem>
        </>
      )}
    </AnchoredMenu>
  );
}

export interface RowMenuProps {
  at: ScreenRect | null;
  canEdit: boolean;
  count: number;
  canInsert: boolean;
  onClose: () => void;
  onExpand: () => void;
  onInsert: (where: "above" | "below") => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function RowMenu({ at, canEdit, count, canInsert, onClose, onExpand, onInsert, onDuplicate, onDelete }: RowMenuProps) {
  const many = count > 1;
  return (
    <AnchoredMenu anchor={at} onClose={onClose} label="Record menu">
      <DropdownMenuItem onSelect={onExpand}>
        <Maximize2 aria-hidden className="size-4" /> Expand record
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={!canEdit || !canInsert} onSelect={() => onInsert("above")}>
        <Rows3 aria-hidden className="size-4" /> Insert record above
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!canEdit || !canInsert} onSelect={() => onInsert("below")}>
        <Rows3 aria-hidden className="size-4" /> Insert record below
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!canEdit} onSelect={onDuplicate}>
        <CopyPlus aria-hidden className="size-4" /> Duplicate {many ? `${count} records` : "record"}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem danger disabled={!canEdit} onSelect={onDelete}>
        <Trash2 aria-hidden className="size-4" /> Delete {many ? `${count} records` : "record"}
      </DropdownMenuItem>
    </AnchoredMenu>
  );
}

export interface SummaryMenuProps {
  at: ScreenRect | null;
  field: Field | undefined;
  current: Aggregation;
  canConfigure: boolean;
  onClose: () => void;
  onPick: (agg: Aggregation) => void;
}

export function SummaryMenu({ at, field, current, canConfigure, onClose, onPick }: SummaryMenuProps) {
  const options = field ? aggregationsFor(field) : [];
  return (
    <AnchoredMenu anchor={at} onClose={onClose} label="Summary options" align="start">
      <DropdownMenuLabel>{field ? `Summarize ${field.name}` : "Summarize"}</DropdownMenuLabel>
      {!canConfigure && <p className="px-2 py-1 text-xs text-muted">You cannot change this view.</p>}
      <DropdownMenuRadioGroup value={current} onValueChange={(v) => canConfigure && onPick(v as Aggregation)}>
        {options.map((a) => (
          <DropdownMenuRadioItem key={a} value={a} disabled={!canConfigure}>
            {AGGREGATION_LABELS[a]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {options.length <= 1 && (
        <p className="flex items-center gap-1 px-2 py-1 text-xs text-muted">
          <Eye aria-hidden className="size-3" /> Nothing to summarize for this field type.
        </p>
      )}
    </AnchoredMenu>
  );
}
