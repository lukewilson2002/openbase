import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { NavLink } from "react-router";
import { X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { cn } from "@/lib/cn";
import { ProfileMenu } from "./ProfileMenu";
import { SIDEBAR_MAX, SIDEBAR_MIN, clampWidth } from "./sidebarPrefs";

const KEY_STEP = 16;

function SidebarBody({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">{children}</div>
      {footer && <div className="flex flex-col gap-0.5 border-t border-line px-2 py-2">{footer}</div>}
      <div className="border-t border-line p-2">
        <ProfileMenu />
      </div>
    </>
  );
}

export function DockedSidebar({
  id,
  width,
  onResize,
  footer,
  children,
}: {
  id: string;
  width: number;
  /** `persist` is false while dragging, so storage is written once per drag rather than per pixel. */
  onResize: (width: number, persist: boolean) => void;
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
      <SidebarBody footer={footer}>{children}</SidebarBody>
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
  footer,
  children,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
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
          className="ob-drawer-in fixed inset-y-0 left-0 z-40 flex w-[min(20rem,calc(100vw-3rem))] flex-col bg-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] shadow-pop focus-visible:outline-none"
        >
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line pl-4 pr-2">
            <D.Title className="text-[0.9375rem] font-semibold">Menu</D.Title>
            <D.Close aria-label="Close menu" className="inline-flex size-10 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg">
              <X aria-hidden className="size-5" />
            </D.Close>
          </div>
          <nav aria-label="Main menu" className="flex min-h-0 flex-1 flex-col">
            <SidebarBody footer={footer}>{children}</SidebarBody>
          </nav>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// ---- building blocks for the menu content --------------------------------------------------

export function SidebarSection({ title, action, children, className }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-0.5", className)} aria-label={title}>
      {(title || action) && (
        <div className="flex h-8 items-center justify-between gap-2 pl-2">
          {title && <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

const itemClass =
  "flex h-9 min-w-0 items-center gap-2.5 rounded-md px-2 text-[0.8125rem] font-medium text-fg no-underline transition-colors hover:bg-hover pointer-coarse:h-11";
const activeClass = "bg-primary-soft text-fg hover:bg-primary-soft";

/** A menu link; it is highlighted (and `aria-current`) on its own page. */
export function SidebarLink({ to, icon, children, end = true, active, indent, className }: { to: string; icon?: ReactNode; children: ReactNode; end?: boolean; active?: boolean; indent?: boolean; className?: string }) {
  return (
    <NavLink
      to={to}
      end={end}
      aria-current={active === undefined ? undefined : active ? "page" : false}
      className={({ isActive }) => cn(itemClass, (active ?? isActive) && activeClass, indent && "pl-9", className)}
    >
      {icon && <span className="flex shrink-0 items-center text-muted [&>svg]:size-4">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </NavLink>
  );
}

export function SidebarButton({ icon, children, onClick, className }: { icon?: ReactNode; children: ReactNode; onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn(itemClass, "w-full text-left", className)}>
      {icon && <span className="flex shrink-0 items-center text-muted [&>svg]:size-4">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}
