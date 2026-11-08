import { cn } from "@/lib/cn";
import { Button } from "./button";

export interface TemporaryChangesBarProps {
  /** How many records show now, and how many there are: "Showing 3 of 12." */
  shown?: number;
  total?: number;
  /** Replaces the count sentence, for a draft that changes no count ("Sorted by Due date."). */
  summary?: string;
  /** The reminder after it. */
  note?: string;
  /** Whether there are unsaved changes to show. Keep the bar mounted and flip this, so the announcement works. */
  open?: boolean;
  onReset: () => void;
  /** Without it there is no Save as view button (a viewer who may not make views). */
  onSaveAsView?: () => void;
  saveLabel?: string;
  className?: string;
}

/**
 * The subtle strip under the filter bar while a view has unsaved changes (decision 4): "Showing 3 of 12. This
 * filter is only for now." with Reset (ghost) and Save as view (soft). The text is a polite live region that
 * stays in the page when the bar is closed, because a region that appears together with its text is often not
 * announced; it also reads out each new count (A11Y-4).
 */
export function TemporaryChangesBar({ shown, total, summary, note = "This filter is only for now.", open = true, onReset, onSaveAsView, saveLabel = "Save as view", className }: TemporaryChangesBarProps) {
  const count = summary ?? (shown !== undefined && total !== undefined ? `Showing ${shown} of ${total}.` : null);
  return (
    <div className={cn(open && "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-subtle px-3 py-1.5", className)}>
      <div role="status" aria-live="polite" aria-atomic="true" className={cn(open && "min-w-0 flex-1 py-1 text-label text-muted")}>
        {open && (
          <>
            {count && <span className="num font-medium text-fg">{count}</span>} {note}
          </>
        )}
      </div>
      {open && (
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onReset}>
            Reset
          </Button>
          {onSaveAsView && (
            <Button variant="soft" size="sm" onClick={onSaveAsView}>
              {saveLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
