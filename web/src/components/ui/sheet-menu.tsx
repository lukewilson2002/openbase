import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Link } from "react-router";
import { Check, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { Icon } from "./icon";
import { Sheet, type SheetProps } from "./sheet";

const CloseContext = createContext<() => void>(() => {});

/**
 * A list of actions in a bottom sheet (PH-3): what a menu becomes on a phone. The rows close the sheet
 * after they act, so a tap that navigates or opens a dialog does not leave the sheet over the next screen.
 */
export function SheetMenu({ onOpenChange, children, ...props }: Omit<SheetProps, "footer" | "role">) {
  return (
    <CloseContext value={() => onOpenChange(false)}>
      <Sheet onOpenChange={onOpenChange} {...props}>
        {children}
      </Sheet>
    </CloseContext>
  );
}

/** A group of rows under an optional small heading, with a rule between groups. */
export function SheetMenuGroup({ label, children, className }: { label?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("border-t border-line py-1.5 first:border-t-0", className)}>
      {label && <h3 className="px-2.5 pb-1 pt-1.5 text-meta font-medium text-muted">{label}</h3>}
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

export interface SheetMenuRowProps {
  /** The row's glyph, 20 px. Leave it out for a row with a mark of its own (`lead`). */
  icon?: LucideIcon;
  /** Something other than an icon before the name (a color mark, an avatar). */
  lead?: ReactNode;
  children: ReactNode;
  /** Goes to a page in the app. */
  to?: string;
  /** Goes to an address outside it, in a new tab. */
  href?: string;
  onSelect?: () => void;
  danger?: boolean;
  /** The current choice among a set: ticked and announced as current. */
  selected?: boolean;
  /** Leave the sheet open after the tap, for choices made one after another (the theme). */
  keepOpen?: boolean;
  disabled?: boolean;
  /** Draw no list item around the row, for a caller that wraps it in its own (a sortable row). */
  bare?: boolean;
  className?: string;
  buttonProps?: Omit<ComponentProps<"button">, "children" | "onClick" | "className" | "disabled" | "type">;
}

/** One 44 px row of a sheet menu: a link when it goes somewhere, else a button. */
export function SheetMenuRow({ icon, lead, children, to, href, onSelect, danger, selected, keepOpen, disabled, bare, className, buttonProps }: SheetMenuRowProps) {
  const close = useContext(CloseContext);
  const done = () => {
    onSelect?.();
    if (!keepOpen) close();
  };
  const classes = cn(
    "flex min-h-control-touch w-full min-w-0 items-center gap-3 rounded-md px-2.5 text-left text-ui no-underline hover:bg-hover disabled:pointer-events-none disabled:opacity-50",
    danger ? "text-danger" : "text-fg",
    selected && "font-semibold",
    className,
  );
  const body = (
    <>
      {icon && <Icon icon={icon} className={danger ? undefined : "text-muted"} />}
      {lead}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected && <Icon icon={Check} className="text-primary-text" />}
    </>
  );
  const row = to ? (
    <Link to={to} onClick={done} className={classes} aria-current={selected ? "page" : undefined}>
      {body}
    </Link>
  ) : href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={done} className={classes}>
      {body}
    </a>
  ) : (
    <button type="button" disabled={disabled} onClick={done} className={classes} aria-current={selected ? "true" : undefined} {...buttonProps}>
      {body}
    </button>
  );
  return bare ? row : <li>{row}</li>;
}
