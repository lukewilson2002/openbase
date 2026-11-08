import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { IconButton } from "./icon-button";
import { usePresence } from "./use-presence";
import { Icon } from "./icon";

export type ToastVariant = "default" | "success" | "error";

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** 0 keeps the toast until dismissed. */
  durationMs?: number;
  /** A button on the toast ("Undo"); the toast closes when it is pressed. */
  action?: ToastAction;
  /** More buttons, after `action` ("Open" and "Undo" on a capture); each closes the toast too. */
  actions?: ToastAction[];
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem extends ToastOptions {
  id: number;
}

interface ToastContextValue {
  toast: (opts: ToastOptions) => void;
  /** Shorthand for an error toast from a thrown value. */
  error: (e: unknown, title?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((cur) => cur.filter((t) => t.id !== id)), []);

  const toast = useCallback((opts: ToastOptions) => {
    const id = nextId.current++;
    setItems((cur) => [...cur.slice(-3), { ...opts, id }]);
  }, []);

  const error = useCallback(
    (e: unknown, title = "Something went wrong") =>
      toast({ title, description: e instanceof Error ? e.message : undefined, variant: "error", durationMs: 8000 }),
    [toast],
  );

  const value = useMemo(() => ({ toast, error }), [toast, error]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/*
        Bottom-left on a desktop; on a phone across the bottom, above the tab bar (--bottom-nav-height, set by
        the bar) and the home indicator. The inner element is one polite live region that is always in the page,
        so a toast added to it is announced without taking the reader away from what they were doing (A11Y-4).
      */}
      <section
        aria-label="Notifications"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--bottom-nav-height)+env(safe-area-inset-bottom))] z-[70] p-4 md:right-auto md:w-[26rem]"
      >
        <div aria-live="polite" aria-relevant="additions" className="flex flex-col items-stretch gap-2">
          {items.map((t) => (
            <ToastView key={t.id} item={t} onDismiss={dismiss} />
          ))}
        </div>
      </section>
    </ToastContext.Provider>
  );
}

/** A toast that holds an Undo waits longer than a note does: reaching the button takes a moment. */
const DEFAULT_MS = 5000;
const DEFAULT_ACTION_MS = 8000;

/** One toast. The provider lays them out; the design reference page (`/__dev/design`) draws them where they can be looked at. */
export function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const { id } = item;
  const actions = [...(item.action ? [item.action] : []), ...(item.actions ?? [])];
  const durationMs = item.durationMs ?? (actions.length ? DEFAULT_ACTION_MS : DEFAULT_MS);
  const [leaving, setLeaving] = useState(false);
  // The clock stops while the pointer or keyboard is on the toast, so it cannot go while someone is reading it or reaching for Undo.
  const [held, setHeld] = useState(false);
  const presence = usePresence<HTMLDivElement>(!leaving);
  const close = useCallback(() => setLeaving(true), []);

  useEffect(() => {
    if (!durationMs || held || leaving) return;
    const t = setTimeout(close, durationMs);
    return () => clearTimeout(t);
  }, [durationMs, held, leaving, close]);

  // Once the leaving animation is over the toast leaves the list.
  useEffect(() => {
    if (leaving && !presence.mounted) onDismiss(id);
  }, [leaving, presence.mounted, id, onDismiss]);

  const Glyph = item.variant === "error" ? CircleAlert : item.variant === "success" ? CircleCheck : null;
  return (
    <div
      ref={presence.ref}
      data-state={presence.state}
      role={item.variant === "error" ? "alert" : "status"}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className={cn(
        "ob-rise-in pointer-events-auto flex w-full items-center gap-2 rounded-lg border bg-surface p-3 shadow-pop",
        item.variant === "error" ? "border-danger" : "border-line",
      )}
    >
      {Glyph && <Icon icon={Glyph} className={cn("mt-0.5", item.variant === "error" ? "text-danger" : "text-success")} />}
      <div className="min-w-0 flex-1">
        <p className="text-label font-medium">{item.title}</p>
        {item.description && <p className="mt-0.5 break-words text-meta text-muted">{item.description}</p>}
      </div>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={() => {
            close();
            a.onClick();
          }}
          className="-my-1 inline-flex min-h-control-sm shrink-0 items-center rounded-sm px-2 text-label font-medium text-primary-text hover:bg-hover max-md:min-h-control-touch pointer-coarse:min-h-control-touch"
        >
          {a.label}
        </button>
      ))}
      <IconButton label="Dismiss" size="sm" noTooltip onClick={close} className="-my-1 -mr-1 size-6 max-md:size-control-touch max-md:-my-2.5 pointer-coarse:size-control-touch pointer-coarse:-my-2.5">
        <Icon icon={X} />
      </IconButton>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

/** Like `useToast`, for components that may also render where no toast is shown (it answers null there). */
export function useToastIfAny(): ToastContextValue | null {
  return useContext(ToastContext);
}
