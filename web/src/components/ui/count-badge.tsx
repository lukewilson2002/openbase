import { cn } from "@/lib/cn";

/** Hidden from assistive technology: the button it sits on carries the count in its name ("Comments, 3"). */
export function CountBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span aria-hidden className={cn("num pointer-events-none absolute -right-0.5 -top-0.5 min-w-4 rounded-pill bg-primary px-1 text-center text-meta font-semibold leading-4 text-primary-fg", className)}>
      {count > 99 ? "99+" : count}
    </span>
  );
}
