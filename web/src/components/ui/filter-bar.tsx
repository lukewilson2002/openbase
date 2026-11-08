import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { FilterChip } from "./filter-chip";
import { ListboxOption, useListNav } from "./listbox";
import { Popover, PopoverAnchor, PopoverContent } from "./popover";

export interface FilterBarChip {
  id: string;
  /** The filter in words: "Status is Done". */
  label: string;
  /** Opens the filter's editor. */
  onEdit?: () => void;
}

export interface FilterBarSuggestion {
  id: string;
  label: ReactNode;
  /** Quiet text at the right end. */
  hint?: ReactNode;
  leading?: ReactNode;
}

export interface FilterBarProps {
  chips: FilterBarChip[];
  onRemoveChip: (id: string) => void;
  /** The free text after the chips. */
  text: string;
  onTextChange: (text: string) => void;
  /** Ranked best first; the first is highlighted, so Enter applies it. The caller turns the text into these (Phase 4's phrase parser). */
  suggestions: FilterBarSuggestion[];
  /** Enter, or a click, on a suggestion. The caller adds the chip and clears the text. */
  onApplySuggestion: (suggestion: FilterBarSuggestion) => void;
  /** A last row set apart from the suggestions ("Advanced filter"). */
  footerAction?: { label: string; onSelect: () => void };
  placeholder?: string;
  /** The field's accessible name. */
  label?: string;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}

const FOOTER_ID = "__footer";

/**
 * One field that holds the filter chips and then free text, with a suggestion popover underneath (COL-3). The
 * border is 2 px blue while it has focus. Backspace in the empty field selects the last chip and a second
 * Backspace removes it, so a filter comes off the way a word does. Focus stays in the field while the keys move
 * through the suggestions (the field is a combobox). This is the presentational shell: turning text into
 * suggestions is the phrase parser's job (Phase 4), and the caller decides what applying one does.
 */
export function FilterBar({ chips, onRemoveChip, text, onTextChange, suggestions, onApplySuggestion, footerAction, placeholder = "Filter or search", label = "Filter or search", inputRef, className }: FilterBarProps) {
  const uid = useId();
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [pickedChip, setPickedChip] = useState<string | null>(null);
  const selectedChip = chips.find((c) => c.id === pickedChip) ?? null;

  const rowIds = [...suggestions.map((s) => s.id), ...(footerAction ? [FOOTER_ID] : [])];
  const nav = useListNav(rowIds);
  const open = focused && !dismissed && rowIds.length > 0;
  const domId = (id: string) => `${uid}-${id}`;

  const apply = (id: string | undefined) => {
    if (id === undefined) return;
    if (id === FOOTER_ID) footerAction?.onSelect();
    else {
      const s = suggestions.find((x) => x.id === id);
      if (s) onApplySuggestion(s);
    }
    setDismissed(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const modifier = e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta";
    if (e.key === "Backspace" && e.currentTarget.value === "" && chips.length > 0) {
      e.preventDefault();
      if (selectedChip) {
        onRemoveChip(selectedChip.id);
        setPickedChip(null);
      } else {
        setPickedChip(chips[chips.length - 1]!.id);
      }
      return;
    }
    // Any other key lets go of the picked chip.
    if (!modifier && pickedChip) setPickedChip(null);
    if (e.key === "ArrowDown" && dismissed && rowIds.length > 0) {
      e.preventDefault();
      setDismissed(false);
      return;
    }
    if (open && nav.onKeyDown(e)) return;
    if (e.key === "Enter" && open) {
      e.preventDefault();
      apply(nav.activeId);
    } else if (e.key === "Escape" && (dismissed || !e.defaultPrevented) && text) {
      // The popover takes the first Escape (it cancels the key); the next one empties the field. A popover still
      // fading out sees that next key too, which is why a closed one is not asked.
      e.preventDefault();
      onTextChange("");
    }
  };

  const status = selectedChip ? `Press Backspace again to remove ${selectedChip.label}` : open ? `${suggestions.length} ${suggestions.length === 1 ? "suggestion" : "suggestions"}` : "";

  return (
    <Popover open={open} onOpenChange={(next) => !next && setDismissed(true)} modal={false}>
      <PopoverAnchor asChild>
        <div
          ref={field}
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest("button")) input.current?.focus();
          }}
          className={cn(
            "flex min-h-control-md min-w-0 flex-1 cursor-text flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-surface py-1 pl-2.5 pr-2 max-md:min-h-control-touch",
            // 2 px in all: the 1 px border plus an inset ring of 1 px, so the field does not change size.
            "focus-within:border-primary focus-within:ring-1 focus-within:ring-inset focus-within:ring-primary",
            className,
          )}
        >
          <Search aria-hidden className="size-4 shrink-0 text-muted" />
          {chips.map((c) => (
            <FilterChip
              key={c.id}
              selected={c.id === selectedChip?.id}
              onEdit={c.onEdit}
              onRemove={() => {
                onRemoveChip(c.id);
                input.current?.focus();
              }}
            >
              {c.label}
            </FilterChip>
          ))}
          <input
            ref={(el) => {
              input.current = el;
              if (typeof inputRef === "function") inputRef(el);
              else if (inputRef) inputRef.current = el;
            }}
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={open ? `${uid}-list` : undefined}
            aria-activedescendant={open && nav.activeId ? domId(nav.activeId) : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={text}
            placeholder={chips.length ? "Add a filter" : placeholder}
            onChange={(e) => {
              setDismissed(false);
              setPickedChip(null);
              onTextChange(e.target.value);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              setPickedChip(null);
            }}
            onKeyDown={onKeyDown}
            // 16 px on touch: anything smaller makes iOS zoom the page on focus.
            className="h-7 min-w-24 flex-1 bg-transparent text-ui outline-none placeholder:text-faint max-md:text-read-phone"
          />
          <span role="status" aria-live="polite" className="sr-only">
            {status}
          </span>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        // Focus stays in the field: the popover neither takes it on opening nor gives it back on closing.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (field.current?.contains(e.target as Node)) e.preventDefault();
        }}
        className="w-[var(--radix-popover-trigger-width)] min-w-64 max-w-none"
      >
        <div id={`${uid}-list`} role="listbox" aria-label="Suggestions">
          {suggestions.map((s) => (
            <ListboxOption key={s.id} id={domId(s.id)} active={nav.activeId === s.id} onSelect={() => apply(s.id)} onHover={() => nav.setActive(rowIds.indexOf(s.id))} leading={s.leading} hint={s.hint}>
              {s.label}
            </ListboxOption>
          ))}
          {footerAction && (
            <>
              {suggestions.length > 0 && <div aria-hidden className="-mx-1.5 my-1.5 h-px bg-line" />}
              <ListboxOption id={domId(FOOTER_ID)} active={nav.activeId === FOOTER_ID} onSelect={() => apply(FOOTER_ID)} onHover={() => nav.setActive(rowIds.indexOf(FOOTER_ID))}>
                {footerAction.label}
              </ListboxOption>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
