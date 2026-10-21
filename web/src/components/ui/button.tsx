import type { ComponentProps } from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/cn";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "soft" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "lg";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-fg hover:bg-primary-hover",
  // A creating action next to secondary buttons that should stand out less than solid primary.
  soft: "border border-primary/25 bg-primary-soft text-primary-text hover:bg-[color-mix(in_srgb,var(--primary)_18%,var(--surface))]",
  secondary: "border border-line-strong bg-surface text-fg hover:bg-hover",
  ghost: "text-fg hover:bg-hover",
  danger: "bg-danger text-danger-fg hover:bg-danger-hover",
  link: "text-primary-text underline-offset-2 hover:underline px-0",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 px-2.5 text-[0.8125rem] pointer-coarse:h-9",
  md: "h-8 gap-1.5 px-3 pointer-coarse:h-10",
  lg: "h-10 gap-2 px-4 text-[0.9375rem]",
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
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors",
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
