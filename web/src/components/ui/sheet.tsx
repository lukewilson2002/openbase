import { useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from "react";
import { Dialog as D } from "radix-ui";
import { COARSE_POINTER, useMediaQuery } from "@/hooks/useMediaQuery";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { rubberBand, settleSheet, sheetSnapPoints } from "./sheet-snap";
import { usePortalHost } from "./portal-host";
import { useReturnFocus } from "./use-return-focus";

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Shown under the title. A sheet without one still gives assistive technology a description. */
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons row pinned below the content, above the keyboard. */
  footer?: ReactNode;
  /** The label of the button that closes the sheet; `null` for a sheet that has its own buttons (a confirmation). */
  doneLabel?: string | null;
  /** `alertdialog` for a confirmation: it does not close on a tap outside it. */
  role?: "dialog" | "alertdialog";
  /** Whether a tap on the dimmed screen closes the sheet (yes, unless it asks for an answer). */
  dismissOnOutsidePress?: boolean;
  /** Replaces where focus goes when the sheet opens (a `data-autofocus` element, else the first field or button). */
  onOpenAutoFocus?: (event: Event) => void;
  className?: string;
}

/** The sheet never reaches the very top of the screen, so the page behind it still shows. */
const TOP_GAP = 40;
/** A tap moves less than this; more is a scroll or a swipe that happened to end on the dimmed screen. */
const TAP_SLOP = 10;
/** The finger's speed is read over this window before it lifts. */
const VELOCITY_WINDOW_MS = 100;

interface DragState {
  pointerId: number;
  startY: number;
  startOffset: number;
  points: number[];
  samples: { t: number; y: number }[];
}

/**
 * The phone's bottom sheet (PH-3): radius 16 on top, a 36 x 5 grab handle, a title and a Done button, over
 * the dimmed screen. Hold the handle or the title and the sheet follows the finger; on release it eases to
 * the nearest resting point (half the screen when it is tall enough to have one, full, or closed), using
 * how fast the finger was moving. Radix supplies the focus trap, Escape, and the return of focus to
 * whatever opened it. With reduced motion it fades for 120 ms instead of sliding (styles/index.css).
 */
export function Sheet({ open, onOpenChange, title, description, children, footer, doneLabel = "Done", role, dismissOnOutsidePress = true, onOpenAutoFocus, className }: SheetProps) {
  const coarse = useMediaQuery(COARSE_POINTER);
  const visible = useVisualViewport(open);
  const content = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const returnFocus = useReturnFocus(open);
  const host = usePortalHost();
  const drag = useRef<DragState | null>(null);
  const tapStart = useRef<{ x: number; y: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  // A drag past the closed point asked the owner to close; see below.
  const [closeAsked, setCloseAsked] = useState(false);

  // The sheet is left where the finger let go so the exit animation carries on from there. If the owner
  // refuses the close (a confirmation that is busy), `open` is still true once its update has landed in
  // the same batch as this one, and the sheet returns instead of staying off the screen.
  if (closeAsked) {
    setCloseAsked(false);
    if (open) setOffset(0);
  }

  // Each opening starts at the open position, not wherever the last one was let go.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOffset(0);
  }

  // Sized and placed from the visual viewport: iOS Safari keeps the layout viewport at full height under
  // the keyboard, so a sheet fixed to `bottom: 0` would sit behind it (see also IconPicker).
  const maxHeight = Math.max(0, visible.height - TOP_GAP);
  const keyboard = typeof window === "undefined" ? 0 : Math.max(0, Math.round(window.innerHeight - (visible.top + visible.height)));

  const currentOffset = (clientY: number, d: DragState) => rubberBand(d.startOffset + clientY - d.startY);

  const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // The Done button and anything else in the header keep their own taps.
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    const height = content.current?.offsetHeight ?? 0;
    drag.current = { pointerId: e.pointerId, startY: e.clientY, startOffset: offset, points: sheetSnapPoints(height, visible.height), samples: [{ t: e.timeStamp, y: e.clientY }] };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onDragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    d.samples = [...d.samples.filter((s) => e.timeStamp - s.t <= VELOCITY_WINDOW_MS), { t: e.timeStamp, y: e.clientY }];
    setOffset(currentOffset(e.clientY, d));
  };
  const onDragEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    const first = d.samples[0];
    const dt = first ? e.timeStamp - first.t : 0;
    // A cancelled gesture (the system took the touch) settles where it is, without a flick.
    const velocity = e.type === "pointercancel" || !first || dt <= 0 ? 0 : (e.clientY - first.y) / dt;
    const from = currentOffset(e.clientY, d);
    const target = settleSheet({ offset: from, velocity, points: d.points });
    const closed = d.points[d.points.length - 1] ?? 0;
    if (closed > 0 && target >= closed) {
      // The exit animation carries on from the dragged position (the inline offset stays), so it does not jump.
      setOffset(from);
      setCloseAsked(true);
      onOpenChange(false);
    } else {
      setOffset(target);
    }
  };

  // iOS Safari sends no click for a tap on an element with no click listener of its own, and React listens on
  // <body> for portals, which iOS ignores; so a tap on the dimmed screen has to be read from the touch itself.
  const onOverlayTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0];
    tapStart.current = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onOverlayTouchEnd = (e: ReactTouchEvent) => {
    const start = tapStart.current;
    const t = e.changedTouches[0];
    tapStart.current = null;
    if (!dismissOnOutsidePress || !start || !t || Math.hypot(t.clientX - start.x, t.clientY - start.y) > TAP_SLOP) return;
    // Stops the late click from landing on whatever is under the closed sheet.
    e.preventDefault();
    onOpenChange(false);
  };

  return (
    <D.Root open={open} onOpenChange={onOpenChange} modal={!host.inline}>
      <D.Portal container={host.container}>
        <D.Overlay className="ob-fade-in fixed inset-0 z-50 bg-overlay" onTouchStart={onOverlayTouchStart} onTouchEnd={onOverlayTouchEnd} />
        <D.Content
          ref={content}
          // Only when asked for: an explicit undefined would replace the role Radix gives the content.
          {...(role ? { role } : {})}
          onInteractOutside={(e) => {
            if (!dismissOnOutsidePress) e.preventDefault();
          }}
          onCloseAutoFocus={returnFocus.onCloseAutoFocus}
          onOpenAutoFocus={(e) => {
            returnFocus.noteOpener();
            if (host.inline) return e.preventDefault();
            if (onOpenAutoFocus) return onOpenAutoFocus(e);
            e.preventDefault();
            // A finger on a text field would raise the keyboard over the sheet it just opened.
            const first = coarse ? null : body.current?.querySelector<HTMLElement>("[data-autofocus], input, textarea, select, button, a[href], [tabindex]:not([tabindex='-1'])");
            (first ?? content.current)?.focus();
          }}
          tabIndex={-1}
          className={cn("ob-sheet-in fixed inset-x-0 z-50 mx-auto flex w-full max-w-lg flex-col overflow-hidden rounded-t-xl border border-b-0 border-line bg-surface shadow-pop outline-none", className)}
          style={{
            bottom: keyboard,
            maxHeight,
            transform: offset ? `translateY(${offset}px)` : undefined,
            transition: dragging ? "none" : "transform var(--duration-slow) var(--ease-enter)",
          }}
        >
          {/* The part that can be held: the handle and the title row. */}
          <div className="shrink-0 touch-none select-none" onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd} data-testid="sheet-drag-zone">
            <div aria-hidden className="mx-auto mt-2 h-1.25 w-9 rounded-pill bg-line-strong" />
            <div className="flex min-h-control-touch items-center gap-2 pl-4 pr-2">
              <D.Title className="min-w-0 flex-1 truncate text-sheet">{title}</D.Title>
              {doneLabel !== null && (
                <D.Close asChild>
                  <Button variant="ghost" className="text-primary-text">
                    {doneLabel}
                  </Button>
                </D.Close>
              )}
            </div>
          </div>
          {description ? <D.Description className="shrink-0 px-4 pb-2 text-label text-muted">{description}</D.Description> : <D.Description className="sr-only">{typeof title === "string" ? title : "Sheet"}</D.Description>}
          <div ref={body} className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4", footer ? "pb-4" : "pb-[max(1rem,env(safe-area-inset-bottom))]")}>
            {children}
          </div>
          {footer && <div className="flex shrink-0 gap-2 border-t border-line px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 [&>*]:flex-1">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
