/**
 * The header of every phone screen (PH-2): 56 px, with the workspace switcher on Home or a back link naming the
 * parent screen on the left, the screen's title, and on the right up to three 44 px icon buttons. The search
 * (NAV-8) always has one of the three; when the screen has more actions than the rest fit, the last ones go
 * into a More button, which counts as one of the three and opens a sheet.
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronLeft, Ellipsis, type LucideIcon } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { SheetMenu, SheetMenuGroup, SheetMenuRow } from "@/components/ui/sheet-menu";
import { cn } from "@/lib/cn";
import { SearchButton } from "./SearchEverything";

export interface PhoneAction {
  id: string;
  /** The button's accessible name, and the row's name when it is in the More sheet. */
  label: string;
  icon?: LucideIcon;
  /** Drawn in place of the icon (the person's avatar). */
  face?: ReactNode;
  /** A page to go to: the button is a link. Else `onSelect` acts. */
  to?: string;
  onSelect?: () => void;
  /** Dimmed and inert, for an action the screen cannot take right now. */
  disabled?: boolean;
}

/** What the right side holds: the buttons, More and the search all count. */
export const PHONE_HEADER_SLOTS = 3;

/** Which actions get a button and which go into More, given the room (the search takes one slot). */
export function splitActions<T>(actions: T[], search: boolean): { shown: T[]; more: T[] } {
  const room = PHONE_HEADER_SLOTS - (search ? 1 : 0);
  if (actions.length <= room) return { shown: actions, more: [] };
  // More takes a slot of its own.
  return { shown: actions.slice(0, room - 1), more: actions.slice(room - 1) };
}

export interface PhoneHeaderProps {
  /** At the left: the workspace switcher, or a `PhoneBackLink`. */
  leading?: ReactNode;
  /** The screen's one `h1`. Leave it out when the screen's body starts with its own heading. */
  title?: ReactNode;
  actions?: PhoneAction[];
  /** The search button, on by default. */
  search?: boolean;
  className?: string;
}

function ActionButton({ action }: { action: PhoneAction }) {
  const glyph = action.face ?? (action.icon && <Icon icon={action.icon} />);
  if (action.to)
    return (
      <IconButton asChild label={action.label}>
        <Link to={action.to}>{glyph}</Link>
      </IconButton>
    );
  return (
    <IconButton label={action.label} onClick={action.onSelect} disabled={action.disabled}>
      {glyph}
    </IconButton>
  );
}

function MoreButton({ actions }: { actions: PhoneAction[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label="More" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <Icon icon={Ellipsis} />
      </IconButton>
      <SheetMenu open={open} onOpenChange={setOpen} title="More">
        <SheetMenuGroup>
          {actions.map((a) => (
            <SheetMenuRow key={a.id} icon={a.icon} to={a.to} onSelect={a.onSelect} disabled={a.disabled}>
              {a.label}
            </SheetMenuRow>
          ))}
        </SheetMenuGroup>
      </SheetMenu>
    </>
  );
}

/** The way back, naming the screen it leads to ("Clients", "Collections"): a link in the header's left corner. */
export function PhoneBackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="-ml-1 flex min-h-control-touch max-w-[45%] shrink-0 items-center gap-0.5 rounded-md pl-1 pr-2 text-ui text-primary-text no-underline hover:bg-hover">
      <Icon icon={ChevronLeft} />
      <span className="truncate">
        <span className="sr-only">Back to</span> {label}
      </span>
    </Link>
  );
}

export function PhoneHeader({ leading, title, actions = [], search = true, className }: PhoneHeaderProps) {
  const { shown, more } = splitActions(actions, search);
  return (
    <header
      className={cn(
        "flex min-h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 border-b border-line bg-surface pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)]",
        className,
      )}
    >
      {leading}
      {title ? <h1 className="min-w-0 flex-1 truncate px-1.5 text-sheet">{title}</h1> : <div className="flex-1" />}
      <div className="flex shrink-0 items-center">
        {shown.map((a) => (
          <ActionButton key={a.id} action={a} />
        ))}
        {more.length > 0 && <MoreButton actions={more} />}
        {search && <SearchButton />}
      </div>
    </header>
  );
}
