/** The Layout tiles of View options (COL-6): seven layouts in a grid, the shown one with a 2 px blue border on primary-soft. */
import type { ViewType } from "@/api/types";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { LAYOUT_TILE_ORDER, VIEW_TYPE_META } from "@/views/meta";

export function LayoutTiles({ layout, onChange }: { layout: ViewType; onChange: (type: ViewType) => void }) {
  return (
    <div role="group" aria-label="Layout" className="grid grid-cols-3 gap-2 md:grid-cols-4">
      {LAYOUT_TILE_ORDER.map((type) => {
        const meta = VIEW_TYPE_META[type];
        const on = type === layout;
        return (
          <button
            key={type}
            type="button"
            aria-pressed={on}
            onClick={() => !on && onChange(type)}
            className={cn(
              "flex min-h-control-touch flex-col items-center justify-center gap-1 rounded-md border-2 px-1 py-2 text-label transition-colors md:min-h-16",
              // The selected tile also turns bold: color is never the only cue.
              on ? "border-primary bg-primary-soft font-semibold text-primary-ink" : "border-line bg-surface font-medium text-fg hover:bg-hover",
            )}
          >
            <Icon icon={meta.icon} />
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}
