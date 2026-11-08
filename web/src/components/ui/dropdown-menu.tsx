import { createContext, useCallback, useContext, useMemo, useState, type ComponentProps, type CSSProperties } from "react";
import { Check, ChevronRight } from "lucide-react";
import { DropdownMenu as M } from "radix-ui";
import { cn } from "@/lib/cn";
import { useTapGuard } from "@/lib/tapGuard";

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

/** The floating surface of a menu or popover: radius 12, 6 px padding, the shadow that marks things that float. */
export const menuSurfaceClass = "z-50 max-w-[calc(100vw-1rem)] rounded-lg border border-line bg-surface p-1.5 shadow-pop";

/**
 * One row of a menu or of a list inside a popover: 40 px (44 on phone), radius 8, and the highlighted row
 * (keyboard or pointer) in primary-soft. `data-[highlighted]` is Radix's; listboxes set `data-active`.
 */
export const menuRowClass =
  "relative flex min-h-control-lg cursor-default select-none items-center gap-2 rounded-md px-2.5 text-ui text-fg no-underline outline-none max-md:min-h-control-touch pointer-coarse:min-h-control-touch " +
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-primary-soft data-[active=true]:bg-primary-soft";

/** The menu's open state, so a trigger can open it on a tap (see `DropdownMenuTrigger`). */
const OpenContext = createContext<{ open: boolean; setOpen: (open: boolean) => void } | null>(null);

/** Radix's root, with the open state held here (controlled or not) for the trigger's tap handling. */
export function DropdownMenu({ open: openProp, defaultOpen = false, onOpenChange, ...props }: ComponentProps<typeof M.Root>) {
  const [inner, setInner] = useState(defaultOpen);
  const open = openProp ?? inner;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInner(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );
  const value = useMemo(() => ({ open, setOpen }), [open, setOpen]);
  return (
    <OpenContext value={value}>
      <M.Root open={open} onOpenChange={setOpen} {...props} />
    </OpenContext>
  );
}

/**
 * Opens on a mouse press, like Radix, and on Enter, Space and ArrowDown. A finger opens it on a tap
 * instead: Radix opens on pointerdown for every pointer, which on a phone turned a swipe that started
 * on a menu button into an open menu. See `lib/tapGuard`.
 */
export function DropdownMenuTrigger({ onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick, ...props }: ComponentProps<typeof M.Trigger>) {
  const menu = useContext(OpenContext);
  const guard = useTapGuard(() => {
    if (props.disabled || !menu) return;
    menu.setOpen(!menu.open);
  });
  // Ours first: a touch's pointerdown is cancelled before Radix's handler sees it.
  return (
    <M.Trigger
      {...props}
      onPointerDown={(e) => {
        onPointerDown?.(e);
        guard.onPointerDown(e);
      }}
      onPointerMove={(e) => {
        onPointerMove?.(e);
        guard.onPointerMove(e);
      }}
      onPointerUp={(e) => {
        onPointerUp?.(e);
        guard.onPointerUp(e);
      }}
      onPointerCancel={(e) => {
        onPointerCancel?.(e);
        guard.onPointerCancel(e);
      }}
      onClick={(e) => {
        onClick?.(e);
        guard.onClick();
      }}
    />
  );
}
export const DropdownMenuRadioGroup = M.RadioGroup;

export function DropdownMenuContent({ className, style, sideOffset = 4, align = "end", collisionPadding = 8, ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        align={align}
        style={{ ...menuAvailStyle, ...style }}
        className={cn("ob-pop-in min-w-44", menuSurfaceClass, availClass, className)}
        {...props}
      />
    </M.Portal>
  );
}

const itemClass = menuRowClass;

export function DropdownMenuItem({ className, danger, ...props }: ComponentProps<typeof M.Item> & { danger?: boolean }) {
  return <M.Item className={cn(itemClass, danger && "text-danger", className)} {...props} />;
}

export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem className={cn(itemClass, "pl-8", className)} {...props}>
      <M.ItemIndicator className="absolute left-2.5 inline-flex">
        <Check aria-hidden className="size-3.5" />
      </M.ItemIndicator>
      {children}
    </M.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof M.Label>) {
  return <M.Label className={cn("px-2.5 py-1 text-meta font-medium text-muted", className)} {...props} />;
}

export const DropdownMenuSub = M.Sub;

export function DropdownMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof M.SubTrigger>) {
  return (
    <M.SubTrigger className={cn(itemClass, "data-[state=open]:bg-primary-soft", className)} {...props}>
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
        className={cn("ob-pop-in min-w-40", menuSurfaceClass, availClass, className)}
        {...props}
      />
    </M.Portal>
  );
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof M.Separator>) {
  return <M.Separator className={cn("-mx-1.5 my-1.5 h-px bg-line", className)} {...props} />;
}
