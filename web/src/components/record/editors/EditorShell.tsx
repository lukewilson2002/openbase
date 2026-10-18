/**
 * Chrome for pop-over editors (selects, links, users, dates, attachments).
 *
 * - `cell`: the grid's overlay is just an anchor over the cell; the editor panel opens below it
 *   in a portal. The panel carries `click-outside-ignore` so Glide does not treat clicks inside
 *   it as clicks outside the overlay. Clicking elsewhere commits what was reported through
 *   `onChange` (Glide's behaviour); Escape cancels.
 * - `form`: a button showing the current value opens the panel; closing it reports `onDismiss`. In an
 *   edit session (see session.ts) the panel starts open and its closing is reported to the session.
 *
 * `children` may be a function receiving `close`, which closes the pop-over (a no-op in the
 * grid, where committing closes Glide's overlay).
 */
import { useState, type ReactNode } from "react";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { useEditSession } from "./session";

export interface EditorShellProps {
  variant: "cell" | "form";
  /** Screen rectangle of the grid cell (cell variant). */
  target?: { width: number; height: number };
  /** Button label content (form variant). */
  trigger?: ReactNode;
  triggerLabel?: string;
  onCancel: () => void;
  /** Form variant: the pop-over closed (by Escape or an outside click). */
  onDismiss?: () => void;
  width?: number;
  children: ReactNode | ((api: { close: () => void }) => ReactNode);
  className?: string;
}

export function EditorShell({ variant, target, trigger, triggerLabel, onCancel, onDismiss, width = 320, children, className }: EditorShellProps) {
  const session = useEditSession();
  const [open, setOpen] = useState(variant === "form" && !!session?.openOnMount);
  const close = variant === "cell" ? () => {} : () => setOpen(false);
  const body = typeof children === "function" ? children({ close }) : children;
  const content = (
    <PopoverContent
      align="start"
      sideOffset={variant === "cell" ? 2 : 4}
      collisionPadding={8}
      style={{ width }}
      className={cn("click-outside-ignore flex max-h-[min(24rem,var(--ob-avail))] flex-col p-0", className)}
      onEscapeKeyDown={(e) => {
        if (variant === "cell") {
          e.preventDefault();
          onCancel();
        }
      }}
      onInteractOutside={(e) => {
        // Glide decides what an outside click means in the grid.
        if (variant === "cell") e.preventDefault();
      }}
      onOpenAutoFocus={(e) => {
        // Let the panel's own search input take focus.
        const first = (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-autofocus], input, textarea, button");
        if (first) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      {body}
    </PopoverContent>
  );

  if (variant === "cell") {
    return (
      <Popover open modal={false}>
        <PopoverAnchor asChild>
          <div style={{ width: target?.width ?? 0, height: target?.height ?? 0 }} aria-hidden />
        </PopoverAnchor>
        {content}
      </Popover>
    );
  }
  return (
    <Popover
      modal={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          onDismiss?.();
          session?.popupClosed();
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={triggerLabel}
          className="flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-left text-[0.8125rem] hover:border-faint focus-visible:border-ring"
        >
          {trigger}
        </button>
      </PopoverTrigger>
      {content}
    </Popover>
  );
}
