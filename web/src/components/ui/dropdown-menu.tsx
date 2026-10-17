import type { ComponentProps, CSSProperties } from "react";
import { Check, ChevronRight } from "lucide-react";
import { DropdownMenu as M } from "radix-ui";
import { cn } from "@/lib/cn";

/**
 * The height a menu has below or above its trigger, inside the screen's collision padding and clear
 * of the home indicator. Menus are never taller and scroll past it, so on a phone a long menu runs
 * to the bottom of the screen instead of off it. `--ob-avail` lets a menu that caps its own height
 * keep this limit too: `max-h-[min(24rem,var(--ob-avail))]`.
 */
export const menuAvailStyle = {
  "--ob-avail": "calc(var(--radix-dropdown-menu-content-available-height, 100dvh) - env(safe-area-inset-bottom))",
} as CSSProperties;
const availClass = "max-h-[var(--ob-avail)] overflow-y-auto overscroll-contain";

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuRadioGroup = M.RadioGroup;

export function DropdownMenuContent({ className, style, sideOffset = 4, align = "end", collisionPadding = 8, ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        align={align}
        style={{ ...menuAvailStyle, ...style }}
        className={cn(
          "ob-pop-in z-50 min-w-44 max-w-[calc(100vw-1rem)] rounded-md border border-line bg-surface p-1 shadow-pop",
          availClass,
          className,
        )}
        {...props}
      />
    </M.Portal>
  );
}

const itemClass =
  "relative flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-[0.8125rem] text-fg no-underline outline-none pointer-coarse:py-2.5 " +
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

export const DropdownMenuSub = M.Sub;

export function DropdownMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof M.SubTrigger>) {
  return (
    <M.SubTrigger className={cn(itemClass, "data-[state=open]:bg-hover", className)} {...props}>
      {children}
      <ChevronRight aria-hidden className="ml-auto size-3.5 text-muted" />
    </M.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, style, sideOffset = 4, collisionPadding = 8, ...props }: ComponentProps<typeof M.SubContent>) {
  return (
    <M.Portal>
      <M.SubContent
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        style={{ ...menuAvailStyle, ...style }}
        className={cn("ob-pop-in z-50 min-w-40 max-w-[calc(100vw-1rem)] rounded-md border border-line bg-surface p-1 shadow-pop", availClass, className)}
        {...props}
      />
    </M.Portal>
  );
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof M.Separator>) {
  return <M.Separator className={cn("my-1 h-px bg-line", className)} {...props} />;
}
