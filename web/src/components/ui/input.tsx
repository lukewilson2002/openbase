import { useId, type ComponentProps, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

const control =
  "w-full rounded-md border border-line-strong bg-surface px-2.5 text-fg placeholder:text-faint " +
  "transition-colors hover:border-faint focus-visible:border-ring focus-visible:outline-2 focus-visible:-outline-offset-1 " +
  "disabled:cursor-not-allowed disabled:bg-subtle disabled:opacity-70 aria-[invalid=true]:border-danger";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(control, "h-8", className)} {...props} />;
}

export function Textarea({ className, rows = 3, ...props }: ComponentProps<"textarea">) {
  return <textarea rows={rows} className={cn(control, "min-h-16 py-1.5", className)} {...props} />;
}

/** Native select (accessible, mobile-friendly, handles long lists such as time zones). */
export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <span className="relative block w-full">
      <select className={cn(control, "h-8 appearance-none pr-8", className)} {...props}>
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted" />
    </span>
  );
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Render-prop receives the generated id and aria attributes for the control. */
  children: (ctl: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
  className?: string;
}

/** Label + control + hint/error wrapper that wires ids and ARIA attributes. */
export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-[0.8125rem] font-medium text-fg">
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {error ? (
        <p id={`${id}-err`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
