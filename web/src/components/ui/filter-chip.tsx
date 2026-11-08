import type { ComponentProps, ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

export interface FilterChipProps extends Omit<ComponentProps<"span">, "onClick"> {
  /** The filter in words, e.g. "Status is Done". */
  children: ReactNode;
  /** Opens the filter for editing; without it the text is not interactive. */
  onEdit?: () => void;
  /** Takes the filter away. Without it the chip has no remove button. */
  onRemove?: () => void;
  /** Accessible name of the remove button; "Remove <text>" by default. */
  removeLabel?: string;
  /** The chip Backspace has picked: the next Backspace removes it. */
  selected?: boolean;
}

/** A filter that is on, inside the filter bar: accent-soft fill and line, with its own remove button. */
export function FilterChip({ children, onEdit, onRemove, removeLabel, selected, className, ...props }: FilterChipProps) {
  const text = typeof children === "string" ? children : "";
  return (
    <span
      data-selected={selected || undefined}
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 rounded-sm border border-primary-soft-line bg-primary-soft text-label font-medium text-primary-ink data-[selected]:border-primary data-[selected]:ring-1 data-[selected]:ring-primary",
        className,
      )}
      {...props}
    >
      {onEdit ? (
        <button type="button" onClick={onEdit} className="min-w-0 truncate rounded-sm py-0.5 pl-2 pr-1 text-left hover:underline">
          {children}
        </button>
      ) : (
        <span className="min-w-0 truncate py-0.5 pl-2 pr-1">{children}</span>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel ?? (text ? `Remove ${text}` : "Remove filter")}
          onClick={onRemove}
          // The visible target is small to keep the bar calm; the pseudo-element grows the tappable area.
          className="relative mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded-xs hover:bg-[color-mix(in_srgb,var(--primary)_16%,transparent)] after:absolute after:-inset-1 max-md:after:-inset-3"
        >
          <X aria-hidden className="size-3" strokeWidth={2} />
        </button>
      )}
    </span>
  );
}
