import type { ComponentProps } from "react";
import { Popover as P } from "radix-ui";
import { cn } from "@/lib/cn";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export function PopoverContent({ className, sideOffset = 6, align = "start", ...props }: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "og-pop-in z-50 w-72 max-w-[calc(100vw-1rem)] rounded-md border border-line bg-surface p-3 shadow-pop",
          className,
        )}
        {...props}
      />
    </P.Portal>
  );
}
