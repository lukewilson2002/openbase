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
  /** The larger, airier look of the redesigned dialogs (Share): bigger title, no rule under it, more padding. */
  roomy?: boolean;
  className?: string;
}

const widths = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-xl", xl: "max-w-3xl" };

/** Modal dialog with title, optional description, body and footer. */
export function Dialog({ open, onOpenChange, title, description, children, footer, size = "md", roomy = false, className }: DialogProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="ob-fade-in fixed inset-0 z-50 bg-overlay" />
        <D.Content
          className={cn(
            "ob-pop-in fixed left-1/2 top-1/2 z-50 flex max-h-[min(90dvh,48rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-surface shadow-pop",
            widths[size],
            roomy && "rounded-[18px] border-0 shadow-[0_20px_60px_rgb(15_20_30/0.3)]",
            className,
          )}
        >
          <div className={cn("flex items-start justify-between gap-4", roomy ? "items-center px-4 pt-4 sm:px-6 sm:pt-5" : "border-b border-line px-4 py-3")}>
            <div className="min-w-0">
              <D.Title className={roomy ? "text-xl font-bold" : "text-base font-semibold"}>{title}</D.Title>
              {description ? (
                <D.Description className="mt-0.5 text-[0.8125rem] text-muted">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</D.Description>
              )}
            </div>
            <D.Close
              aria-label="Close"
              className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg",
                roomy ? "-mr-2 size-10 rounded-[10px]" : "-mr-1 size-7 pointer-coarse:-my-1.5 pointer-coarse:size-10",
              )}
            >
              <X aria-hidden className={roomy ? "size-[18px]" : "size-4"} />
            </D.Close>
          </div>
          <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", roomy ? "px-4 pb-5 pt-4 sm:px-6 sm:pb-6" : "px-4 py-4")}>{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
