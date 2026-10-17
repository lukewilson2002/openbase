import type { ComponentProps, CSSProperties } from "react";
import { Popover as P } from "radix-ui";
import { cn } from "@/lib/cn";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

/** Like the menus' `menuAvailStyle`: a popover is never taller than the room beside its trigger. */
const popoverAvailStyle = {
  "--ob-avail": "calc(var(--radix-popover-content-available-height, 100dvh) - env(safe-area-inset-bottom))",
} as CSSProperties;

export function PopoverContent({ className, style, sideOffset = 6, align = "start", collisionPadding = 8, ...props }: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        align={align}
        style={{ ...popoverAvailStyle, ...style }}
        className={cn(
          "ob-pop-in z-50 w-72 max-w-[calc(100vw-1rem)] max-h-[var(--ob-avail)] overflow-y-auto overscroll-contain rounded-md border border-line bg-surface p-3 shadow-pop",
          className,
        )}
        {...props}
      />
    </P.Portal>
  );
}
