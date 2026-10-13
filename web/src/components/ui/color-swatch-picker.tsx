import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { COLORS, colorLabel, type ChoiceColor } from "@/lib/colors";

export interface ColorSwatchPickerProps {
  value: string | null | undefined;
  onChange: (color: ChoiceColor) => void;
  label?: string;
  className?: string;
}

/** Radio group of the 20 palette colours (light row, then saturated row). */
export function ColorSwatchPicker({ value, onChange, label = "Colour", className }: ColorSwatchPickerProps) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("grid grid-cols-10 gap-1.5", className)}>
      {COLORS.map((c) => {
        const selected = value === c;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={colorLabel(c)}
            title={colorLabel(c)}
            onClick={() => onChange(c)}
            className={cn(
              `choice choice-${c} flex aspect-square min-w-5 items-center justify-center rounded-full border border-black/10`,
              selected && "ring-2 ring-ring ring-offset-2 ring-offset-surface",
            )}
          >
            {selected && <Check aria-hidden className="size-3" strokeWidth={3} />}
          </button>
        );
      })}
    </div>
  );
}
