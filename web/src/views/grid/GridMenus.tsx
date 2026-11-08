/** Context menus of the grid: column header, row, and summary bar. */
import { useContext, type ReactNode } from "react";
import { ArrowDownAZ, ArrowLeft, ArrowLeftToLine, ArrowRight, ArrowRightToLine, ArrowUpZA, CopyPlus, Eye, EyeOff, FileText, Filter, Group, Heading1, Maximize2, Pencil, Pin, PinOff, Rows3, Trash2, Type } from "lucide-react";
import type { Aggregation, Field, Table, ViewConfig } from "@/api/types";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { addFilterCondition, addSortLike, isGroupable, isSortable, moveVisibleField, setFrozenColumns, setHiddenField, sortOnly } from "@/components/viewbar/config";
import { AGGREGATION_LABELS, aggregationsFor } from "@/lib/cells/aggregations";
import { isFilterable } from "@/lib/cells/filters";
import { kindClassOf } from "@/lib/cells/kinds";
import type { GridColumnSpec, ScreenRect } from "./adapter";
import { AnchoredMenu } from "@/components/ui/anchored-menu";
import { whyNotPage, whyNotTitle } from "@/components/fields/propertyRoles";
import { MenuGroups } from "@/shell/NavRowMenu";
import { MenuItem, SheetModeContext } from "@/shell/menuItems";
import { RecordActionMenu } from "../common/RecordActionMenu";
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
  /** Makes the property the collection's title or page (FLD-3, FLD-4). */
  onUseAsTitle: (field: Field) => void;
  onUseAsPage: (field: Field) => void;
  onInsert: (side: "left" | "right") => void;
  onDelete: (field: Field) => void;
}

export function ColumnMenu({ index, at, columns, table, config, cfg, canManageFields, canSort, onClose, onEditField, onUseAsTitle, onUseAsPage, onInsert, onDelete }: ColumnMenuProps) {
  const spec = columns[index];
  const field = spec?.field;
  const [asc, desc] = field ? sortLabels(field) : ["", ""];
  const frozenHere = config.frozen_columns === index && index > 0;
  const titleReason = field && (spec?.isPrimary ? "It is the title already" : whyNotTitle(field));
  const pageReason = field && (field.id === table.body_field_id ? "It is the page already" : whyNotPage(field, table));
  // The "Add field" header past the last column has no field: it has no menu either.
  if (!field || !spec) return null;
  return (
    <AnchoredMenu anchor={at} onClose={onClose} label={`Column menu for ${field.name}`}>
      <DropdownMenuLabel>{field.name}</DropdownMenuLabel>
      <DropdownMenuItem disabled={!canManageFields} onSelect={() => onEditField(field, "name")}>
        <Pencil aria-hidden className="size-4" /> Rename
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!canManageFields} onSelect={() => onEditField(field)}>
        <Pencil aria-hidden className="size-4" /> Edit property…
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!canManageFields} onSelect={() => onEditField(field, "type")}>
        <Type aria-hidden className="size-4" /> Change type…
      </DropdownMenuItem>
      <MenuItem icon={Heading1} disabled={!canManageFields || !!titleReason} reason={canManageFields ? titleReason : null} onSelect={() => onUseAsTitle(field)}>
        Use as title
      </MenuItem>
      {field.type === "rich_text" && (
        <MenuItem icon={FileText} disabled={!canManageFields || !!pageReason} reason={canManageFields ? pageReason : null} onSelect={() => onUseAsPage(field)}>
          Use as page
        </MenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={!canManageFields} onSelect={() => onInsert("left")}>
        <ArrowLeftToLine aria-hidden className="size-4" /> Insert left
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!canManageFields} onSelect={() => onInsert("right")}>
        <ArrowRightToLine aria-hidden className="size-4" /> Insert right
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={!canSort || !isSortable(field)} onSelect={() => cfg.update((c) => sortOnly(c, field.id, "asc"))}>
        <ArrowDownAZ aria-hidden className="size-4" /> {asc}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!canSort || !isSortable(field)} onSelect={() => cfg.update((c) => sortOnly(c, field.id, "desc"))}>
        <ArrowUpZA aria-hidden className="size-4" /> {desc}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!canSort || !isFilterable(field)} onSelect={() => cfg.update((c) => addFilterCondition(c, field))}>
        <Filter aria-hidden className="size-4" /> Filter by this property
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!canSort || !isGroupable(field)} onSelect={() => cfg.update((c) => addSortLike(c, "groups", field.id))}>
        <Group aria-hidden className="size-4" /> Group by this property
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={spec.isPrimary || index <= 1} onSelect={() => cfg.update((c) => moveVisibleField(c, table, field.id, -1))}>
        <ArrowLeft aria-hidden className="size-4" /> Move left
      </DropdownMenuItem>
      <DropdownMenuItem disabled={spec.isPrimary || index >= columns.length - 1} onSelect={() => cfg.update((c) => moveVisibleField(c, table, field.id, 1))}>
        <ArrowRight aria-hidden className="size-4" /> Move right
      </DropdownMenuItem>
      {index > 0 && (
        <DropdownMenuItem onSelect={() => cfg.update((c) => setFrozenColumns(c, frozenHere ? 0 : index))}>
          {frozenHere ? <PinOff aria-hidden className="size-4" /> : <Pin aria-hidden className="size-4" />}
          {frozenHere ? "Unfreeze columns" : "Freeze up to this column"}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem disabled={spec.isPrimary} onSelect={() => cfg.update((c) => setHiddenField(c, table, field.id, true))}>
        <EyeOff aria-hidden className="size-4" /> Hide
      </DropdownMenuItem>
      <DropdownMenuItem danger disabled={!canManageFields || spec.isPrimary} onSelect={() => onDelete(field)}>
        <Trash2 aria-hidden className="size-4" /> Delete
      </DropdownMenuItem>
    </AnchoredMenu>
  );
}

export interface RowMenuProps {
  at: ScreenRect | null;
  canEdit: boolean;
  count: number;
  canInsert: boolean;
  /** Why Insert is off (the view is sorted, grouped or searched), shown under the items. */
  insertNote?: string;
  onClose: () => void;
  onExpand: () => void;
  onInsert: (where: "above" | "below") => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function RowMenu({ at, canEdit, count, canInsert, insertNote, onClose, onExpand, onInsert, onDuplicate, onDelete }: RowMenuProps) {
  const many = count > 1;
  return (
    // A dropdown at the pointer on a desktop; on a phone the hold that opened it shows a sheet.
    <RecordActionMenu anchor={at} onClose={onClose} label="Record menu" title={many ? `${count} records` : "Record"}>
      <MenuGroups
        groups={[
          [
            <MenuItem key="expand" icon={Maximize2} onSelect={onExpand}>
              Expand record
            </MenuItem>,
          ],
          [
            <MenuItem key="above" icon={Rows3} disabled={!canEdit || !canInsert} onSelect={() => onInsert("above")}>
              Insert record above
            </MenuItem>,
            <MenuItem key="below" icon={Rows3} disabled={!canEdit || !canInsert} onSelect={() => onInsert("below")}>
              Insert record below
            </MenuItem>,
            canEdit && !canInsert && insertNote && <MenuNote key="note">{insertNote}</MenuNote>,
            <MenuItem key="dup" icon={CopyPlus} disabled={!canEdit} onSelect={onDuplicate}>
              Duplicate {many ? `${count} records` : "record"}
            </MenuItem>,
          ],
          [
            <MenuItem key="del" icon={Trash2} danger disabled={!canEdit} onSelect={onDelete}>
              Delete {many ? `${count} records` : "record"}
            </MenuItem>,
          ],
        ]}
      />
    </RecordActionMenu>
  );
}

/** A line of explanation among a menu's items: a paragraph in a dropdown, a list item in a sheet. */
function MenuNote({ children }: { children: ReactNode }) {
  return useContext(SheetModeContext) ? <li className="px-2.5 py-1 text-meta text-muted">{children}</li> : <p className="max-w-60 px-2 pb-1 text-meta text-muted">{children}</p>;
}

export interface SummaryMenuProps {
  at: ScreenRect | null;
  field: Field | undefined;
  current: Aggregation;
  onClose: () => void;
  onPick: (agg: Aggregation) => void;
}

export function SummaryMenu({ at, field, current, onClose, onPick }: SummaryMenuProps) {
  const options = field ? aggregationsFor(field) : [];
  return (
    <AnchoredMenu anchor={at} onClose={onClose} label="Summary options" align="start">
      <DropdownMenuLabel>{field ? `Summarize ${field.name}` : "Summarize"}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={current} onValueChange={(v) => onPick(v as Aggregation)}>
        {options.map((a) => (
          <DropdownMenuRadioItem key={a} value={a}>
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
