import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { NavLink } from "react-router";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { useScrollEdges } from "@/hooks/useScrollEdges";
import { cn } from "@/lib/cn";
import { ProfileMenu } from "./ProfileMenu";
import { SIDEBAR_MAX, SIDEBAR_MIN, clampWidth } from "./sidebarPrefs";

const KEY_STEP = 16;

/** A soft shadow along one edge of the menu's scrolling part, where there is more to scroll. */
function ScrollShade({ edge, show }: { edge: "top" | "bottom"; show: boolean }) {
  return (
    <div
      aria-hidden
      data-scroll-shade={edge}
      data-show={show || undefined}
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 h-5 from-[var(--scroll-shade)] to-transparent opacity-0 transition-opacity duration-150 data-[show]:opacity-100",
        edge === "top" ? "top-0 bg-gradient-to-b" : "bottom-0 bg-gradient-to-t",
      )}
    />
  );
}

/**
 * The menu's column: the Inbox and Notifications rows, the page's own content and the footer links (Trash)
 * scroll together, so a long menu pushes the footer down instead of squeezing
 * the content between fixed rows; the footer still sits at the bottom of a short one. Only the
 * profile stays put. A shadow at either end shows there is more to scroll that way.
 */
function SidebarBody({ topRows, children, footer }: { topRows?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const [scrollRef, edges] = useScrollEdges<HTMLDivElement>();
  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScrollShade edge="top" show={edges.above} />
        <div ref={scrollRef} data-sidebar-scroll className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          <div className="flex-1 px-3 pb-3 pt-3">
            {topRows && <div className="mb-1.5">{topRows}</div>}
            {children}
          </div>
          {footer && <div className="flex flex-col gap-0.5 px-3 pb-2">{footer}</div>}
        </div>
        <ScrollShade edge="bottom" show={edges.below} />
      </div>
      <div className="mx-3 border-t border-line py-2">
        <ProfileMenu />
      </div>
    </>
  );
}

export function DockedSidebar({
  id,
  width,
  onResize,
  topRows,
  footer,
  children,
}: {
  id: string;
  width: number;
  /** `persist` is false while dragging, so storage is written once per drag rather than per pixel. */
  onResize: (width: number, persist: boolean) => void;
  /** The Inbox and Notifications rows above the page's own content. */
  topRows?: ReactNode;
  footer?: ReactNode;
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
    <nav id={id} aria-label="Main menu" style={{ width }} className="sticky top-14 flex h-[calc(100dvh-3.5rem)] shrink-0 flex-col border-r border-line bg-surface">
      <SidebarBody topRows={topRows} footer={footer}>
        {children}
      </SidebarBody>
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
  topRows,
  notificationsPanel,
  onCloseNotifications,
  footer,
  children,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
  topRows?: ReactNode;
  /** The notifications, shown in place of the menu while the Notifications row is open. */
  notificationsPanel?: ReactNode;
  onCloseNotifications?: () => void;
  footer?: ReactNode;
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
          className="ob-drawer-in fixed inset-y-0 left-0 z-40 flex w-[min(19.5rem,calc(100vw-3rem))] flex-col bg-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] shadow-pop focus-visible:outline-none"
        >
          <div className="mx-2.5 flex min-h-14 shrink-0 items-center gap-0.5 border-b border-line py-1.5">
            <D.Title className="flex-1 pl-1.5 text-[0.9375rem] font-semibold">Menu</D.Title>
            <D.Close aria-label="Close menu" className="inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] text-muted hover:bg-hover hover:text-fg">
              <X aria-hidden className="size-5" />
            </D.Close>
          </div>
          {notificationsPanel ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <button type="button" onClick={onCloseNotifications} className="mx-2.5 mt-1.5 flex h-11 items-center gap-1 self-start rounded-[10px] px-2 text-[0.9375rem] text-muted hover:bg-hover hover:text-fg">
                <ChevronLeft aria-hidden className="size-4" /> Back to the menu
              </button>
              {notificationsPanel}
            </div>
          ) : (
            <nav aria-label="Main menu" className="flex min-h-0 flex-1 flex-col">
              <SidebarBody topRows={topRows} footer={footer}>
                {children}
              </SidebarBody>
            </nav>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// ---- building blocks for the menu content --------------------------------------------------

export function SidebarSection({ title, action, children, className }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-0.5", className)} aria-label={title}>
      {(title || action) && <SidebarHeading action={action}>{title}</SidebarHeading>}
      {children}
    </section>
  );
}

/** A plain section heading ("Workspaces", "Tables") with an optional action (a +) at its end. */
export function SidebarHeading({ children, action }: { children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-9 items-center justify-between gap-2 pl-3 pr-1">
      {children && <h2 className="text-[0.8125rem] font-semibold tracking-normal text-muted">{children}</h2>}
      {action}
    </div>
  );
}

export const sidebarItemClass =
  "flex h-9 min-w-0 items-center gap-2.5 rounded-[10px] px-3 text-[0.875rem] text-fg no-underline transition-colors hover:bg-hover pointer-coarse:h-11";
export const sidebarActiveClass = "bg-primary-soft font-semibold text-primary-ink hover:bg-primary-soft";

/** A menu link; it is highlighted (and `aria-current`) on its own page. */
export function SidebarLink({
  to,
  icon,
  children,
  end = true,
  active,
  muted,
  className,
  iconClassName,
  onClick,
}: {
  to: string;
  icon?: ReactNode;
  children: ReactNode;
  end?: boolean;
  active?: boolean;
  /** Grey text, like the footer's links (Trash, Members) and a workspace's sub-items. */
  muted?: boolean;
  className?: string;
  iconClassName?: string;
  onClick?: () => void;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      aria-current={active === undefined ? undefined : active ? "page" : false}
      className={({ isActive }) => cn(sidebarItemClass, muted && "text-muted hover:text-fg", (active ?? isActive) && sidebarActiveClass, className)}
    >
      {icon && <span className={cn("flex shrink-0 items-center [&>svg]:size-[1.125rem]", iconClassName)}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </NavLink>
  );
}

export function SidebarButton({ icon, children, onClick, className }: { icon?: ReactNode; children: ReactNode; onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn(sidebarItemClass, "w-full text-left text-muted hover:text-fg", className)}>
      {icon && <span className="flex shrink-0 items-center [&>svg]:size-[1.125rem]">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

/** A tree row's "…" button: hidden until the row is hovered or the button focused, with a mouse; always there for a finger. */
export const rowActionClass =
  "absolute right-0.5 top-1/2 size-7 -translate-y-1/2 opacity-100 pointer-coarse:size-9 md:pointer-fine:opacity-0 md:pointer-fine:focus-visible:opacity-100 md:pointer-fine:group-hover/item:opacity-100 data-[state=open]:opacity-100";

/** The chevron at the start of a tree row: it folds the row's children and never navigates. */
export function RowChevron({ expanded, label, controls, onClick }: { expanded: boolean; label: string; controls: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      aria-label={label}
      className="inline-flex h-9 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg pointer-coarse:h-11"
    >
      <ChevronRight aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
    </button>
  );
}
