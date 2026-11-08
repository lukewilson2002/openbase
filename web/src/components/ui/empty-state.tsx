import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  /** One sentence on what goes here. */
  title: string;
  /** The one action that fills it (a Button). */
  action?: ReactNode;
  /** A line of detail under the title, for the few places that need to explain why. */
  description?: ReactNode;
  /** @deprecated Icons mark actions, not places or states (DL-4); drawn small and muted until the screens that pass one are rebuilt. */
  icon?: ReactNode;
  className?: string;
}

/** What a place shows when it holds nothing: a sentence and one primary action, no illustration. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center gap-2 px-4 py-10 text-center", className)}>
      {icon && <div className="text-faint [&>svg]:size-5">{icon}</div>}
      <h3 className="text-h3">{title}</h3>
      {description && <p className="max-w-md text-label text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
