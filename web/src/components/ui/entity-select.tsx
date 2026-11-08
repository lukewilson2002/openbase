import { Check, ChevronDown } from "lucide-react";
import { Select as S } from "radix-ui";
import { cn } from "@/lib/cn";
import { ColorMark } from "./color-mark";
import { Icon } from "./icon";

export interface EntityOption {
  /** Must not be empty (Radix Select reserves "" for "nothing chosen"). */
  value: string;
  label: string;
  /**
   * The palette colour of the workspace, folder or collection the option stands for (DL-3), drawn as its mark
   * before the name. `null` takes the colour the label hashes to; leave it out for an option that stands for
   * no place ("(deleted collection)").
   */
  hue?: string | null;
  /** The name the mark's fallback colour is hashed from, when the label adds to it ("Tasks (this collection)"). */
  markName?: string;
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
 * A select whose options carry color marks (a native `<select>` cannot draw them). Used wherever a
 * collection is chosen by name: the link target, automation triggers and actions. Same label/hint wiring as
 * `<Select>`: pass the `id` and aria props from `<Field>`.
 */
export function EntitySelect({ id, value, onValueChange, options, disabled, className, ...aria }: EntitySelectProps) {
  // When some options have a mark, the ones without keep its space so the names line up.
  const anyMark = options.some((o) => o.hue !== undefined);
  return (
    <S.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <S.Trigger
        id={id}
        {...aria}
        className={cn(
          "flex h-8 w-full items-center justify-between gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-left text-fg max-md:h-control-touch",
          "transition-colors hover:border-faint focus-visible:border-ring focus-visible:outline-2 focus-visible:-outline-offset-1",
          "disabled:cursor-not-allowed disabled:bg-subtle disabled:opacity-70 aria-[invalid=true]:border-danger",
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          <S.Value />
        </span>
        <S.Icon asChild>
          <Icon icon={ChevronDown} className="text-muted" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="ob-pop-in z-50 max-h-[min(20rem,var(--radix-select-content-available-height))] w-[var(--radix-select-trigger-width)] min-w-44 overflow-hidden rounded-lg border border-line bg-surface shadow-pop"
        >
          <S.Viewport className="p-1.5">
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex min-h-control-lg cursor-default select-none items-center gap-2 rounded-md py-1.5 pl-2.5 pr-8 text-ui outline-none max-md:min-h-control-touch data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-primary-soft"
              >
                <S.ItemText>
                  <span className="inline-flex items-center gap-2">
                    {o.hue !== undefined ? <ColorMark hue={o.hue} size={10} name={o.markName ?? o.label} /> : anyMark && <span aria-hidden className="size-2.5 shrink-0" />}
                    {o.label}
                  </span>
                </S.ItemText>
                <S.ItemIndicator className="absolute right-2 inline-flex">
                  <Icon icon={Check} />
                </S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
