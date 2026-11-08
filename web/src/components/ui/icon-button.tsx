import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./tooltip";

export interface IconButtonProps extends Omit<ComponentProps<"button">, "aria-label" | "aria-labelledby" | "children"> {
  /** Accessible name; also shown as a tooltip. Required: a button with only an icon has no other name. */
  label: string;
  /** 34 by default; `sm` is the 30 px control height for dense bars. Both are 44 on phone. */
  size?: "sm" | "md";
  variant?: "ghost" | "secondary";
  /** Skip the tooltip (e.g. inside a menu trigger that has its own). */
  noTooltip?: boolean;
  /** The icon. */
  children: ReactNode;
}

export function IconButton({ label, size = "md", variant = "ghost", noTooltip, className, children, type = "button", ...props }: IconButtonProps) {
  const button = (
    <button
      type={type}
      className={cn(
        // Transparent until hover: the icon alone marks the place, the fill only answers the pointer.
        "inline-flex shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg",
        "disabled:pointer-events-none disabled:opacity-50",
        variant === "secondary" && "border border-line-strong bg-surface",
        size === "sm" ? "size-control-sm" : "size-control-md",
        "max-md:size-control-touch pointer-coarse:size-control-touch",
        className,
      )}
      {...props}
      // After the spread so `label` is always the name, even if an aria-label sneaks in through a wrapper.
      aria-label={label}
    >
      {children}
    </button>
  );
  return noTooltip ? button : <Tooltip content={label}>{button}</Tooltip>;
}
