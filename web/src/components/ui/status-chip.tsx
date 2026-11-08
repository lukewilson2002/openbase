import type { ComponentProps } from "react";
import { choiceClass } from "@/lib/colors";
import { cn } from "@/lib/cn";

export interface StatusChipProps extends ComponentProps<"span"> {
  /** A choice colour from the shared palette; the `.choice-<hue>` pastel pair supplies fill and text. */
  hue?: string | null;
}

/** A value of a status or select property as a pill: the choice's own hue pair, so the colour means the value. */
export function StatusChip({ hue, className, children, ...props }: StatusChipProps) {
  return (
    <span className={cn(choiceClass(hue), "inline-flex max-w-full items-center rounded-pill px-2 py-px text-meta font-medium", className)} {...props}>
      <span className="truncate">{children}</span>
    </span>
  );
}
