import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, X } from "lucide-react";
import { cn } from "@/lib/cn";

export type ToastVariant = "default" | "success" | "error";

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** 0 keeps the toast until dismissed. */
  durationMs?: number;
}

interface ToastItem extends ToastOptions {
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
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {items.map((t) => (
          <ToastView key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const { id, durationMs = 5000 } = item;
  useEffect(() => {
    if (!durationMs) return;
    const t = setTimeout(() => onDismiss(id), durationMs);
    return () => clearTimeout(t);
  }, [id, durationMs, onDismiss]);

  const Icon = item.variant === "error" ? CircleAlert : item.variant === "success" ? CircleCheck : null;
  return (
    <div
      role={item.variant === "error" ? "alert" : "status"}
      className={cn(
        "ob-slide-in pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-lg border bg-surface p-3 shadow-pop",
        item.variant === "error" ? "border-danger" : "border-line",
      )}
    >
      {Icon && <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", item.variant === "error" ? "text-danger" : "text-success")} />}
      <div className="min-w-0 flex-1">
        <p className="text-[0.8125rem] font-medium">{item.title}</p>
        {item.description && <p className="mt-0.5 break-words text-xs text-muted">{item.description}</p>}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(id)}
        className="-m-1 inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
