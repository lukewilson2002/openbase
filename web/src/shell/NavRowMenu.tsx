/**
 * The pieces every sidebar row shares for its "…" menu: the button and the menu laid out in groups (the items
 * themselves are in `menuItems.tsx`). A right-click on the row opens the same menu (`useRowMenu`).
 */
import { Fragment, useContext, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { SheetMenuGroup } from "@/components/ui/sheet-menu";
import { ActionMenu, SheetModeContext } from "./menuItems";
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

/** A "…" button with its menu, in the place every row keeps it; `menu` also opens it on a right-click. `title` names the sheet on a phone: the row's name. */
export function RowMenu({ label, title, menu, children }: { label: string; title: string; menu: RowMenuState; children: ReactNode }) {
  return (
    <ActionMenu
      title={title}
      state={menu}
      trigger={
        <IconButton label={label} size="sm" noTooltip className={rowActionClass} {...NO_DRAG}>
          <Icon icon={Ellipsis} />
        </IconButton>
      }
    >
      {children}
    </ActionMenu>
  );
}

/** Groups of items with a rule (a dropdown) or a sheet section (a phone) between the groups that have something in them. */
export function MenuGroups({ groups }: { groups: ReactNode[][] }) {
  const sheet = useContext(SheetModeContext);
  const shown = groups.map((g) => g.filter(Boolean)).filter((g) => g.length > 0);
  return (
    <>
      {shown.map((items, i) =>
        sheet ? (
          <SheetMenuGroup key={i}>{items}</SheetMenuGroup>
        ) : (
          <Fragment key={i}>
            {i > 0 && <DropdownMenuSeparator />}
            {items}
          </Fragment>
        ),
      )}
    </>
  );
}
