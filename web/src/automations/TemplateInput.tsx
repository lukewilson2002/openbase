/**
 * Text input (or text area) for strings that may contain `{{...}}` placeholders, with an
 * "Insert data" menu that puts a token at the caret. Which tokens are offered comes from the
 * trigger and the action's position (`templateGroups`).
 */
import { useId, useRef, useState, type ReactNode } from "react";
import { Braces } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { bodyToken, insertToken, templateGroups, type TemplateContext } from "./templates";

export interface TemplateInputProps {
  value: string;
  onChange: (value: string) => void;
  ctx: TemplateContext;
  /** Accessible name of the text control; the menu button is named "Insert data into <label>". */
  label: string;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  mono?: boolean;
  id?: string;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
}

export function TemplateInput({ value, onChange, ctx, label, multiline, rows = 4, placeholder, mono, id, invalid, describedBy, className }: TemplateInputProps) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const selection = useRef<{ start: number | null; end: number | null }>({ start: null, end: null });
  const [open, setOpen] = useState(false);
  const remember = () => {
    const el = ref.current;
    if (el) selection.current = { start: el.selectionStart, end: el.selectionEnd };
  };

  const insert = (token: string) => {
    const next = insertToken(value, token, selection.current.start, selection.current.end);
    onChange(next.text);
    selection.current = { start: next.caret, end: next.caret };
    setOpen(false);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const common = {
    value,
    id,
    placeholder,
    "aria-label": id ? undefined : label,
    "aria-invalid": invalid ? (true as const) : undefined,
    "aria-describedby": describedBy,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
    onSelect: remember,
    onBlur: remember,
    className: cn("min-w-0 flex-1", mono && "font-mono text-xs"),
  };

  return (
    <div className={cn("flex items-start gap-1.5", className)}>
      {multiline ? <Textarea ref={ref} rows={rows} {...common} /> : <Input ref={ref} {...common} />}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="md" variant="secondary" aria-label={`Insert data into ${label}`} title="Insert data from the trigger or an earlier step" className="px-2">
            <Braces aria-hidden className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="max-h-80 w-80 overflow-y-auto p-1" onCloseAutoFocus={(e) => e.preventDefault()}>
          <TokenMenu ctx={ctx} onPick={insert} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function TokenMenu({ ctx, onPick }: { ctx: TemplateContext; onPick: (token: string) => void }) {
  const groups = templateGroups(ctx);
  const [path, setPath] = useState("");
  const pathId = useId();
  const token = bodyToken(path);
  return (
    <div role="menu" aria-label="Insert data" className="flex flex-col gap-2 text-[0.8125rem]">
      {groups.map((g) => (
        <section key={g.id} aria-label={g.label}>
          <h4 className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted">{g.label}</h4>
          {g.bodyPath ? (
            <div className="flex items-end gap-1.5 px-2 pb-1">
              <div className="min-w-0 flex-1">
                <label htmlFor={pathId} className="text-xs text-muted">
                  Path in the JSON body, e.g. order.items.0.sku
                </label>
                <Input id={pathId} value={path} onChange={(e) => setPath(e.target.value)} placeholder="customer.email" className="mt-0.5 h-7" />
              </div>
              <Button size="sm" variant="primary" disabled={!token} onClick={() => token && onPick(token)}>
                Insert
              </Button>
            </div>
          ) : (
            <ul>
              {g.tokens.map((t) => (
                <li key={t.token}>
                  <button type="button" role="menuitem" onClick={() => onPick(t.token)} className="flex w-full items-baseline justify-between gap-3 rounded px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none">
                    <span className="min-w-0 truncate">{t.label}</span>
                    <code className="shrink-0 truncate text-[0.6875rem] text-muted">{t.token}</code>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/** A labelled `TemplateInput` with hint and error text. */
export function TemplateField({ label, hint, error, ...rest }: Omit<TemplateInputProps, "id" | "invalid" | "describedBy"> & { hint?: ReactNode; error?: ReactNode }) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(ctl) => <TemplateInput {...rest} label={label} id={ctl.id} describedBy={ctl["aria-describedby"]} invalid={!!ctl["aria-invalid"]} />}
    </Field>
  );
}
