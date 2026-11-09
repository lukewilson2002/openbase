import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { cn } from "@/lib/cn";
import { FilterChip } from "./filter-chip";
import { ListboxOption, useListNav } from "./listbox";
import { Popover, PopoverAnchor, PopoverContent } from "./popover";
import { Icon } from "./icon";
import { usePortalHost } from "./portal-host";
import { Sheet } from "./sheet";

export interface FilterBarChip {
  id: string;
  /** The filter in words: "Status is Done". */
  label: string;
  /** Called when the chip is clicked, before its editor opens. */
  onEdit?: () => void;
  /**
   * The filter's editor, drawn under the chip in a popover and as a sheet on a phone. `close` shuts it and puts
   * focus back on the chip. Without one the chip only reports the click through `onEdit`.
   */
  editor?: (close: () => void) => ReactNode;
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
  /** Ranked best first; the first is highlighted, so Enter applies it. The caller turns the text into these (the phrase parser). */
  suggestions: FilterBarSuggestion[];
  /** Enter, or a click, on a suggestion. The caller adds the chip and clears the text. */
  onApplySuggestion: (suggestion: FilterBarSuggestion) => void;
  /** A last row set apart from the suggestions ("Advanced filter"). It comes with them: an empty field opens no list, which would cover what is under the bar. */
  footerAction?: { label: string; onSelect: () => void };
  placeholder?: string;
  /** The field's accessible name. */
  label?: string;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}

const FOOTER_ID = "__footer";

/**
 * Where the suggestions go on a phone (PH-3): a panel docked above the on-screen keyboard rather than a popover
 * under the field, which the keyboard would cover. It is not modal, because the field keeps focus and the keys.
 */
function PhonePanel({ open, children }: { open: boolean; children: ReactNode }) {
  const host = usePortalHost();
  const visible = useVisualViewport(open);
  if (!open) return null;
  const keyboard = Math.max(0, Math.round(window.innerHeight - (visible.top + visible.height)));
  return createPortal(
    <div
      style={{ bottom: keyboard, maxHeight: Math.round(visible.height * 0.5) }}
      className="ob-sheet-in fixed inset-x-0 z-50 mx-auto flex w-full max-w-lg flex-col overflow-y-auto overscroll-contain rounded-t-xl border border-b-0 border-line bg-surface p-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] shadow-pop"
    >
      {children}
    </div>,
    host.container ?? document.body,
  );
}

/**
 * One field that holds the filter chips and then free text, with a suggestion popover underneath (COL-3). The
 * border is 2 px blue while it has focus. Backspace in the empty field selects the last chip and a second
 * Backspace removes it, so a filter comes off the way a word does. Focus stays in the field while the keys move
 * through the suggestions (the field is a combobox). This is the presentational shell: turning text into
 * suggestions is the phrase parser's job (`ViewFilterBar` does it), and the caller decides what applying one does. On a phone
 * the suggestions sit in a panel above the keyboard and a chip's editor is a sheet (PH-3).
 */
export function FilterBar({ chips, onRemoveChip, text, onTextChange, suggestions, onApplySuggestion, footerAction, placeholder = "Filter or search", label = "Filter or search", inputRef, className }: FilterBarProps) {
  const uid = useId();
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [pickedChip, setPickedChip] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const selectedChip = chips.find((c) => c.id === pickedChip) ?? null;
  const editing = chips.find((c) => c.id === editingId && c.editor) ?? null;

  // A press elsewhere closes an editor too, and then focus belongs to what was pressed.
  const pressedOutside = useRef(false);

  /** Shuts a chip's editor and gives focus back to the chip that opened it, else to the field. */
  const closeEditor = () => {
    const id = editingId;
    const restore = !pressedOutside.current;
    pressedOutside.current = false;
    setEditingId(null);
    // A sheet gives focus back itself, and focusing the field on a phone would raise the keyboard.
    if (!desktop || !restore) return;
    window.setTimeout(() => {
      const button = id ? field.current?.querySelector<HTMLElement>(`[data-chip-id="${CSS.escape(id)}"] button`) : null;
      (button ?? input.current)?.focus();
    }, 0);
  };

  const rowIds = suggestions.length > 0 ? [...suggestions.map((s) => s.id), ...(footerAction ? [FOOTER_ID] : [])] : [];
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
    // The phone's panel is not a Radix layer, so nothing else takes the first Escape.
    if (e.key === "Escape" && open && !desktop) {
      e.preventDefault();
      setDismissed(true);
      return;
    }
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

  const list = (
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
  );

  return (
    <Popover open={open && desktop} onOpenChange={(next) => !next && setDismissed(true)} modal={false}>
      <PopoverAnchor asChild>
        <div
          ref={field}
          onClick={(e) => {
            // A click inside a chip's editor bubbles here through the React tree, though it is not on the field.
            if (e.currentTarget.contains(e.target as Node) && !(e.target as HTMLElement).closest("button")) input.current?.focus();
          }}
          className={cn(
            "flex min-h-control-md min-w-0 flex-1 cursor-text flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-surface py-1 pl-2.5 pr-2 max-md:min-h-control-touch max-md:py-0",
            // 2 px in all: the 1 px border plus an inset ring of 1 px, so the field does not change size.
            "focus-within:border-primary focus-within:ring-1 focus-within:ring-inset focus-within:ring-primary",
            className,
          )}
        >
          <Icon icon={Search} className="text-muted" />
          {chips.map((c) => {
            const chip = (
              <FilterChip
                key={c.id}
                data-chip-id={c.id}
                selected={c.id === selectedChip?.id}
                onEdit={
                  c.editor || c.onEdit
                    ? () => {
                        c.onEdit?.();
                        if (!c.editor) return;
                        pressedOutside.current = false;
                        setEditingId(c.id);
                      }
                    : undefined
                }
                onRemove={() => {
                  onRemoveChip(c.id);
                  if (editingId === c.id) setEditingId(null);
                  input.current?.focus();
                }}
              >
                {c.label}
              </FilterChip>
            );
            if (!c.editor) return chip;
            return (
              <Popover key={c.id} open={desktop && editing?.id === c.id} onOpenChange={(next) => !next && closeEditor()} modal={false}>
                <PopoverAnchor asChild>{chip}</PopoverAnchor>
                <PopoverContent
                  align="start"
                  onInteractOutside={() => (pressedOutside.current = true)}
                  onCloseAutoFocus={(e) => e.preventDefault()}
                  className="w-[min(34rem,calc(100vw-1.5rem))] p-3"
                >
                  {c.editor(closeEditor)}
                </PopoverContent>
              </Popover>
            );
          })}
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
            className="h-7 min-w-24 flex-1 bg-transparent text-ui outline-none placeholder:text-faint max-md:h-control-touch max-md:text-read-phone"
          />
          <span role="status" aria-live="polite" className="sr-only">
            {status}
          </span>
        </div>
      </PopoverAnchor>
      {desktop && (
        <PopoverContent
          align="start"
          sideOffset={6}
          // The combobox's popup is the listbox inside; a nameless dialog around it would be announced as one too.
          role="presentation"
          // Focus stays in the field: the popover neither takes it on opening nor gives it back on closing.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (field.current?.contains(e.target as Node)) e.preventDefault();
          }}
          className="w-[var(--radix-popover-trigger-width)] min-w-64 max-w-none"
        >
          {list}
        </PopoverContent>
      )}
      {!desktop && <PhonePanel open={open}>{list}</PhonePanel>}
      {!desktop && editing?.editor && (
        <Sheet open onOpenChange={(next) => !next && closeEditor()} title={editing.label}>
          {editing.editor(closeEditor)}
        </Sheet>
      )}
    </Popover>
  );
}
