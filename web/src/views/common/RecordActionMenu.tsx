/**
 * The menu of a card or row, drawn for the screen: a dropdown hung at the pointer on a desktop (a right-click,
 * the menu key) and a bottom sheet titled with the record on a phone, opened by a hold (COL-9, PH-3). The
 * items are written once with `MenuItem` and `MenuSeparator` from the shell's menu items, which draw as
 * dropdown items or as 44 px sheet rows depending on which of the two holds them.
 */
import type { ReactNode } from "react";
import { AnchoredMenu, type MenuAnchor } from "@/components/ui/anchored-menu";
import { SheetMenu } from "@/components/ui/sheet-menu";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { SheetModeContext } from "@/shell/menuItems";

export interface RecordActionMenuProps {
  anchor: MenuAnchor | null;
  onClose: () => void;
  /** The dropdown's accessible name. */
  label: string;
  /** The sheet's title: the record's name. */
  title: string;
  children: ReactNode;
}

export function RecordActionMenu({ anchor, onClose, label, title, children }: RecordActionMenuProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  if (desktop) {
    return (
      <AnchoredMenu anchor={anchor} onClose={onClose} label={label}>
        {children}
      </AnchoredMenu>
    );
  }
  return (
    <SheetMenu
      open={anchor !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
    >
      <SheetModeContext value>{children}</SheetModeContext>
    </SheetMenu>
  );
}
