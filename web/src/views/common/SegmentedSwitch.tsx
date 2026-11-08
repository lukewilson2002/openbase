/** A segmented switch (Month | Week, Build | Fill in form): pressed buttons in a soft grey track. */
import { cn } from "@/lib/cn";

export interface SegmentedSwitchProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  /** `md` is the toolbar's size (Build | Fill in form), `sm` a card header's, `lg` a full-width choice in a panel (View options' row height). */
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function SegmentedSwitch<T extends string>({ label, value, options, onChange, size = "sm", className }: SegmentedSwitchProps<T>) {
  return (
    <div role="group" aria-label={label} className={cn("flex shrink-0 rounded-lg bg-subtle p-0.5", size === "lg" && "w-full", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-md border transition-colors pointer-coarse:h-control-touch",
              size === "sm" && "h-7 px-3 text-[0.8125rem]",
              size === "md" && "h-[30px] px-3.5 text-[0.875rem]",
              // Four choices share the panel's width, and each is a 44 px target on a phone.
              size === "lg" && "h-control-sm min-w-0 flex-1 px-1 text-label max-md:h-control-touch pointer-coarse:h-control-touch",
              on ? "border-line bg-surface font-semibold text-fg" : "border-transparent font-medium text-muted hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
