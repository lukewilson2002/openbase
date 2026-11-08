import { Children, cloneElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/cn";
import { ColorMark } from "./color-mark";

export interface NavRowProps extends Omit<ComponentProps<"button">, "children"> {
  /** The row's name. With `asChild` it is the child's own content, e.g. `<NavRow asChild><Link to="/x">Tasks</Link></NavRow>`. */
  children: ReactNode;
  /** The entity's palette colour, drawn as a 14 px mark. `null` takes the colour the name hashes to; leave it out for a row without a mark. */
  hue?: string | null;
  /** What the mark's fallback colour is hashed from, when the label is not the entity's plain name. */
  markName?: string;
  /** Counts and the like, at the right edge. */
  count?: ReactNode;
  /** The row of the place being shown: filled, bold, and announced as the current one. */
  selected?: boolean;
  /** Render the child element (a router Link) with the row's styling and structure. */
  asChild?: boolean;
}

/**
 * One line of the sidebar or any list of places (34 px, radius 8): mark, name, optional count. The selected row
 * is `aria-current="page"` so assistive technology hears where the person is, not only sees a fill.
 */
export function NavRow({ children, hue, markName, count, selected = false, asChild = false, className, type = "button", ...props }: NavRowProps) {
  const classes = cn(
    "flex h-control-md w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-ui max-md:h-control-touch",
    selected ? "bg-primary-soft font-semibold text-primary-ink" : "font-medium text-fg hover:bg-hover",
    "disabled:pointer-events-none disabled:opacity-50",
    className,
  );
  const inner = (label: ReactNode) => (
    <>
      {hue !== undefined && <ColorMark hue={hue} size={14} name={markName ?? (typeof label === "string" ? label : "")} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && count !== "" && <span className={cn("num shrink-0 text-meta font-normal", selected ? "text-primary-ink" : "text-muted")}>{count}</span>}
    </>
  );
  const current = selected ? ("page" as const) : undefined;
  if (asChild) {
    const child = Children.only(children) as ReactElement<{ children?: ReactNode }>;
    return (
      <Slot.Root className={classes} aria-current={current} {...props}>
        {cloneElement(child, undefined, inner(child.props.children))}
      </Slot.Root>
    );
  }
  return (
    <button type={type} className={classes} aria-current={current} {...props}>
      {inner(children)}
    </button>
  );
}
