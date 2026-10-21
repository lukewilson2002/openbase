import { cn } from "@/lib/cn";
import { EntityIcon } from "./EntityIcon";
import { POPULAR_ICONS, humanizeIconName } from "./popular";

/** Columns of every icon grid in the picker; the popular 20 are two full rows. */
export const ICON_COLS = 10;

/** One icon in a picker grid. `index` is its position in the picker's keyboard order. */
export function IconCell({ name, index, selected, tabbable, onPick }: { name: string; index: number; selected: boolean; tabbable: boolean; onPick: (name: string) => void }) {
  const label = humanizeIconName(name);
  return (
    <button
      type="button"
      data-icon-index={index}
      data-icon-name={name}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onPick(name)}
      className={cn(
        "flex size-[1.875rem] items-center justify-center justify-self-center rounded-md text-fg transition-colors hover:bg-hover",
        "focus-visible:outline-2 focus-visible:outline-ring",
        selected && "bg-primary-soft text-primary-text ring-1 ring-primary",
      )}
    >
      <EntityIcon name={name} className="size-[1.125rem]" />
    </button>
  );
}

/**
 * The 20 popular icons, always visible at the top of the picker. They are bundled (no lazy load), so
 * they are on screen before the rest of the picker has loaded.
 */
export function PopularSection({ value, active, onPick }: { value?: string | null; active: number; onPick: (name: string) => void }) {
  return (
    <section aria-labelledby="icon-popular" className="px-2 pb-2 pt-2">
      <h3 id="icon-popular" className="mb-1 px-1 text-xs font-medium uppercase tracking-wide text-muted">
        Popular
      </h3>
      <div role="group" aria-label="Popular icons" className="grid gap-y-0.5" style={{ gridTemplateColumns: `repeat(${ICON_COLS}, minmax(0, 1fr))` }}>
        {POPULAR_ICONS.map((p, i) => (
          <IconCell key={p.name} name={p.name} index={i} selected={value === p.name} tabbable={active === i} onPick={onPick} />
        ))}
      </div>
    </section>
  );
}
