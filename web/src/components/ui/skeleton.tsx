import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/**
 * A loading placeholder in the shape of the content it stands for: size it with classes (`h-4 w-40`,
 * `size-8 rounded-pill`). Decorative, so hidden from assistive technology; the region that is loading says
 * so with `aria-busy` on its container. Pages use these where they used to show a spinner.
 */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div aria-hidden className={cn("ob-skeleton rounded-md", className)} {...props} />;
}

/** Several lines of text, the last one shorter. */
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", i === lines - 1 && lines > 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}
