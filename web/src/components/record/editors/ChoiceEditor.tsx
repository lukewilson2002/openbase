/** Single and multiple select editor: searchable list of colour pills, with "create option" for creators. */
import { useId, useMemo, useRef, useState } from "react";
import { Check, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "@/api/keys";
import type { Field, SelectChoice } from "@/api/types";
import { createChoice, isSelectField } from "@/components/fields/choices";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { choiceClass } from "@/lib/colors";
import { stringItems } from "@/lib/cells/kinds";
import { EditorShell } from "./EditorShell";
import { useEditorEnv, type FieldEditorCallbacks, type Move } from "./env";

export interface ChoiceEditorProps extends FieldEditorCallbacks {
  field: Field;
  value: unknown;
  variant: "cell" | "form";
  target?: { width: number; height: number };
  initialText?: string;
}

export function Pill({ choice, className }: { choice: Pick<SelectChoice, "name" | "color">; className?: string }) {
  return <span className={cn(choiceClass(choice.color), "inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-xs font-medium", className)}>{choice.name}</span>;
}

export function ChoiceEditor({ field, value, variant, target, initialText, onChange, onCommit: commitUp, onCancel }: ChoiceEditorProps) {
  const env = useEditorEnv();
  const qc = useQueryClient();
  const toast = useToast();
  const multiple = field.type === "multiple_select";
  const [extra, setExtra] = useState<SelectChoice[]>([]);
  const baseChoices = isSelectField(field) ? field.options.choices : [];
  const choices = useMemo(() => [...baseChoices, ...extra.filter((e) => !baseChoices.some((c) => c.id === e.id))], [baseChoices, extra]);
  const [selected, setSelected] = useState<string[]>(() => stringItems(value));
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [query, setQuery] = useState(initialText ?? "");
  const [active, setActive] = useState(0);
  // The highlight is the user's choice once they typed or moved it; before that it only rests on the first row.
  const [moved, setMoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const listId = useId();
  const closeRef = useRef<() => void>(() => {});
  const onCommit: FieldEditorCallbacks["onCommit"] = (edit, move) => {
    commitUp(edit, move);
    closeRef.current();
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? choices.filter((c) => c.name.toLowerCase().includes(q)) : choices;
  }, [choices, query]);
  const exact = choices.some((c) => c.name.toLowerCase() === query.trim().toLowerCase());
  const canCreate = env.canCreateOptions && query.trim() !== "" && !exact && isSelectField(field);
  const rows = filtered.length + (canCreate ? 1 : 0);

  const report = (ids: string[]) => {
    setSelected(ids);
    onChange?.({ json: multiple ? ids : (ids[0] ?? null) });
  };

  const pick = (c: SelectChoice, move?: Move) => {
    if (multiple) {
      report(selectedRef.current.includes(c.id) ? selectedRef.current.filter((x) => x !== c.id) : [...selectedRef.current, c.id]);
    } else {
      // The editor can stay mounted after this (a form), so it shows the pick at once.
      setSelected([c.id]);
      onCommit({ json: c.id }, move);
    }
  };

  /** Clears the value; the chips go at once, the editor can stay mounted after this (a form). */
  const clear = () => {
    setSelected([]);
    onCommit({ json: null });
  };

  const create = async () => {
    if (!isSelectField(field) || busy) return;
    setBusy(true);
    try {
      const c = await createChoice(field, query);
      setExtra((e) => [...e, c]);
      void qc.invalidateQueries({ queryKey: keys.base(env.baseId) });
      setQuery("");
      pick(c);
    } catch (e) {
      toast.error(e, "Could not create the option");
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMoved(true);
      setActive((a) => Math.min(rows - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMoved(true);
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      // Enter on one value picks it and goes on to the next row; on several it toggles, and Ctrl or Cmd with it is done.
      const down: Move | undefined = variant === "cell" ? [0, e.shiftKey ? -1 : 1] : undefined;
      if (multiple && (e.ctrlKey || e.metaKey)) {
        onCommit({ json: selectedRef.current }, down);
      } else if (active < filtered.length) {
        const c = filtered[active];
        if (c) pick(c, down);
      } else if (canCreate) void create();
    } else if (e.key === "Tab" && variant === "cell") {
      e.preventDefault();
      e.stopPropagation();
      // Tab takes the highlighted option when the user went looking for one, else what is picked already.
      const lit = moved || query.trim() !== "" ? filtered[active] : undefined;
      const json = multiple
        ? lit && query.trim() !== "" && !selectedRef.current.includes(lit.id)
          ? [...selectedRef.current, lit.id]
          : selectedRef.current
        : (lit?.id ?? selectedRef.current[0] ?? null);
      onCommit({ json }, [e.shiftKey ? -1 : 1, 0]);
    }
  };

  const chosen = selected.map((id) => choices.find((c) => c.id === id)).filter((c): c is SelectChoice => !!c);

  return (
    <EditorShell
      variant={variant}
      target={target}
      onCancel={onCancel}
      onDismiss={() => {
        if (multiple && variant === "form") onCommit({ json: selectedRef.current });
      }}
      triggerLabel={field.name}
      trigger={
        chosen.length > 0 ? chosen.map((c) => <Pill key={c.id} choice={c} />) : <span className="text-faint">Select…</span>
      }
    >
      {({ close }) => {
        closeRef.current = close;
        return (
          <>
      <div className="border-b border-line p-2">
        <input
          data-autofocus
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setMoved(false);
          }}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={rows > 0 ? `${listId}-${active}` : undefined}
          aria-label={`Find an option in ${field.name}`}
          placeholder={env.canCreateOptions ? "Find or create an option" : "Find an option"}
          className="h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-[0.8125rem] outline-none focus:border-ring"
        />
      </div>
      <ul id={listId} role="listbox" aria-multiselectable={multiple} aria-label={field.name} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {filtered.map((c, i) => {
          const on = selected.includes(c.id);
          return (
            <li key={c.id} id={`${listId}-${i}`} role="option" aria-selected={on}>
              <button
                type="button"
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(c)}
                className={cn("flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left", i === active && "bg-hover")}
              >
                <Pill choice={c} />
                {on && <Check aria-hidden className="size-4 text-primary-text" />}
              </button>
            </li>
          );
        })}
        {canCreate && (
          <li id={`${listId}-${filtered.length}`} role="option" aria-selected={false}>
            <button
              type="button"
              tabIndex={-1}
              disabled={busy}
              onMouseEnter={() => setActive(filtered.length)}
              onClick={() => void create()}
              className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[0.8125rem]", active === filtered.length && "bg-hover")}
            >
              <Plus aria-hidden className="size-4 text-muted" />
              Create <Pill choice={{ name: query.trim(), color: "gray" }} />
            </button>
          </li>
        )}
        {rows === 0 && <li className="px-2 py-3 text-center text-[0.8125rem] text-muted">{choices.length === 0 ? "This field has no options yet." : "No matching options."}</li>}
      </ul>
      <div className="flex items-center justify-between gap-2 border-t border-line p-2">
        <Button size="sm" variant="ghost" onClick={clear} disabled={selected.length === 0}>
          Clear
        </Button>
        {multiple && (
          <Button size="sm" variant="primary" onClick={() => onCommit({ json: selectedRef.current })}>
            Done
          </Button>
        )}
      </div>
          </>
        );
      }}
    </EditorShell>
  );
}
