import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Checkbox as C, Switch as S } from "radix-ui";
import { cn } from "@/lib/cn";
import { Icon } from "./icon";

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * On a phone the whole row is the target (PH-6): the label stretches a transparent layer over it, so a tap beside
 * a 16 px box or a 20 px switch still lands on the control the row belongs to.
 */
const rowClass = "flex items-center gap-2 max-md:relative max-md:min-h-control-touch";
const labelClass = "text-label max-md:after:absolute max-md:after:inset-0";

export function Checkbox({ checked, onCheckedChange, label, disabled, className }: CheckboxProps) {
  const id = useId();
  return (
    <div className={cn(rowClass, className)}>
      <C.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        // The 16 px box is what is drawn; the press area is 24 px on a desktop (A11Y-6), a layer around it.
        className="relative flex size-4 shrink-0 items-center justify-center rounded border border-line-strong bg-surface before:absolute before:left-1/2 before:top-1/2 before:size-6 before:-translate-x-1/2 before:-translate-y-1/2 data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:opacity-50"
      >
        <C.Indicator>
          <Icon icon={Check} size="sm" className="text-primary-fg" />
        </C.Indicator>
      </C.Root>
      <label htmlFor={id} className={cn(labelClass, disabled && "opacity-60")}>
        {label}
      </label>
    </div>
  );
}

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Switch({ checked, onCheckedChange, label, disabled, className }: SwitchProps) {
  const id = useId();
  return (
    <div className={cn(rowClass, className)}>
      <S.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        // On a phone the layer over it makes the press area 48 x 44 even when the label is only for screen readers (PH-6).
        className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors data-[state=checked]:bg-primary disabled:opacity-50 max-md:after:absolute max-md:after:-inset-x-1.5 max-md:after:-inset-y-3"
      >
        <S.Thumb className="block size-4 translate-x-0.5 rounded-full bg-paper shadow transition-transform data-[state=checked]:translate-x-[18px]" />
      </S.Root>
      <label htmlFor={id} className={cn(labelClass, disabled && "opacity-60")}>
        {label}
      </label>
    </div>
  );
}
