/**
 * The bar a card or row view shows while records are selected: the count, Duplicate, Delete and a
 * way to let go. It floats at the bottom of the nearest positioned ancestor (the view's body), above
 * the cards; render it only while `count > 0`.
 */
import { CopyPlus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";

export interface SelectionBarProps {
  count: number;
  onDuplicate: () => void;
  onDelete: () => void;
  onClear: () => void;
}

export function SelectionBar({ count, onDuplicate, onDelete, onClear }: SelectionBarProps) {
  return (
    <div role="toolbar" aria-label="Selected records" className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3 max-md:bottom-16">
      <div className="ob-slide-in pointer-events-auto flex items-center gap-1 rounded-lg border border-line bg-surface p-1 shadow-pop">
        <span aria-live="polite" className="px-2 text-[0.8125rem] font-medium">
          {count.toLocaleString()} selected
        </span>
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
