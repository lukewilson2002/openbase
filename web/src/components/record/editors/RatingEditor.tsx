/** Rating (stars or hearts) and checkbox editors. */
import { useEffect, useRef, useState } from "react";
import { Heart, Star } from "lucide-react";
import type { Field } from "@/api/types";
import { cn } from "@/lib/cn";
import { ratingColor } from "@/lib/cells/palette";
import type { FieldEditorCallbacks } from "./env";

export interface RatingEditorProps extends FieldEditorCallbacks {
  field: Field;
  value: unknown;
  variant: "cell" | "form";
  /** No box around the stars (see FieldEditor). */
  bare?: boolean;
  /** Character typed to start the edit (cell variant): a digit is the rating. */
  initialText?: string;
}

export function RatingEditor({ field, value, variant, bare, initialText, onChange, onCommit, onCancel }: RatingEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const max = field.type === "rating" ? field.options.max : 0;
  // In the grid the rating is a draft until the edit ends (Enter, Tab or a click elsewhere), so the arrows can
  // step it; in a form every change is saved as it is made.
  const [draft, setDraft] = useState<number | undefined>(() => (variant === "cell" && initialText && /^[0-9]$/.test(initialText) ? Math.min(Number(initialText), max) : undefined));
  // The typed digit that opened the editor is the rating, and the grid is told so that leaving the cell keeps it.
  const typed = useRef(draft);
  useEffect(() => {
    if (typed.current !== undefined) onChange?.({ json: typed.current || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (field.type !== "rating") return null;
  const { icon, color } = field.options;
  const current = draft ?? (typeof value === "number" ? value : 0);
  const tint = ratingColor(color);
  const Icon = icon === "heart" ? Heart : Star;
  /** A click on a star: the one that is the rating already clears it. */
  const set = (n: number) => onCommit({ json: n === current ? null : n });
  /** A key sets the rating without ending the edit in the grid. */
  const step = (n: number) => {
    const next = Math.max(0, Math.min(max, n));
    if (variant === "cell") {
      setDraft(next);
      onChange?.({ json: next || null });
    } else onCommit({ json: next || null });
  };

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={field.name}
      tabIndex={0}
      autoFocus={variant === "cell"}
      onKeyDown={(e) => {
        const arrow = e.key === "ArrowRight" || e.key === "ArrowLeft";
        if (e.key === "Escape") onCancel();
        else if (/^[0-9]$/.test(e.key)) step(Number(e.key));
        else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          onCommit({ json: current || null }, variant === "cell" ? [0, e.shiftKey ? -1 : 1] : undefined);
        } else if (e.key === "Tab" && variant === "cell") {
          e.preventDefault();
          e.stopPropagation();
          onCommit({ json: current || null }, [e.shiftKey ? -1 : 1, 0]);
        } else if (arrow) {
          // The arrows step the rating; the overlay of the grid stays open under them.
          e.preventDefault();
          e.stopPropagation();
          step(current + (e.key === "ArrowRight" ? 1 : -1));
        }
      }}
      className={cn("flex items-center gap-1 rounded-sm bg-surface px-2 py-1", variant === "cell" ? "border-2 border-primary shadow-pop" : bare ? "min-h-8 rounded-md border border-transparent bg-transparent pointer-coarse:min-h-11" : "min-h-8 border border-line-strong rounded-md")}
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
    <label className="flex min-h-8 w-full items-center gap-2 text-[0.8125rem] pointer-coarse:min-h-11">
      <input type="checkbox" checked={on} onChange={(e) => onCommit({ json: e.target.checked ? true : null })} className="size-4 accent-[var(--primary)]" />
      <span className="text-muted">{on ? "Checked" : "Unchecked"}</span>
      <span className="sr-only">{field.name}</span>
    </label>
  );
}
