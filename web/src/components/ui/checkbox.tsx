import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Checkbox as C, Switch as S } from "radix-ui";
import { cn } from "@/lib/cn";

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({ checked, onCheckedChange, label, disabled, className }: CheckboxProps) {
  const id = useId();
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <C.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        className="flex size-4 shrink-0 items-center justify-center rounded border border-line-strong bg-surface data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:opacity-50"
      >
        <C.Indicator>
          <Check aria-hidden className="size-3 text-primary-fg" strokeWidth={3} />
        </C.Indicator>
      </C.Root>
      <label htmlFor={id} className={cn("text-[0.8125rem]", disabled && "opacity-60")}>
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
    <div className={cn("flex items-center gap-2", className)}>
      <S.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors data-[state=checked]:bg-primary disabled:opacity-50"
      >
        <S.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
      </S.Root>
      <label htmlFor={id} className={cn("text-[0.8125rem]", disabled && "opacity-60")}>
        {label}
      </label>
    </div>
  );
}
