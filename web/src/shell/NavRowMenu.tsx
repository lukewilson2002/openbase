/**
 * The pieces every sidebar row shares for its "…" menu: the button, the menu laid out in groups, and a menu
 * item that is a link. A right-click on the row opens the same menu (`useRowMenu`).
 */
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { Ellipsis } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { NO_DRAG, useRowMenu } from "./sortable";

export type RowMenuState = ReturnType<typeof useRowMenu>["menu"];

/**
 * A row's "…" button sits over the row's right end. With a mouse on a wide screen it shows only on hover, on
 * focus or while its menu is open, in the place the record count takes the rest of the time; on a phone, a
 * touch screen or a narrow window it is always there and the row leaves it room (`rowEndClass`).
 */
export const rowActionClass =
  "absolute right-1 top-1/2 -translate-y-1/2 md:pointer-fine:opacity-0 md:pointer-fine:focus-visible:opacity-100 md:pointer-fine:group-hover/item:opacity-100 data-[state=open]:opacity-100";

/** Room at the end of a row for the always-visible "…" button. */
export const rowEndClass = "max-md:pr-11 pointer-coarse:pr-11";

/** The count at a row's right: hidden while the "…" button takes its place; its width keeps the name clear of the button. */
export const countSlotClass =
  "inline-block min-w-7 text-right md:pointer-fine:group-hover/item:invisible md:pointer-fine:group-focus-within/item:invisible md:pointer-fine:group-has-[[data-state=open]]/item:invisible";

/** A "…" button with its menu, in the place every row keeps it; `menu` also opens it on a right-click. */
export function RowMenu({ label, menu, children }: { label: string; menu: RowMenuState; children: ReactNode }) {
  return (
    <DropdownMenu {...menu}>
      <DropdownMenuTrigger asChild>
        <IconButton label={label} size="sm" noTooltip className={rowActionClass} {...NO_DRAG}>
          <Icon icon={Ellipsis} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Groups of menu items with a separator between the groups that have something in them. */
export function MenuGroups({ groups }: { groups: ReactNode[][] }) {
  const shown = groups.map((g) => g.filter(Boolean)).filter((g) => g.length > 0);
  return (
    <>
      {shown.map((items, i) => (
        <Fragment key={i}>
          {i > 0 && <DropdownMenuSeparator />}
          {items}
        </Fragment>
      ))}
    </>
  );
}

/** A menu item that goes to a page. */
export function LinkItem({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <DropdownMenuItem asChild>
      <Link to={to}>
        {icon} {children}
      </Link>
    </DropdownMenuItem>
  );
}
