/**
 * A small "?" button that explains something in a few words: the words show while a mouse rests on
 * it, and stay on a click; on a touch screen a tap shows them and a tap anywhere else hides them.
 * It is a popover rather than a tooltip because a tooltip never opens on a tap.
 */
import { useRef, useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { cn } from "@/lib/cn";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/** How long the words stay after the mouse leaves, so it can move onto them (to select or read them). */
const LEAVE_MS = 150;

export function HelpTip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  // Opened by a click (or tap): it stays until dismissed, rather than closing when the mouse leaves.
  const pinned = useRef(false);
  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hover = (on: boolean) => (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || pinned.current) return;
    clearTimeout(leave.current);
    if (on) setOpen(true);
    else leave.current = setTimeout(() => setOpen(false), LEAVE_MS);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        pinned.current = next;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onPointerEnter={hover(true)}
          onPointerLeave={hover(false)}
          onClick={(e) => {
            // A hover already opened it: the click pins it open instead of toggling it shut.
            if (open && !pinned.current) {
              e.preventDefault();
              pinned.current = true;
            }
          }}
          className={cn(
            "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg data-[state=open]:text-fg pointer-coarse:size-10",
            className,
          )}
        >
          <CircleHelp aria-hidden className="size-[1.125rem]" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        onPointerEnter={hover(true)}
        onPointerLeave={hover(false)}
        // A hover is not a reason to move the focus; a click or a tap is.
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-auto max-w-[min(20rem,calc(100vw-1rem))] text-[0.8125rem] leading-relaxed text-muted"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
