import { createContext, useCallback, useContext, useMemo, useState, type ComponentProps, type CSSProperties } from "react";
import { Popover as P } from "radix-ui";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { menuSurfaceClass } from "./dropdown-menu";
import { usePortalHost } from "./portal-host";
import { Sheet } from "./sheet";

/** The popover's open state and name, for the bottom sheet it becomes below the desktop breakpoint. */
const SheetContext = createContext<{ open: boolean; setOpen: (open: boolean) => void; title: string } | null>(null);

/**
 * Radix's popover root. Below the desktop breakpoint its content is a bottom sheet titled `title` (PH-3), so a
 * picker is written once; pass `sheet={false}` for a note that should stay a small pop-over on a phone (a help tip).
 */
export function Popover({ open: openProp, defaultOpen = false, onOpenChange, title = "Options", sheet = true, ...props }: ComponentProps<typeof P.Root> & { title?: string; sheet?: boolean }) {
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
  const value = useMemo(() => (desktop || !sheet ? null : { open, setOpen, title }), [desktop, sheet, open, setOpen, title]);
  return (
    <SheetContext value={value}>
      <P.Root open={open} onOpenChange={setOpen} {...props} />
    </SheetContext>
  );
}
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

/** Like the menus' `menuAvailStyle`: a popover is never taller than the room beside its trigger. */
const popoverAvailStyle = {
  "--ob-avail": "calc(var(--radix-popover-content-available-height, 100dvh) - env(safe-area-inset-bottom))",
} as CSSProperties;

export function PopoverContent({ className, style, sideOffset = 6, align = "start", collisionPadding = 8, ...props }: ComponentProps<typeof P.Content>) {
  const host = usePortalHost();
  const asSheet = useContext(SheetContext);
  if (asSheet) {
    return (
      <Sheet open={asSheet.open} onOpenChange={asSheet.setOpen} title={props["aria-label"] ?? asSheet.title} onOpenAutoFocus={props.onOpenAutoFocus} onCloseAutoFocus={props.onCloseAutoFocus}>
        {/* The content's key handling (Enter applies a one-field form) carries over to the sheet. */}
        <div onKeyDown={props.onKeyDown}>{props.children}</div>
      </Sheet>
    );
  }
  return (
    <P.Portal container={host.container}>
      <P.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        align={align}
        style={{ ...popoverAvailStyle, ...style }}
        className={cn("ob-pop-in w-72 max-h-[var(--ob-avail)] overflow-y-auto overscroll-contain", menuSurfaceClass, className)}
        {...props}
      />
    </P.Portal>
  );
}
