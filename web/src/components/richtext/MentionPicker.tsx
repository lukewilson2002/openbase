/**
 * The list of people offered after `@` in the rich text editor. It never takes the focus: the editor
 * keeps it, owns the keys (mention.ts) and points at the active option with `aria-activedescendant`.
 */
import { useMemo, type CSSProperties } from "react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/cn";
import { personColors } from "@/lib/colors";

export interface MentionPerson {
  id: string;
  name: string;
  email: string;
}

export interface MentionPickerProps {
  /** Id of the listbox; option `i` is `${id}-${i}`. */
  id: string;
  matches: readonly MentionPerson[];
  /** Everyone who can be mentioned, so a person keeps one colour whatever matches. */
  people: readonly MentionPerson[];
  active: number;
  onChoose(person: MentionPerson): void;
  style?: CSSProperties;
}

export function MentionPicker({ id, matches, people, active, onChoose, style }: MentionPickerProps) {
  const colors = useMemo(() => personColors(people), [people]);
  return (
    <ul id={id} role="listbox" aria-label="People to mention" style={style} className="absolute z-30 w-64 max-w-[calc(100%-1rem)] overflow-hidden rounded-md border border-line bg-surface p-1 shadow-pop">
      {matches.map((p, i) => (
        <li key={p.id} id={`${id}-${i}`} role="option" aria-selected={i === active}>
          {/* The mouse picks without taking the focus from the text. */}
          <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => onChoose(p)} className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[0.8125rem]", i === active && "bg-hover")}>
            <Avatar name={p.name} email={p.email} color={colors.get(p.id)} size="sm" />
            <span className="min-w-0">
              <span className="block truncate">{p.name}</span>
              <span className="block truncate text-xs text-muted">{p.email}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
