/** A segmented switch (Month | Week, Build | Fill in form): pressed buttons in a soft grey track. */
import { cn } from "@/lib/cn";

export interface SegmentedSwitchProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  /** `md` is the toolbar's size (Build | Fill in form), `sm` a card header's. */
  size?: "sm" | "md";
  className?: string;
}

export function SegmentedSwitch<T extends string>({ label, value, options, onChange, size = "sm", className }: SegmentedSwitchProps<T>) {
  return (
    <div role="group" aria-label={label} className={cn("flex shrink-0 rounded-[10px] bg-subtle p-[3px]", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-[7px] transition-colors pointer-coarse:h-9",
              size === "sm" ? "h-7 px-3 text-[0.8125rem]" : "h-[30px] px-3.5 text-[0.875rem]",
              on ? "bg-surface font-semibold text-fg shadow-[0_1px_2px_rgb(15_20_30/0.12)]" : "font-medium text-muted hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
