/**
 * The menu of a card or row (right-click, or the keyboard's menu key): open it, select it, copy it,
 * move it to the start, delete it. When the record is part of a selection of several, copy and delete
 * act on all of them and say so.
 */
import { ArrowUpToLine, SquareCheck, CopyPlus, CornerDownRight, IndentDecrease, IndentIncrease, Maximize2, Trash2 } from "lucide-react";
import { AnchoredMenu, type MenuAnchor } from "@/components/ui/anchored-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";

export interface RecordMenuProps {
  anchor: MenuAnchor | null;
  onClose: () => void;
  /** Records Duplicate and Delete act on: the selection when the record is in it, else just this one. */
  count: number;
  canEdit: boolean;
  /** Whether this record is in the selection. */
  selected: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Only when the view's order can be changed by hand and the record is not first already. */
  onMoveToStart?: () => void;
  /** A list with sub-items: make the record a sub-item of the one above it, move it out a level, add a record under it. */
  onIndent?: () => void;
  onOutdent?: () => void;
  onAddSub?: () => void;
}

/** Where a menu opened by a right-click or the menu key hangs: at the pointer, or at the element for the key. */
export function menuAnchorOf(e: { clientX: number; clientY: number; currentTarget: Element }): MenuAnchor {
  if (e.clientX === 0 && e.clientY === 0) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: r.left + 12, y: r.top + 12, width: 1, height: 1 };
  }
  return { x: e.clientX, y: e.clientY, width: 1, height: 1 };
}

export function RecordMenu({ anchor, onClose, count, canEdit, selected, onOpen, onToggleSelect, onDuplicate, onDelete, onMoveToStart, onIndent, onOutdent, onAddSub }: RecordMenuProps) {
  const many = count > 1;
  return (
    <AnchoredMenu anchor={anchor} onClose={onClose} label="Record menu">
      <DropdownMenuItem onSelect={onOpen}>
        <Maximize2 aria-hidden className="size-4" /> Open record
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onToggleSelect}>
        <SquareCheck aria-hidden className="size-4" /> {selected ? "Deselect" : "Select"}
      </DropdownMenuItem>
      {canEdit && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onDuplicate}>
            <CopyPlus aria-hidden className="size-4" /> Duplicate {many ? `${count} records` : "record"}
          </DropdownMenuItem>
          {onMoveToStart && (
            <DropdownMenuItem onSelect={onMoveToStart}>
              <ArrowUpToLine aria-hidden className="size-4" /> Move to start
            </DropdownMenuItem>
          )}
          {(onIndent || onOutdent || onAddSub) && (
            <>
              <DropdownMenuSeparator />
              {onAddSub && (
                <DropdownMenuItem onSelect={onAddSub}>
                  <CornerDownRight aria-hidden className="size-4" /> Add sub-item
                </DropdownMenuItem>
              )}
              {onIndent && (
                <DropdownMenuItem onSelect={onIndent}>
                  <IndentIncrease aria-hidden className="size-4" /> Indent
                </DropdownMenuItem>
              )}
              {onOutdent && (
                <DropdownMenuItem onSelect={onOutdent}>
                  <IndentDecrease aria-hidden className="size-4" /> Outdent
                </DropdownMenuItem>
              )}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={onDelete}>
            <Trash2 aria-hidden className="size-4" /> Delete {many ? `${count} records` : "record"}
          </DropdownMenuItem>
        </>
      )}
    </AnchoredMenu>
  );
}
