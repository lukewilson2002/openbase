import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { IconButton } from "./icon-button";
import { usePresence } from "./use-presence";

export interface SidePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Buttons in the header, before the close button. */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * The desktop right panel, 360 px (comments, history). It sits in the page's layout and pushes the page
 * aside rather than covering it, so it is not modal: the page stays usable. Opening it moves focus into it;
 * Escape, or its close button, closes it and returns focus to the control that opened it (A11Y-1). On a phone
 * the same content goes in a `Sheet` or a full-screen `Dialog`.
 */
export function SidePanel({ open, onOpenChange, title, actions, children, className }: SidePanelProps) {
  const titleId = useId();
  const presence = usePresence<HTMLElement>(open);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    presence.ref.current?.focus({ preventScroll: true });
    return () => {
      const panel = presence.ref.current;
      const from = opener.current;
      opener.current = null;
      // Focus that was inside the panel (or lost with it) goes back to where it came from; focus the person moved elsewhere stays.
      const active = document.activeElement;
      if (from?.isConnected && (!active || active === document.body || panel?.contains(active))) from.focus({ preventScroll: true });
    };
    // presence.ref is a stable ref object.
  }, [open, presence.ref]);

  if (!presence.mounted) return null;
  return (
    <aside
      ref={presence.ref}
      data-state={presence.state}
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(e) => {
        // A popover or menu inside the panel closes first: it has already handled (and cancelled) the key.
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation();
          onOpenChange(false);
        }
      }}
      className={cn("ob-slide-in flex h-full w-panel shrink-0 flex-col border-l border-line bg-surface outline-none", className)}
    >
      <header className="flex min-h-control-touch shrink-0 items-center gap-1 border-b border-line pl-4 pr-2">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sheet">
          {title}
        </h2>
        {actions}
        <IconButton label={`Close ${title.toLowerCase()}`} noTooltip onClick={() => onOpenChange(false)}>
          <X aria-hidden className="size-4" />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </aside>
  );
}
