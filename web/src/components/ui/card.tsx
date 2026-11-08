import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export interface CardProps extends ComponentProps<"div"> {
  /** Inner padding; off when the content (a table, a list of rows) brings its own. */
  padded?: boolean;
}

/** A surface with a hairline border and no shadow (shadows are for things that float). Rounder on phone. */
export function Card({ padded = true, className, ...props }: CardProps) {
  return <div className={cn("rounded-lg border border-line bg-surface max-md:rounded-xl", padded && "p-4", className)} {...props} />;
}
