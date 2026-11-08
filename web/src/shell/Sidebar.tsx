/**
 * The frames the sidebar's content (`SidebarContent`) sits in: the docked, resizable column of a desktop
 * (a `nav` landmark, NAV-2) and the drawer of a phone (until the Collections tab replaces it, NAV-7), plus
 * the layout of the content itself: pinned rows above, a scrolling middle, pinned rows below.
 */
import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { ChevronLeft, X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { useScrollEdges } from "@/hooks/useScrollEdges";
import { cn } from "@/lib/cn";
import { SIDEBAR_MAX, SIDEBAR_MIN, clampWidth } from "./sidebarPrefs";

const KEY_STEP = 16;

/** A soft shadow along one edge of the sidebar's scrolling part, where there is more to scroll. */
function ScrollShade({ edge, show }: { edge: "top" | "bottom"; show: boolean }) {
  return (
    <div
      aria-hidden
      data-scroll-shade={edge}
      data-show={show || undefined}
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 h-3 from-[var(--scroll-shade)] to-transparent opacity-0 transition-opacity duration-fast data-[show]:opacity-100",
        edge === "top" ? "top-0 bg-gradient-to-b" : "bottom-0 bg-gradient-to-t",
      )}
    />
  );
}

/**
 * The content's three regions (NAV-1): the switcher, search and top rows stay put above, the collections
 * scroll in the middle (with a shadow at either end where there is more), and the footer stays below.
 * With `scroll` off (a screen of its own, the phone's Collections tab) everything flows and the screen scrolls.
 */
export function SidebarLayout({ top, footer, children, scroll = true }: { top: ReactNode; footer: ReactNode; children: ReactNode; scroll?: boolean }) {
  const [scrollRef, edges] = useScrollEdges<HTMLDivElement>();
  return (
    <div className={cn("flex flex-col", scroll && "min-h-0 flex-1")}>
      <div className="shrink-0 px-3 pb-2 pt-3">{top}</div>
      {scroll ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ScrollShade edge="top" show={edges.above} />
          <div ref={scrollRef} data-sidebar-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
            {children}
          </div>
          <ScrollShade edge="bottom" show={edges.below} />
        </div>
      ) : (
        <div className="px-3 pb-3">{children}</div>
      )}
      <div className="shrink-0 border-t border-line px-3 py-2">{footer}</div>
    </div>
  );
}

export function DockedSidebar({
  id,
  width,
  onResize,
  children,
}: {
  id: string;
  width: number;
  /** `persist` is false while dragging, so storage is written once per drag rather than per pixel. */
  onResize: (width: number, persist: boolean) => void;
  children: ReactNode;
}) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width, last: width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = clampWidth(d.width + e.clientX - d.x);
    onResize(d.last, false);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    onResize(d.last, true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === "ArrowLeft" ? width - KEY_STEP : e.key === "ArrowRight" ? width + KEY_STEP : e.key === "Home" ? SIDEBAR_MIN : e.key === "End" ? SIDEBAR_MAX : null;
    if (next === null) return;
    e.preventDefault();
    onResize(next, true);
  };

  return (
    <nav id={id} aria-label="Main menu" style={{ width }} className="sticky top-0 flex h-dvh shrink-0 flex-col border-r border-line bg-chrome">
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize menu"
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className="group absolute inset-y-0 -right-1.5 z-10 flex w-3 cursor-col-resize touch-none justify-center focus-visible:outline-none"
      >
        <span aria-hidden className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-primary group-focus-visible:bg-ring group-active:bg-primary" />
      </div>
    </nav>
  );
}

export function SidebarDrawer({
  id,
  open,
  onOpenChange,
  returnFocus,
  notificationsPanel,
  onCloseNotifications,
  children,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
  /** The notifications, shown in place of the menu while the Notifications row is open. */
  notificationsPanel?: ReactNode;
  onCloseNotifications?: () => void;
  children: ReactNode;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="ob-fade-in fixed inset-0 z-40 bg-overlay" />
        <D.Content
          id={id}
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            // Back to the toggle even when the drawer was opened some other way, so a keyboard user
            // continues where the menu came from instead of at the top of the page.
            e.preventDefault();
            returnFocus.current?.focus();
          }}
          className="ob-drawer-in fixed inset-y-0 left-0 z-40 flex w-[min(19.5rem,calc(100vw-3rem))] flex-col bg-chrome pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] shadow-pop focus-visible:outline-none"
        >
          {/* With the notifications open, the way back takes the title's place, beside the close button. */}
          <div className="mx-2.5 flex min-h-14 shrink-0 items-center gap-0.5 border-b border-line py-1.5">
            {notificationsPanel ? (
              <>
                <D.Title className="sr-only">Menu</D.Title>
                <button type="button" onClick={onCloseNotifications} className="-ml-0.5 flex h-control-touch min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-left text-ui text-fg hover:bg-hover">
                  <Icon icon={ChevronLeft} className="text-muted" /> <span className="truncate">Back to the menu</span>
                </button>
              </>
            ) : (
              <D.Title className="flex-1 pl-1.5 text-ui font-semibold">Menu</D.Title>
            )}
            <D.Close asChild>
              <IconButton label="Close menu" noTooltip>
                <Icon icon={X} />
              </IconButton>
            </D.Close>
          </div>
          {notificationsPanel ? (
            <div className="flex min-h-0 flex-1 flex-col">{notificationsPanel}</div>
          ) : (
            <nav aria-label="Main menu" className="flex min-h-0 flex-1 flex-col">
              {children}
            </nav>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
