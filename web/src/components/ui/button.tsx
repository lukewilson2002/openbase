import type { ComponentProps } from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/cn";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "lg";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-fg hover:bg-primary-hover",
  secondary: "border border-line-strong bg-surface text-fg hover:bg-hover",
  ghost: "text-fg hover:bg-hover",
  danger: "bg-danger text-danger-fg hover:bg-danger-hover",
  link: "text-primary underline-offset-2 hover:underline px-0",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 px-2.5 text-[0.8125rem]",
  md: "h-8 gap-1.5 px-3",
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
