/**
 * The control at the start of a list row (the view's "Prefix field"): a checkbox that is ticked off
 * right there, the row's choice as a pill, or the person it is assigned to as a face. A pill or a
 * face opens a small menu to pick another value. It sits beside the title inside the row, so it
 * stops the pointer events that would otherwise open the row or start dragging it.
 */
import { useState, type MouseEvent, type ReactNode } from "react";
import { Check, Plus } from "lucide-react";
import type { Collaborator, Field } from "@/api/types";
import { AnchoredMenu, type MenuAnchor } from "@/components/ui/anchored-menu";
import { Avatar } from "@/components/ui/avatar";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { choiceClass } from "@/lib/colors";
import { displayShapeOf, selectChoicesOf, stringItems } from "@/lib/cells/kinds";
import type { FormatCtx } from "@/lib/cells/format";

/** The fields a list can use as its prefix: a checkbox, a single select, or a user field that holds one person. */
export function isPrefixField(f: Field): boolean {
  const shape = displayShapeOf(f);
  return shape === "checkbox" || f.type === "single_select" || (f.type === "user" && !f.options.multiple);
}

/** What the prefix says for a row, in words (a screen reader reads it with the row). */
export function prefixValueText(field: Field, value: unknown, people: readonly Collaborator[]): string {
  const shape = displayShapeOf(field);
  if (shape === "checkbox") return value === true ? "checked" : "unchecked";
  if (field.type === "single_select") return selectChoicesOf(field).find((c) => c.id === value)?.name ?? "none";
  const id = stringItems(value as never)[0];
  return (id && people.find((u) => u.id === id)?.name) || "nobody";
}

const stop = {
  onMouseDown: (e: MouseEvent) => e.stopPropagation(),
  onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
  onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
};

export interface RowPrefixProps {
  field: Field;
  value: unknown;
  /** The row's title, to say which row the control belongs to. */
  title: string;
  canEdit: boolean;
  /** Write a new value (view form: true or null, a choice id or null, `[userId]` or null). */
  onChange(value: unknown): void;
  people: readonly Collaborator[];
  emails: ReadonlyMap<string, string>;
  format: FormatCtx;
}

export function RowPrefix({ field, value, title, canEdit, onChange, people, emails, format }: RowPrefixProps) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const label = `${field.name}: ${title}`;
  if (displayShapeOf(field) === "checkbox") {
    const checked = value === true;
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-disabled={!canEdit || undefined}
        aria-label={label}
        tabIndex={-1}
        data-prefix
        {...stop}
        onClick={(e) => {
          e.stopPropagation();
          if (canEdit) onChange(checked ? null : true);
        }}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded border pointer-coarse:size-7",
          checked ? "border-primary bg-primary text-primary-fg" : "border-line-strong bg-surface text-transparent",
          canEdit ? "cursor-pointer hover:border-primary" : "cursor-default",
        )}
      >
        <Check aria-hidden className="size-3.5" strokeWidth={3} />
      </button>
    );
  }

  const isUser = field.type === "user";
  const choices = selectChoicesOf(field);
  const current = isUser ? stringItems(value as never)[0] : (value as string | null);
  const person = isUser ? people.find((u) => u.id === current) : undefined;
  const choice = !isUser ? choices.find((c) => c.id === current) : undefined;
  const shown: ReactNode = isUser ? (
    person ? (
      <Avatar name={person.name} email={emails.get(person.id)} color={format.userColor?.(person.id)} size="sm" className="size-5 text-[0.5625rem]" />
    ) : (
      <Plus aria-hidden className="size-3 text-faint" />
    )
  ) : choice ? (
    <span className={cn("max-w-32 truncate rounded-full px-2 py-0.5 text-xs", choiceClass(choice.color))}>{choice.name}</span>
  ) : (
    <Plus aria-hidden className="size-3 text-faint" />
  );
  const set = (next: unknown) => {
    setMenu(null);
    onChange(next);
  };
  return (
    <>
      <button
        type="button"
        data-prefix
        aria-haspopup={canEdit ? "menu" : undefined}
        aria-label={`${field.name}: ${title}, ${prefixValueText(field, value, people)}`}
        tabIndex={-1}
        {...stop}
        onClick={(e) => {
          e.stopPropagation();
          if (!canEdit) return;
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom, width: r.width, height: 1 });
        }}
        className={cn("flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full pointer-coarse:h-7", !choice && !person && "border border-dashed border-line-strong", canEdit ? "cursor-pointer" : "cursor-default")}
      >
        {shown}
      </button>
      {canEdit && menu && (
        // The menu is drawn elsewhere in the page but its events still reach the row in React's tree.
        <span onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()} {...stop}>
          <AnchoredMenu anchor={menu} onClose={() => setMenu(null)} label={field.name}>
            {isUser
              ? people.map((u) => (
                  <DropdownMenuItem key={u.id} onSelect={() => set([u.id])}>
                    <Avatar name={u.name} email={emails.get(u.id)} color={format.userColor?.(u.id)} size="sm" className="size-5 text-[0.5625rem]" />
                    <span className="min-w-0 flex-1 truncate">{u.name}</span>
                    {u.id === current && <Check aria-hidden className="size-3.5" />}
                  </DropdownMenuItem>
                ))
              : choices.map((c) => (
                  <DropdownMenuItem key={c.id} onSelect={() => set(c.id)}>
                    <span className={cn("max-w-48 truncate rounded-full px-2 py-0.5 text-xs", choiceClass(c.color))}>{c.name}</span>
                    {c.id === current && <Check aria-hidden className="ml-auto size-3.5" />}
                  </DropdownMenuItem>
                ))}
            {current && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => set(null)}>{isUser ? "Nobody" : "No value"}</DropdownMenuItem>
              </>
            )}
          </AnchoredMenu>
        </span>
      )}
    </>
  );
}
