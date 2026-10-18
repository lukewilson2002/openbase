/** User field editor: pick collaborators of the base (one, or several when the field allows). */
import { useId, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { Field } from "@/api/types";
import { Avatar, avatarColor } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { choiceClass } from "@/lib/colors";
import { stringItems } from "@/lib/cells/kinds";
import { EditorShell } from "./EditorShell";
import { useEditorEnv, type FieldEditorCallbacks } from "./env";

export interface UserEditorProps extends FieldEditorCallbacks {
  field: Field;
  value: unknown;
  variant: "cell" | "form";
  target?: { width: number; height: number };
  initialText?: string;
}

/** A person as a chip: their face and name on a tint of their own colour, so assignees are told apart at a glance. */
export function UserChip({ name, email, color }: { name: string; email?: string; color?: string }) {
  const own = color ?? avatarColor(email || name);
  return (
    <span data-person-color={own} className={cn("inline-flex max-w-full items-center gap-1 rounded-full py-0.5 pl-0.5 pr-2 text-xs", choiceClass(own))}>
      <Avatar name={name} email={email} color={own} size="sm" className="size-4 text-[0.5rem]" />
      <span className="truncate">{name}</span>
    </span>
  );
}

export function UserEditor({ field, value, variant, target, initialText, onChange, onCommit: commitUp, onCancel }: UserEditorProps) {
  const env = useEditorEnv();
  const multiple = field.type === "user" ? field.options.multiple : false;
  const [selected, setSelected] = useState<string[]>(() => stringItems(value));
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [query, setQuery] = useState(initialText ?? "");
  const [active, setActive] = useState(0);
  const listId = useId();
  const closeRef = useRef<() => void>(() => {});
  const commit: FieldEditorCallbacks["onCommit"] = (edit, move) => {
    commitUp(edit, move);
    closeRef.current();
  };

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? env.collaborators.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)) : env.collaborators;
  }, [env.collaborators, query]);

  const toggle = (id: string) => {
    if (!multiple) {
      commit({ json: [id] });
      return;
    }
    const next = selectedRef.current.includes(id) ? selectedRef.current.filter((x) => x !== id) : [...selectedRef.current, id];
    setSelected(next);
    onChange?.({ json: next });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(people.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const u = people[active];
      if (u) toggle(u.id);
    }
  };

  return (
    <EditorShell
      variant={variant}
      target={target}
      onCancel={onCancel}
      onDismiss={() => {
        if (variant === "form" && multiple) commitUp({ json: selectedRef.current });
      }}
      triggerLabel={field.name}
      trigger={
        selected.length > 0 ? (
          selected.map((id) => {
            const u = env.collaborators.find((c) => c.id === id);
            return <UserChip key={id} name={u?.name ?? id} email={u?.email} color={env.format.userColor?.(id)} />;
          })
        ) : (
          <span className="text-faint">Assign…</span>
        )
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
                }}
                onKeyDown={onKey}
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={people.length > 0 ? `${listId}-${active}` : undefined}
                aria-label={`Find a person for ${field.name}`}
                placeholder="Find a person"
                className="h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-[0.8125rem] outline-none focus:border-ring"
              />
            </div>
            <ul id={listId} role="listbox" aria-multiselectable={multiple} aria-label="People" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
              {people.map((u, i) => {
                const on = selected.includes(u.id);
                return (
                  <li key={u.id} id={`${listId}-${i}`} role="option" aria-selected={on}>
                    <button type="button" tabIndex={-1} onMouseEnter={() => setActive(i)} onClick={() => toggle(u.id)} className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left", i === active && "bg-hover")}>
                      <Avatar name={u.name} email={u.email} color={env.format.userColor?.(u.id)} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{u.name}</span>
                        <span className="block truncate text-xs text-muted">{u.email}</span>
                      </span>
                      {on && <Check aria-hidden className="size-4 text-primary" />}
                    </button>
                  </li>
                );
              })}
              {people.length === 0 && <li className="px-2 py-3 text-center text-[0.8125rem] text-muted">No matching people.</li>}
            </ul>
            <div className="flex items-center justify-between gap-2 border-t border-line p-2">
              <Button size="sm" variant="ghost" onClick={() => commit({ json: null })} disabled={selected.length === 0}>
                Clear
              </Button>
              {multiple && (
                <Button size="sm" variant="primary" onClick={() => commit({ json: selectedRef.current })}>
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
