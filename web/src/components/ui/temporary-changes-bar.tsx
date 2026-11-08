import { cn } from "@/lib/cn";
import { Button } from "./button";

export interface TemporaryChangesBarProps {
  /** How many records show now, and how many there are: "Showing 3 of 12." */
  shown?: number;
  total?: number;
  /** What the records are called, after the count: "Showing 3 of 12 clients." (the collection's record name, plural). */
  noun?: string;
  /** Replaces the count sentence, for a draft that changes no count ("Sorted by Due date."). */
  summary?: string;
  /** The reminder after it. */
  note?: string;
  /** One more sentence, for something to look at before saving: "This view changed since you started." */
  alert?: string;
  /** Whether there are unsaved changes to show. Keep the bar mounted and flip this, so the announcement works. */
  open?: boolean;
  onReset: () => void;
  /** Without it there is no Update view button (a person who may not change the view). */
  onUpdateView?: () => void;
  updateLabel?: string;
  /** Update view is on its way to the server. */
  updating?: boolean;
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
export function TemporaryChangesBar({
  shown,
  total,
  noun,
  summary,
  note = "This filter is only for now.",
  alert,
  open = true,
  onReset,
  onUpdateView,
  updateLabel = "Update view",
  updating = false,
  onSaveAsView,
  saveLabel = "Save as view",
  className,
}: TemporaryChangesBarProps) {
  const count = summary ?? (shown !== undefined && total !== undefined ? `Showing ${shown} of ${total}${noun ? ` ${noun}` : ""}.` : null);
  return (
    <div className={cn(open && "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-subtle px-3 py-1.5", className)}>
      {/* The 14rem basis is what makes the buttons wrap under the sentence on a phone instead of squeezing it. */}
      <div role="status" aria-live="polite" aria-atomic="true" className={cn(open && "min-w-0 flex-[1_1_14rem] py-1 text-label text-muted")}>
        {open && (
          <>
            {count && <span className="num font-medium text-fg">{count}</span>} {note}
            {alert && <> {alert}</>}
          </>
        )}
      </div>
      {open && (
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onReset}>
            Reset
          </Button>
          {onUpdateView && (
            <Button variant="secondary" size="sm" onClick={onUpdateView} loading={updating}>
              {updateLabel}
            </Button>
          )}
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
