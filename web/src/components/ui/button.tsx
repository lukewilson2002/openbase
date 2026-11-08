import type { ComponentProps } from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/cn";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "soft" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "lg";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary font-semibold text-primary-fg hover:bg-primary-hover",
  // Save as view and other creating actions that should stand out less than solid primary.
  soft: "border border-primary-soft-line bg-primary-soft font-medium text-primary-ink hover:bg-[color-mix(in_srgb,var(--primary)_18%,var(--surface))]",
  secondary: "border border-line-strong bg-surface font-medium text-fg hover:bg-hover",
  ghost: "font-medium text-fg hover:bg-hover",
  danger: "bg-danger font-semibold text-danger-fg hover:bg-danger-hover",
  link: "font-medium text-primary-text underline underline-offset-2 hover:no-underline px-0",
};

// 30, 34 and 40 on desktop; anything tappable is 44 on phone (the compact layout) and on touch screens.
const sizes: Record<ButtonSize, string> = {
  sm: "h-control-sm gap-1.5 px-3 text-label max-md:h-control-touch pointer-coarse:h-control-touch",
  md: "h-control-md gap-1.5 px-3.5 text-ui max-md:h-control-touch pointer-coarse:h-control-touch",
  lg: "h-control-lg gap-2 px-4 text-ui max-md:h-control-touch pointer-coarse:h-control-touch",
};

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Render the child element (e.g. a router Link) with button styling. */
  asChild?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  asChild = false,
  className,
  disabled,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  const classes = cn(
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md transition-colors",
    "disabled:pointer-events-none disabled:opacity-50",
    variants[variant],
    variant !== "link" && sizes[size],
    className,
  );
  if (asChild) {
    return (
      <Slot.Root className={classes} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading && <Spinner className="size-3.5 text-current" label="Working" />}
      {children}
    </button>
  );
}
