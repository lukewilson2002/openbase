import type { ComponentProps } from "react";
import { Select } from "@/components/ui/input";
import { cn } from "@/lib/cn";

/** The shared native select with a fixed width (the base `Select` always fills its row). */
export function InlineSelect({ width = "w-40", className, ...props }: ComponentProps<"select"> & { width?: string }) {
  return (
    <div className={cn("shrink-0", width)}>
      <Select className={className} {...props} />
    </div>
  );
}
