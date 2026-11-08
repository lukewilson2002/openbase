/**
 * What a card, row or grid view shows while records are selected (COL-9): the count and the bulk actions.
 * On a desktop that is a bar floating at the bottom of the nearest positioned ancestor (the view's body):
 * Duplicate, Delete and a way to let go. On a phone the bar shrinks to the count, an Actions button and the
 * way to let go, and the actions are a bottom sheet (PH-3): rows of 44 px, not a row of small buttons. Render
 * it only while `count > 0`.
 */
import { useState, type ReactNode } from "react";
import { CopyPlus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { SheetMenu, SheetMenuGroup, SheetMenuRow } from "@/components/ui/sheet-menu";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { SheetModeContext } from "@/shell/menuItems";

export interface SelectionBarProps {
  count: number;
  onDuplicate: () => void;
  onDelete: () => void;
  onClear: () => void;
  /** Further actions of the view (the Board's Move to), in the bar between the count and Duplicate. */
  children?: ReactNode;
  /** The same further actions as rows of the phone's sheet (`SheetMenuRow`, or a `SheetMenuGroup` of them). */
  sheetActions?: ReactNode;
}

export function SelectionBar({ count, onDuplicate, onDelete, onClear, children, sheetActions }: SelectionBarProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [sheet, setSheet] = useState(false);
  const label = `${count.toLocaleString()} selected`;

  if (!desktop) {
    return (
      <div role="toolbar" aria-label="Selected records" className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3 max-md:bottom-16">
        <div className="ob-slide-in pointer-events-auto flex items-center gap-1 rounded-lg border border-line bg-surface p-1 shadow-pop">
          <span aria-live="polite" className="px-2 text-label font-medium">
            {label}
          </span>
          <Button variant="soft" onClick={() => setSheet(true)} aria-haspopup="dialog">
            Actions
          </Button>
          <IconButton label="Clear selection" onClick={onClear}>
            <X aria-hidden className="size-4" />
          </IconButton>
        </div>
        <SheetMenu open={sheet} onOpenChange={setSheet} title={label}>
          <SheetModeContext value>
            {sheetActions}
            <SheetMenuGroup>
              <SheetMenuRow icon={CopyPlus} onSelect={onDuplicate}>
                Duplicate
              </SheetMenuRow>
              <SheetMenuRow icon={Trash2} danger onSelect={onDelete}>
                Delete
              </SheetMenuRow>
            </SheetMenuGroup>
          </SheetModeContext>
        </SheetMenu>
      </div>
    );
  }

  return (
    <div role="toolbar" aria-label="Selected records" className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
      <div className="ob-slide-in pointer-events-auto flex items-center gap-1 rounded-lg border border-line bg-surface p-1 shadow-pop">
        <span aria-live="polite" className="px-2 text-label font-medium">
          {label}
        </span>
        {children}
        <Button variant="ghost" size="sm" onClick={onDuplicate}>
          <CopyPlus aria-hidden className="size-4" /> Duplicate
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} className="text-danger">
          <Trash2 aria-hidden className="size-4" /> Delete
        </Button>
        <IconButton label="Clear selection (Esc)" onClick={onClear}>
          <X aria-hidden className="size-4" />
        </IconButton>
      </div>
    </div>
  );
}
