import { ColorSwatchPicker } from "@/components/ui/color-swatch-picker";
import type { ChoiceColor } from "@/lib/colors";
import { cn } from "@/lib/cn";

/**
 * The palette under a label, sized for a dialog: ten swatches across a desktop, seven on a touch
 * screen so each is a finger's width. Used where a workspace or project is created, in the dialog
 * that changes its colour, and on the workspace's settings.
 */
export function ColorField({ value, onChange, label = "Color", hint, className }: { value: string | null | undefined; onChange: (color: ChoiceColor) => void; label?: string; hint?: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span aria-hidden className="text-[0.8125rem] font-medium text-fg">
        {label}
      </span>
      <ColorSwatchPicker value={value} onChange={onChange} label={label} className="pointer-coarse:grid-cols-7" />
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}
