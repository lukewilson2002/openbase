import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { menuRowClass } from "./dropdown-menu";

/**
 * The keyboard model of a list that is browsed while focus stays in a text field (the command palette's
 * results, the filter bar's suggestions): Arrow Down and Up move the highlight and wrap, and the field's own
 * keys (Home and End move its caret) are left alone. `ids` identifies the rows; the highlight goes back to the
 * first row whenever the rows change, so Enter always means "the best match".
 */
export function useListNav(ids: readonly string[]) {
  const [active, setActive] = useState(0);
  const key = ids.join("\u0000");
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setActive(0);
  }
  const count = ids.length;
  const index = count === 0 ? -1 : Math.min(active, count - 1);

  /** Handles an Arrow key; true when it did, so the caller can stop there. */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (count === 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
    if (e.key === "ArrowDown") setActive((index + 1) % count);
    else if (e.key === "ArrowUp") setActive((index - 1 + count) % count);
    else return false;
    e.preventDefault();
    return true;
  };

  return { index, activeId: index >= 0 ? ids[index] : undefined, setActive, onKeyDown };
}

export interface ListboxOptionProps {
  id: string;
  active: boolean;
  onSelect: () => void;
  onHover?: () => void;
  /** A mark or glyph before the label. */
  leading?: ReactNode;
  /** Quiet text at the right end (a collection's name, a shortcut). */
  hint?: ReactNode;
  /** A second quiet line under the label (a snippet of the text that matched). */
  detail?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * One option of a listbox whose focus stays in the field above it. A press does not take focus off the field
 * (`onMouseDown` is cancelled), and the highlighted row scrolls into view as the keys move it.
 */
export function ListboxOption({ id, active, onSelect, onHover, leading, hint, detail, children, className }: ListboxOptionProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={active}
      data-active={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
      onMouseMove={onHover}
      className={cn(menuRowClass, "cursor-pointer", className)}
    >
      {leading}
      {detail ? (
        <span className="min-w-0 flex-1 py-1.5">
          <span className="block truncate">{children}</span>
          <span className="line-clamp-2 text-meta text-muted">{detail}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{children}</span>
      )}
      {hint && <span className="shrink-0 text-meta text-muted">{hint}</span>}
    </div>
  );
}
