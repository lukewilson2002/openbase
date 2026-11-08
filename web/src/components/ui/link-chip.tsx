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
  /** Opens the linked record as a link (the record's own URL); wins over `onOpen`. */
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
  return (
    <span className={cn("inline-flex max-w-full items-center rounded-sm border border-line bg-bg text-meta font-medium text-fg", className)}>
      {href ? (
        <a href={href} className={cn(part, "rounded-sm px-1.5 py-px hover:bg-hover")}>
          {body}
        </a>
      ) : onOpen ? (
        <button type="button" onClick={onOpen} className={cn(part, "rounded-sm px-1.5 py-px hover:bg-hover")}>
          {body}
        </button>
      ) : (
        <span className={cn(part, "px-1.5 py-px")}>{body}</span>
      )}
      {onRemove && (
        <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} className="relative mr-1 shrink-0 rounded-xs text-muted hover:bg-hover hover:text-fg after:absolute after:-inset-1.5 max-md:after:-inset-3">
          <Icon icon={X} size="sm" />
        </button>
      )}
    </span>
  );
}
