/**
 * Choices editor for single and multiple select properties (FLD-6): add, rename, recolor, reorder, delete.
 * Each choice keeps its pastel chip color; a new one takes the next palette color (`nextChoiceColor`). On a
 * phone the color list is a bottom sheet (PH-3) and the rows are reordered with the arrows, since a drag
 * needs a mouse.
 */
import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, Plus, X } from "lucide-react";
import type { SelectChoice } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ColorSwatchPicker } from "@/components/ui/color-swatch-picker";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet } from "@/components/ui/sheet";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { choiceClass } from "@/lib/colors";
import { cn } from "@/lib/cn";
import { nextChoiceColor } from "./choices";

export interface SelectChoicesEditorProps {
  choices: readonly SelectChoice[];
  onChange: (choices: SelectChoice[]) => void;
}

/** The choice's color as a small pastel dot that opens the list of colors: a pop-over, or a sheet on a phone. */
function ChoiceColor({ color, label, onChange }: { color: string; label: string; onChange: (color: string) => void }) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [open, setOpen] = useState(false);
  const dot = (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      onClick={desktop ? undefined : () => setOpen(true)}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-hover max-md:size-control-touch"
    >
      <span className={cn(choiceClass(color), "size-5 rounded-pill border border-fg/10 max-md:size-6")} />
    </button>
  );
  if (desktop) {
    return (
      <Popover>
        <PopoverTrigger asChild>{dot}</PopoverTrigger>
        <PopoverContent className="w-72 p-3">
          <ColorSwatchPicker value={color} onChange={onChange} label={label} />
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <>
      {dot}
      <Sheet open={open} onOpenChange={setOpen} title="Choice color">
        <ColorSwatchPicker
          value={color}
          label={label}
          onChange={(c) => {
            onChange(c);
            setOpen(false);
          }}
          className="grid-cols-5 justify-items-center gap-3 [&>button]:size-control-touch"
        />
      </Sheet>
    </>
  );
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
            <Icon icon={GripVertical} className="cursor-grab text-faint max-md:hidden" />
            <ChoiceColor color={c.color} label={`Color of option ${c.name || i + 1}`} onChange={(color) => update(i, { color })} />
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
              <Icon icon={ArrowUp} />
            </IconButton>
            <IconButton label={`Move ${c.name || `option ${i + 1}`} down`} size="sm" noTooltip disabled={i === choices.length - 1} onClick={() => move(i, i + 1)}>
              <Icon icon={ArrowDown} />
            </IconButton>
            <IconButton label={`Delete ${c.name || `option ${i + 1}`}`} size="sm" noTooltip onClick={() => onChange(choices.filter((_, k) => k !== i))}>
              <Icon icon={X} />
            </IconButton>
          </li>
        ))}
      </ul>
      <Button size="sm" variant="secondary" className="mt-2" onClick={add}>
        <Icon icon={Plus} /> Add option
      </Button>
      {choices.length === 0 && <p className="mt-2 text-meta text-muted">Options can also be created while editing cells.</p>}
    </div>
  );
}
