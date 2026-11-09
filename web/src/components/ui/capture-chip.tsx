import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ColorMark } from "./color-mark";

export interface CaptureChipProps extends ComponentProps<"button"> {
  /** A chip that says what was decided and has nothing to tap (the record page's "Date · Guessed from “Nov 14”"): a span, not a button. */
  static?: boolean;
  /** A choice the capture box guessed, e.g. "Goes to Tasks"; tapping it opens the choices. */
  children: ReactNode;
  /** The dashed variant: no choice yet, tapping adds a property ("Add due date"). */
  dashed?: boolean;
  /** The target collection's palette colour as a 10 px mark; leave it out for no mark. */
  hue?: string | null;
  /** The collection's name, which the mark's fallback colour is hashed from. */
  markName?: string;
}

/** A pill that says what the app decided for a capture and lets you change it (30 px, 36 on phone). */
export function CaptureChip({ children, dashed = false, static: fixed = false, hue, markName, className, type = "button", ...props }: CaptureChipProps) {
  if (fixed) {
    return (
      <span className={cn("inline-flex h-control-sm shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border border-line bg-subtle px-3 text-label font-medium text-fg max-md:h-9", className)}>
        {hue !== undefined && <ColorMark hue={hue} size={10} name={markName} />}
        {children}
      </span>
    );
  }
  return (
    <button
      type={type}
      className={cn(
        // 36 px on a phone, with the press area widened to 44 (PH-6) by the layer over it: the gap between chips is wider than what it takes.
        "relative inline-flex h-control-sm shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-3 text-label font-medium transition-colors max-md:h-9 max-md:after:absolute max-md:after:-inset-y-1 max-md:after:inset-x-0",
        dashed ? "border-dashed border-line-strong bg-transparent text-muted hover:bg-hover hover:text-fg" : "border-line bg-subtle text-fg hover:bg-hover",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {hue !== undefined && <ColorMark hue={hue} size={10} name={markName} />}
      {children}
    </button>
  );
}
