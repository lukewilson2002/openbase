import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { cn } from "@/lib/cn";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons row rendered below the content. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

const widths = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-xl", xl: "max-w-3xl" };

/** Modal dialog with title, optional description, body and footer. */
export function Dialog({ open, onOpenChange, title, description, children, footer, size = "md", className }: DialogProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="og-fade-in fixed inset-0 z-50 bg-overlay" />
        <D.Content
          className={cn(
            "og-pop-in fixed left-1/2 top-1/2 z-50 flex max-h-[min(90dvh,48rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-surface shadow-pop",
            widths[size],
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <D.Title className="text-base font-semibold">{title}</D.Title>
              {description ? (
                <D.Description className="mt-0.5 text-[0.8125rem] text-muted">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</D.Description>
              )}
            </div>
            <D.Close
              aria-label="Close"
              className="-mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
            >
              <X aria-hidden className="size-4" />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
