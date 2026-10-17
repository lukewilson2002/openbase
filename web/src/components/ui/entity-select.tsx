import { Check, ChevronDown } from "lucide-react";
import { Select as S } from "radix-ui";
import { EntityLabel } from "@/components/icons/EntityIcon";
import { cn } from "@/lib/cn";

export interface EntityOption {
  /** Must not be empty (Radix Select reserves "" for "nothing chosen"). */
  value: string;
  label: string;
  /** Lucide icon name of the workspace, base or table the option stands for. */
  icon?: string | null;
  disabled?: boolean;
}

export interface EntitySelectProps {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly EntityOption[];
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
}

/**
 * A select whose options carry icons (a native `<select>` cannot draw them). Used wherever a table
 * is chosen by name: the link target, automation triggers and actions. Same label/hint wiring as
 * `<Select>`: pass the `id` and aria props from `<Field>`.
 */
export function EntitySelect({ id, value, onValueChange, options, disabled, className, ...aria }: EntitySelectProps) {
  // When some options have an icon, the ones without keep its space so the names line up.
  const anyIcon = options.some((o) => o.icon);
  return (
    <S.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <S.Trigger
        id={id}
        {...aria}
        className={cn(
          "flex h-8 w-full items-center justify-between gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-left text-fg",
          "transition-colors hover:border-faint focus-visible:border-ring focus-visible:outline-2 focus-visible:-outline-offset-1",
          "disabled:cursor-not-allowed disabled:bg-subtle disabled:opacity-70 aria-[invalid=true]:border-danger",
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          <S.Value />
        </span>
        <S.Icon asChild>
          <ChevronDown aria-hidden className="size-4 shrink-0 text-muted" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="ob-pop-in z-50 max-h-[min(20rem,var(--radix-select-content-available-height))] w-[var(--radix-select-trigger-width)] min-w-44 overflow-hidden rounded-md border border-line bg-surface shadow-pop"
        >
          <S.Viewport className="p-1">
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex cursor-default select-none items-center gap-2 rounded py-1.5 pl-2 pr-7 text-[0.8125rem] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover"
              >
                <S.ItemText>
                  <EntityLabel icon={o.icon} reserveIcon={anyIcon}>
                    {o.label}
                  </EntityLabel>
                </S.ItemText>
                <S.ItemIndicator className="absolute right-2 inline-flex">
                  <Check aria-hidden className="size-3.5" />
                </S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
