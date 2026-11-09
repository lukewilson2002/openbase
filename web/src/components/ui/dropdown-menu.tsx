import { createContext, useCallback, useContext, useMemo, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import { DropdownMenu as M, Slot } from "radix-ui";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { useTapGuard } from "@/lib/tapGuard";
import { usePortalHost } from "./portal-host";
import { Icon } from "./icon";
import { SheetMenu, useSheetMenuClose } from "./sheet-menu";
import { SheetModeContext } from "./sheet-mode";

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

/** The menu's open state, so a trigger can open it on a tap (see `DropdownMenuTrigger`), and whether it is a sheet and what it is called. */
const OpenContext = createContext<{ open: boolean; setOpen: (open: boolean) => void; sheet: boolean; title: string } | null>(null);

/**
 * Radix's root, with the open state held here (controlled or not) for the trigger's tap handling. Below the desktop
 * breakpoint the menu is a bottom sheet titled `title` instead of a dropdown (PH-3): its content, items and labels
 * draw as sheet rows, so a menu is written once.
 */
export function DropdownMenu({ open: openProp, defaultOpen = false, onOpenChange, title = "Menu", ...props }: ComponentProps<typeof M.Root> & { title?: string }) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [inner, setInner] = useState(defaultOpen);
  const open = openProp ?? inner;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInner(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );
  const value = useMemo(() => ({ open, setOpen, sheet: !desktop, title }), [open, setOpen, desktop, title]);
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
        // Radix opens on the press, before a mouse has given the button focus: a sheet that opens then has nothing to hand focus back to.
        if (menu?.sheet && e.pointerType === "mouse") e.currentTarget.focus({ preventScroll: true });
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

const RadioContext = createContext<{ value?: string; onValueChange?: (value: string) => void } | null>(null);

export function DropdownMenuRadioGroup({ value, onValueChange, ...props }: ComponentProps<typeof M.RadioGroup>) {
  if (useContext(SheetModeContext)) return <RadioContext value={{ value, onValueChange }}>{props.children}</RadioContext>;
  return <M.RadioGroup value={value} onValueChange={onValueChange} {...props} />;
}

export function DropdownMenuContent({ className, style, sideOffset = 4, align = "end", collisionPadding = 8, ...props }: ComponentProps<typeof M.Content>) {
  const host = usePortalHost();
  const menu = useContext(OpenContext);
  if (menu?.sheet) {
    return (
      <SheetMenu open={menu.open} onOpenChange={menu.setOpen} title={props["aria-label"] ?? menu.title}>
        <SheetModeContext value>
          <ul className="flex flex-col py-1.5">{props.children}</ul>
        </SheetModeContext>
      </SheetMenu>
    );
  }
  return (
    <M.Portal container={host.container}>
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

/**
 * A row of a menu drawn as a sheet: 44 px, closing the sheet after it acts unless the item keeps the menu open
 * (`preventDefault` on the select event, as in a dropdown).
 */
function SheetItem({ className, danger, disabled, onSelect, asChild, selected, children }: { className?: string; danger?: boolean; disabled?: boolean; onSelect?: (event: Event) => void; asChild?: boolean; selected?: boolean; children?: ReactNode }) {
  const close = useSheetMenuClose();
  const Comp = asChild ? Slot.Root : "button";
  return (
    <li>
      <Comp
        {...(asChild ? {} : { type: "button", disabled })}
        aria-current={selected ? "true" : undefined}
        onClick={() => {
          if (disabled) return;
          const event = new Event("menu.select", { cancelable: true });
          onSelect?.(event);
          if (!event.defaultPrevented) close();
        }}
        className={cn(menuRowClass, "min-h-control-touch w-full gap-3 text-left hover:bg-hover disabled:pointer-events-none disabled:opacity-50", selected && "font-semibold", danger && "text-danger", className)}
      >
        {children}
      </Comp>
    </li>
  );
}

export function DropdownMenuItem({ className, danger, disabled, onSelect, asChild, children, ...props }: ComponentProps<typeof M.Item> & { danger?: boolean }) {
  if (useContext(SheetModeContext)) {
    return (
      <SheetItem className={className} danger={danger} disabled={disabled} onSelect={onSelect} asChild={asChild}>
        {children}
      </SheetItem>
    );
  }
  return (
    <M.Item className={cn(itemClass, danger && "text-danger", className)} disabled={disabled} onSelect={onSelect} asChild={asChild} {...props}>
      {children}
    </M.Item>
  );
}

export function DropdownMenuRadioItem({ className, children, value, onSelect, ...props }: ComponentProps<typeof M.RadioItem>) {
  const group = useContext(RadioContext);
  if (useContext(SheetModeContext)) {
    const selected = group?.value === value;
    return (
      <SheetItem
        className={className}
        disabled={props.disabled}
        selected={selected}
        onSelect={(e) => {
          onSelect?.(e);
          if (!e.defaultPrevented) group?.onValueChange?.(value);
        }}
      >
        <span className="min-w-0 flex-1">{children}</span>
        {selected && <Icon icon={Check} className="text-primary-text" />}
      </SheetItem>
    );
  }
  return (
    <M.RadioItem className={cn(itemClass, "pl-8", className)} value={value} onSelect={onSelect} {...props}>
      <M.ItemIndicator className="absolute left-2.5 inline-flex">
        <Icon icon={Check} />
      </M.ItemIndicator>
      {children}
    </M.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof M.Label>) {
  if (useContext(SheetModeContext)) return <li className={cn("px-2.5 py-1 text-meta font-medium text-muted", className)}>{props.children}</li>;
  return <M.Label className={cn("px-2.5 py-1 text-meta font-medium text-muted", className)} {...props} />;
}

export const DropdownMenuSub = M.Sub;

export function DropdownMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof M.SubTrigger>) {
  return (
    <M.SubTrigger className={cn(itemClass, "data-[state=open]:bg-primary-soft", className)} {...props}>
      {children}
      <Icon icon={ChevronRight} className="ml-auto text-muted" />
    </M.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, style, sideOffset = 4, collisionPadding = 8, ...props }: ComponentProps<typeof M.SubContent>) {
  const host = usePortalHost();
  return (
    <M.Portal container={host.container}>
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
  if (useContext(SheetModeContext)) return <li role="separator" className="my-1 h-px bg-line" />;
  return <M.Separator className={cn("-mx-1.5 my-1.5 h-px bg-line", className)} {...props} />;
}
