/**
 * The items of a sidebar "…" menu, written once and drawn for the screen they are on: a dropdown's
 * `DropdownMenuItem` on a desktop and a 44 px row of a bottom sheet on a phone (PH-3). `ActionMenu` provides
 * which; the items and groups read it, so a menu's content is the same code in both.
 */
import { cloneElement, useContext, useState, type ReactElement, type ReactNode } from "react";
import { Link } from "react-router";
import type { LucideIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { SheetMenu, SheetMenuRow } from "@/components/ui/sheet-menu";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { SheetModeContext } from "@/components/ui/sheet-mode";

export { SheetModeContext };

export interface MenuItemProps {
  icon: LucideIcon;
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Why the item is off, said under its name (a disabled item that does not say why is a dead end). */
  reason?: string | null;
  onSelect: () => void;
}

export function MenuItem({ icon, children, danger, disabled, reason, onSelect }: MenuItemProps) {
  if (useContext(SheetModeContext)) {
    return (
      <SheetMenuRow icon={icon} danger={danger} disabled={disabled} hint={reason} onSelect={onSelect}>
        {children}
      </SheetMenuRow>
    );
  }
  return (
    <DropdownMenuItem danger={danger} disabled={disabled} onSelect={onSelect}>
      <Icon icon={icon} />
      {reason ? (
        <span className="flex min-w-0 flex-col">
          <span>{children}</span>
          <span className="max-w-60 text-meta font-normal text-muted">{reason}</span>
        </span>
      ) : (
        children
      )}
    </DropdownMenuItem>
  );
}

/** A menu item that goes to a page. */
export function LinkItem({ to, icon, children }: { to: string; icon: LucideIcon; children: ReactNode }) {
  if (useContext(SheetModeContext)) {
    return (
      <SheetMenuRow icon={icon} to={to}>
        {children}
      </SheetMenuRow>
    );
  }
  return (
    <DropdownMenuItem asChild>
      <Link to={to}>
        <Icon icon={icon} /> {children}
      </Link>
    </DropdownMenuItem>
  );
}

/** A rule inside a dropdown; a sheet separates its groups on its own, so it draws none. */
export function MenuSeparator() {
  return useContext(SheetModeContext) ? null : <DropdownMenuSeparator />;
}

interface MenuState {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * A "…" or "+" button with its menu: a dropdown beside the button on a desktop, a bottom sheet titled `title` on a
 * phone. `trigger` is the button (an `IconButton`); `state` controls the menu from outside (a right-click on the row).
 */
export function ActionMenu({ title, trigger, state, children }: { title: string; trigger: ReactElement<{ onClick?: () => void }>; state?: MenuState; children: ReactNode }) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [own, setOwn] = useState(false);
  const { open, onOpenChange } = state ?? { open: own, onOpenChange: setOwn };
  if (desktop) {
    return (
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align="start">{children}</DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <>
      {cloneElement(trigger, { onClick: () => onOpenChange(true), "aria-haspopup": "dialog", "aria-expanded": open } as object)}
      <SheetMenu open={open} onOpenChange={onOpenChange} title={title}>
        <SheetModeContext value>{children}</SheetModeContext>
      </SheetMenu>
    </>
  );
}
