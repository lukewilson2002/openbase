import type { ComponentProps } from "react";
import { Check } from "lucide-react";
import { DropdownMenu as M } from "radix-ui";
import { cn } from "@/lib/cn";

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuRadioGroup = M.RadioGroup;

export function DropdownMenuContent({ className, sideOffset = 4, align = "end", ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "og-pop-in z-50 min-w-44 max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-line bg-surface p-1 shadow-pop",
          className,
        )}
        {...props}
      />
    </M.Portal>
  );
}

const itemClass =
  "relative flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-[0.8125rem] outline-none " +
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover";

export function DropdownMenuItem({ className, danger, ...props }: ComponentProps<typeof M.Item> & { danger?: boolean }) {
  return <M.Item className={cn(itemClass, danger && "text-danger", className)} {...props} />;
}

export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem className={cn(itemClass, "pl-7", className)} {...props}>
      <M.ItemIndicator className="absolute left-2 inline-flex">
        <Check aria-hidden className="size-3.5" />
      </M.ItemIndicator>
      {children}
    </M.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof M.Label>) {
  return <M.Label className={cn("px-2 py-1 text-xs font-medium text-muted", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof M.Separator>) {
  return <M.Separator className={cn("my-1 h-px bg-line", className)} {...props} />;
}
