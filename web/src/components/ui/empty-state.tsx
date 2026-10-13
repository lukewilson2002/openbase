import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-2 px-4 py-10 text-center", className)}>
      {icon && <div className="mb-1 rounded-full bg-subtle p-3 text-muted [&>svg]:size-6">{icon}</div>}
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="max-w-md text-[0.8125rem] text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
