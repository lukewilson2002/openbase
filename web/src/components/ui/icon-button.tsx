import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./tooltip";

export interface IconButtonProps extends ComponentProps<"button"> {
  /** Accessible name; also shown as a tooltip. */
  label: string;
  size?: "sm" | "md";
  variant?: "ghost" | "secondary";
  /** Skip the tooltip (e.g. inside a menu trigger that has its own). */
  noTooltip?: boolean;
}

export function IconButton({ label, size = "md", variant = "ghost", noTooltip, className, children, type = "button", ...props }: IconButtonProps) {
  const button = (
    <button
      type={type}
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg",
        "disabled:pointer-events-none disabled:opacity-50",
        variant === "secondary" && "border border-line-strong bg-surface",
        size === "sm" ? "size-7 pointer-coarse:size-9" : "size-8 pointer-coarse:size-10",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
  return noTooltip ? button : <Tooltip content={label}>{button}</Tooltip>;
}
