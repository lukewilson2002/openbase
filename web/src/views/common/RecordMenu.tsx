/**
 * The menu of a card or row (right-click, the keyboard's menu key, or a hold on a touch screen, where it is
 * a sheet): open it, select it, copy it, move it to the start, delete it. When the record is part of a
 * selection of several, copy and delete act on all of them and say so.
 */
import { ArrowUpToLine, SquareCheck, CopyPlus, CornerDownRight, IndentDecrease, IndentIncrease, Maximize2, Trash2 } from "lucide-react";
import type { MenuAnchor } from "@/components/ui/anchored-menu";
import { MenuGroups } from "@/shell/NavRowMenu";
import { MenuItem } from "@/shell/menuItems";
import { RecordActionMenu } from "./RecordActionMenu";

export interface RecordMenuProps {
  anchor: MenuAnchor | null;
  onClose: () => void;
  /** The record's name: the title of the sheet on a phone. */
  title?: string;
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

export function RecordMenu({ anchor, onClose, title = "Record", count, canEdit, selected, onOpen, onToggleSelect, onDuplicate, onDelete, onMoveToStart, onIndent, onOutdent, onAddSub }: RecordMenuProps) {
  const many = count > 1;
  const nest = onIndent || onOutdent || onAddSub;
  return (
    <RecordActionMenu anchor={anchor} onClose={onClose} label="Record menu" title={title}>
      <MenuGroups
        groups={[
          [
            <MenuItem key="open" icon={Maximize2} onSelect={onOpen}>
              Open record
            </MenuItem>,
            <MenuItem key="select" icon={SquareCheck} onSelect={onToggleSelect}>
              {selected ? "Deselect" : "Select"}
            </MenuItem>,
          ],
          canEdit
            ? [
                <MenuItem key="dup" icon={CopyPlus} onSelect={onDuplicate}>
                  Duplicate {many ? `${count} records` : "record"}
                </MenuItem>,
                onMoveToStart && (
                  <MenuItem key="start" icon={ArrowUpToLine} onSelect={onMoveToStart}>
                    Move to start
                  </MenuItem>
                ),
              ]
            : [],
          canEdit && nest
            ? [
                onAddSub && (
                  <MenuItem key="sub" icon={CornerDownRight} onSelect={onAddSub}>
                    Add sub-item
                  </MenuItem>
                ),
                onIndent && (
                  <MenuItem key="in" icon={IndentIncrease} onSelect={onIndent}>
                    Indent
                  </MenuItem>
                ),
                onOutdent && (
                  <MenuItem key="out" icon={IndentDecrease} onSelect={onOutdent}>
                    Outdent
                  </MenuItem>
                ),
              ]
            : [],
          canEdit
            ? [
                <MenuItem key="del" icon={Trash2} danger onSelect={onDelete}>
                  Delete {many ? `${count} records` : "record"}
                </MenuItem>,
              ]
            : [],
        ]}
      />
    </RecordActionMenu>
  );
}
