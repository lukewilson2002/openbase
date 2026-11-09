import { useState, type ComponentProps, type ElementType, type ReactNode } from "react";
import { COARSE_POINTER, useMediaQuery } from "@/hooks/useMediaQuery";
import { useHoldMenu } from "@/lib/holdMenu";

export interface HoldMenuRowProps extends Omit<ComponentProps<"li">, "children" | "ref"> {
  /** The row's element or component (a table row, `Tr`); a list item by default. */
  as?: ElementType;
  /** The row's content; `menu` is what a controlled `DropdownMenu` in it takes (`open`, `onOpenChange`). */
  children: (menu: { open: boolean; onOpenChange: (open: boolean) => void }) => ReactNode;
}

/**
 * A row whose "…" menu also opens on a touch hold (PH-6): the hold that lets go without moving opens the same menu,
 * which is a bottom sheet on a phone. A finger that moves is a scroll, and a link or button inside the row keeps its
 * own tap. Only a touch screen reads the hold, so a mouse keeps the button.
 */
export function HoldMenuRow({ as: Tag = "li", children, ...props }: HoldMenuRowProps) {
  const [open, setOpen] = useState(false);
  const coarse = useMediaQuery(COARSE_POINTER);
  const hold = useHoldMenu(() => setOpen(true), coarse);
  return (
    <Tag {...props} {...hold}>
      {children({ open, onOpenChange: setOpen })}
    </Tag>
  );
}
