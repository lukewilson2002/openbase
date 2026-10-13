/** Rating (stars or hearts) and checkbox editors. */
import { useRef } from "react";
import { Heart, Star } from "lucide-react";
import type { Field } from "@/api/types";
import { cn } from "@/lib/cn";
import { ratingColor } from "@/lib/cells/palette";
import type { FieldEditorCallbacks } from "./env";

export interface RatingEditorProps extends FieldEditorCallbacks {
  field: Field;
  value: unknown;
  variant: "cell" | "form";
}

export function RatingEditor({ field, value, variant, onCommit, onCancel }: RatingEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  if (field.type !== "rating") return null;
  const { max, icon, color } = field.options;
  const current = typeof value === "number" ? value : 0;
  const tint = ratingColor(color);
  const Icon = icon === "heart" ? Heart : Star;
  const set = (n: number) => onCommit({ json: n === current ? null : n });

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={field.name}
      tabIndex={0}
      autoFocus={variant === "cell"}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
        else if (/^[0-9]$/.test(e.key)) onCommit({ json: Math.min(Number(e.key), max) || null });
        else if (e.key === "Enter") onCommit({ json: current || null }, [0, 1]);
        else if (e.key === "ArrowRight") set(Math.min(max, current + 1));
        else if (e.key === "ArrowLeft") onCommit({ json: current > 1 ? current - 1 : null });
      }}
      className={cn("flex items-center gap-1 rounded-sm bg-surface px-2 py-1", variant === "cell" ? "border-2 border-primary shadow-pop" : "min-h-8 border border-line-strong rounded-md")}
    >
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button key={n} type="button" role="radio" aria-checked={n === current} aria-label={`${n} of ${max}`} onClick={() => set(n)} className="rounded p-0.5 hover:bg-hover">
          <Icon aria-hidden className="size-5" style={{ color: tint }} fill={n <= current ? tint : "none"} />
        </button>
      ))}
    </div>
  );
}

export interface CheckboxEditorProps extends FieldEditorCallbacks {
  field: Field;
  value: unknown;
}

export function CheckboxEditor({ field, value, onCommit }: CheckboxEditorProps) {
  const on = value === true;
  return (
    <label className="flex min-h-8 items-center gap-2 text-[0.8125rem]">
      <input type="checkbox" checked={on} onChange={(e) => onCommit({ json: e.target.checked ? true : null })} className="size-4 accent-[var(--primary)]" />
      <span className="text-muted">{on ? "Checked" : "Unchecked"}</span>
      <span className="sr-only">{field.name}</span>
    </label>
  );
}
