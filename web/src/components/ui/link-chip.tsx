import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { ColorMark } from "./color-mark";
import { Icon } from "./icon";

export interface LinkChipProps {
  /** The linked record's name. */
  name: string;
  /** The linked collection's palette colour, drawn as an 8 px mark. `null` takes the colour its name hashes to; leave it out for no mark. */
  hue?: string | null;
  /** The collection's name, which the mark's fallback colour is hashed from. */
  markName?: string;
  /** Opens the linked record in place (a button). */
  onOpen?: () => void;
  /**
   * Opens the linked record as a link (the record's own URL), so it can be opened in a new tab or copied. With
   * `onOpen` too, a plain click runs `onOpen` (the router navigates) and the other ways of using a link
   * (middle click, copy address) take the address.
   */
  href?: string;
  /** Unlinks it; adds a remove button. */
  onRemove?: () => void;
  className?: string;
}

/** A linked record as a small chip: the collection's mark, then the record's name. Opens that record when it can. */
export function LinkChip({ name, hue, markName, onOpen, href, onRemove, className }: LinkChipProps) {
  const label = name || "Untitled";
  const body = (
    <>
      {hue !== undefined && <ColorMark hue={hue} size={8} name={markName} />}
      <span className="truncate">{label}</span>
    </>
  );
  const part = "inline-flex min-w-0 items-center gap-1.5 truncate";
  // What opens something is at least 24 px tall on a desktop and 44 on a phone (A11Y-6, PH-6), inside the 1 px
  // border; a chip that only shows a name stays a line of text.
  const target = "min-h-6 max-md:min-h-control-touch";
  return (
    <span className={cn("inline-flex max-w-full items-center rounded-sm border border-line bg-bg text-meta font-medium text-fg", className)}>
      {href ? (
        <a
          href={href}
          onClick={
            onOpen
              ? (e) => {
                  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  // A chip on a card or in a field is not also a click on that card or field.
                  e.stopPropagation();
                  onOpen();
                }
              : undefined
          }
          className={cn(part, target, "rounded-sm px-1.5 hover:bg-hover")}
        >
          {body}
        </a>
      ) : onOpen ? (
        <button type="button" onClick={onOpen} className={cn(part, target, "rounded-sm px-1.5 hover:bg-hover")}>
          {body}
        </button>
      ) : (
        <span className={cn(part, "px-1.5 py-px")}>{body}</span>
      )}
      {onRemove && (
        <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} className="inline-flex size-6 shrink-0 items-center justify-center rounded-xs text-muted hover:bg-hover hover:text-fg max-md:size-control-touch">
          <Icon icon={X} size="sm" />
        </button>
      )}
    </span>
  );
}
