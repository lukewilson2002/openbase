import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { cn } from "@/lib/cn";
import { IconButton } from "./icon-button";
import { Sheet } from "./sheet";
import { useReturnFocus } from "./use-return-focus";

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
  /** `alertdialog` for a confirmation, which is read out as one and does not close on a tap outside it. */
  role?: "dialog" | "alertdialog";
  /** Whether a press outside the dialog closes it (yes, unless it asks for an answer). */
  dismissOnOutsidePress?: boolean;
  /** Takes the close button away, for a dialog whose own buttons are the way out. */
  hideClose?: boolean;
  /**
   * What the dialog becomes below the desktop breakpoint: a full-screen sheet (the default, for short
   * forms) or, for a question with two buttons, a bottom sheet that is only as tall as it needs to be.
   */
  phone?: "fullscreen" | "bottom";
  /** Replaces where focus goes when the dialog opens (the first field or button, by default). */
  onOpenAutoFocus?: (event: Event) => void;
  className?: string;
}

const widths = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-xl", xl: "max-w-3xl" };

/**
 * Modal dialog with title, optional description, body and footer, for confirmations and short forms.
 * Centered on a desktop; a full-screen sheet (or, for `phone="bottom"`, a bottom `Sheet`) below the 1024 px
 * breakpoint. Radix gives it the focus trap, Escape, and the return of focus to the control that opened it.
 */
export function Dialog(props: DialogProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  if (desktop) return <DesktopDialog {...props} />;
  if (props.phone === "bottom") {
    const { open, onOpenChange, title, description, children, footer, role, dismissOnOutsidePress, onOpenAutoFocus, className } = props;
    return (
      <Sheet
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={description}
        footer={footer}
        doneLabel={null}
        role={role}
        dismissOnOutsidePress={dismissOnOutsidePress}
        onOpenAutoFocus={onOpenAutoFocus}
        className={className}
      >
        {children}
      </Sheet>
    );
  }
  return <FullScreenDialog {...props} />;
}

/** The pieces both layouts share, in the order the layouts rely on: header, body, footer. */
function DialogParts({ title, description, children, footer, roomy, hideClose, fullScreen }: Pick<DialogProps, "title" | "description" | "children" | "footer" | "roomy" | "hideClose"> & { fullScreen?: boolean }) {
  // A dialog that is only a question has no rule under its title or above its buttons.
  const plain = !children;
  return (
    <>
      <div className={cn("flex items-start justify-between gap-4", roomy ? "items-center px-4 pt-4 sm:px-6 sm:pt-5" : cn("px-4 py-3", !plain && "border-b border-line"), fullScreen && "min-h-control-touch items-center pr-2")}>
        <div className="min-w-0">
          <D.Title className={roomy ? "text-xl font-bold" : "text-sheet"}>{title}</D.Title>
          {description ? (
            <D.Description className="mt-0.5 text-label text-muted">{description}</D.Description>
          ) : (
            <D.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</D.Description>
          )}
        </div>
        {!hideClose && (
          <D.Close asChild>
            <IconButton label="Close" size="sm" noTooltip className={cn(!fullScreen && "-mr-1.5", roomy && "-mr-2 size-10")}>
              <X aria-hidden className={roomy ? "size-[18px]" : "size-4"} />
            </IconButton>
          </D.Close>
        )}
      </div>
      {children ? <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", roomy ? "px-4 pb-5 pt-4 sm:px-6 sm:pb-6" : "px-4 py-4")}>{children}</div> : null}
      {footer && (
        <div className={cn("flex flex-wrap justify-end gap-2 px-4 py-3", !plain && "border-t border-line", fullScreen && "pb-[max(0.75rem,env(safe-area-inset-bottom))]")}>{footer}</div>
      )}
    </>
  );
}

function DesktopDialog({ open, onOpenChange, size = "md", roomy = false, role, dismissOnOutsidePress = true, onOpenAutoFocus, className, ...parts }: DialogProps) {
  const returnFocus = useReturnFocus();
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="ob-fade-in fixed inset-0 z-50 bg-overlay" />
        <D.Content
          // Only when asked for: an explicit undefined would replace the role Radix gives the content.
          {...(role ? { role } : {})}
          onInteractOutside={(e) => {
            if (!dismissOnOutsidePress) e.preventDefault();
          }}
          onCloseAutoFocus={returnFocus.onCloseAutoFocus}
          onOpenAutoFocus={(e) => {
            returnFocus.noteOpener();
            onOpenAutoFocus?.(e);
          }}
          className={cn(
            "ob-dialog-in fixed left-1/2 top-1/2 z-50 flex max-h-[min(90dvh,48rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-surface shadow-pop",
            widths[size],
            roomy && "rounded-xl border-0",
            className,
          )}
        >
          <DialogParts roomy={roomy} title={parts.title} description={parts.description} footer={parts.footer} hideClose={parts.hideClose}>{parts.children}</DialogParts>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Below the desktop breakpoint a dialog takes the whole screen, above the on-screen keyboard (PH-3, PH-5). */
function FullScreenDialog({ open, onOpenChange, roomy = false, role, dismissOnOutsidePress = true, onOpenAutoFocus, className, ...parts }: DialogProps) {
  const visible = useVisualViewport(open);
  const returnFocus = useReturnFocus();
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="ob-fade-in fixed inset-0 z-50 bg-overlay" />
        <D.Content
          // Only when asked for: an explicit undefined would replace the role Radix gives the content.
          {...(role ? { role } : {})}
          onInteractOutside={(e) => {
            if (!dismissOnOutsidePress) e.preventDefault();
          }}
          onCloseAutoFocus={returnFocus.onCloseAutoFocus}
          onOpenAutoFocus={(e) => {
            returnFocus.noteOpener();
            onOpenAutoFocus?.(e);
          }}
          // Placed from the visual viewport: iOS Safari leaves the layout viewport at full height under the keyboard.
          style={{ top: visible.top, height: visible.height }}
          className={cn("ob-sheet-in fixed inset-x-0 z-50 flex flex-col bg-surface outline-none", className)}
        >
          <DialogParts roomy={roomy} fullScreen title={parts.title} description={parts.description} footer={parts.footer} hideClose={parts.hideClose}>{parts.children}</DialogParts>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
