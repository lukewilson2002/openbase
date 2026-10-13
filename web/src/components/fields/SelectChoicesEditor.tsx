/** Choices editor for single and multiple select fields: add, rename, recolour, reorder, delete. */
import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, Plus, X } from "lucide-react";
import type { SelectChoice } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ColorSwatchPicker } from "@/components/ui/color-swatch-picker";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { choiceClass } from "@/lib/colors";
import { cn } from "@/lib/cn";
import { nextChoiceColor } from "./choices";

export interface SelectChoicesEditorProps {
  choices: readonly SelectChoice[];
  onChange: (choices: SelectChoice[]) => void;
}

export function SelectChoicesEditor({ choices, onChange }: SelectChoicesEditorProps) {
  const [dragging, setDragging] = useState<number | null>(null);
  const inputs = useRef(new Map<number, HTMLInputElement>());
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  const update = (i: number, patch: Partial<SelectChoice>) => onChange(choices.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= choices.length) return;
    const next = [...choices];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  };
  const add = () => {
    onChange([...choices, { id: "", name: "", color: nextChoiceColor(choices) }]);
    setFocusIndex(choices.length);
  };

  return (
    <div>
      <ul aria-label="Options" className="flex flex-col gap-1.5">
        {choices.map((c, i) => (
          <li
            key={c.id || `new-${i}`}
            draggable
            onDragStart={(e) => {
              setDragging(i);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", String(i));
            }}
            onDragOver={(e) => dragging !== null && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging !== null) move(dragging, i);
              setDragging(null);
            }}
            onDragEnd={() => setDragging(null)}
            className={cn("flex items-center gap-1.5", dragging === i && "opacity-50")}
          >
            <GripVertical aria-hidden className="size-4 shrink-0 cursor-grab text-faint" />
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" aria-label={`Color of option ${c.name || i + 1}`} className={cn(choiceClass(c.color), "size-6 shrink-0 rounded-full border border-black/10")} />
              </PopoverTrigger>
              <PopoverContent className="w-72">
                <ColorSwatchPicker value={c.color} onChange={(color) => update(i, { color })} label={`Color of option ${c.name || i + 1}`} />
              </PopoverContent>
            </Popover>
            <Input
              ref={(el) => {
                if (el) {
                  inputs.current.set(i, el);
                  if (focusIndex === i) {
                    el.focus();
                    setFocusIndex(null);
                  }
                } else inputs.current.delete(i);
              }}
              aria-label={`Name of option ${i + 1}`}
              placeholder="Option name"
              value={c.name}
              maxLength={255}
              onChange={(e) => update(i, { name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (i === choices.length - 1) add();
                  else inputs.current.get(i + 1)?.focus();
                }
              }}
            />
            <IconButton label={`Move ${c.name || `option ${i + 1}`} up`} size="sm" noTooltip disabled={i === 0} onClick={() => move(i, i - 1)}>
              <ArrowUp aria-hidden className="size-4" />
            </IconButton>
            <IconButton label={`Move ${c.name || `option ${i + 1}`} down`} size="sm" noTooltip disabled={i === choices.length - 1} onClick={() => move(i, i + 1)}>
              <ArrowDown aria-hidden className="size-4" />
            </IconButton>
            <IconButton label={`Delete ${c.name || `option ${i + 1}`}`} size="sm" noTooltip onClick={() => onChange(choices.filter((_, k) => k !== i))}>
              <X aria-hidden className="size-4" />
            </IconButton>
          </li>
        ))}
      </ul>
      <Button size="sm" variant="secondary" className="mt-2" onClick={add}>
        <Plus aria-hidden className="size-4" /> Add option
      </Button>
      {choices.length === 0 && <p className="mt-2 text-xs text-muted">Options can also be created while editing cells.</p>}
    </div>
  );
}
