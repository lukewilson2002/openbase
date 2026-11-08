import { useId, useRef, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { ListboxOption, useListNav } from "./listbox";
import { usePortalHost } from "./portal-host";
import { useReturnFocus } from "./use-return-focus";
import { Icon } from "./icon";

export interface CommandItem {
  id: string;
  label: string;
  /** A color mark, glyph or avatar before the label. */
  leading?: ReactNode;
  /** Quiet text at the right end: the collection a record is in. */
  hint?: ReactNode;
  onSelect: () => void;
}

export interface CommandGroup {
  id: string;
  /** The group's heading: "Records", "Collections", "Actions". */
  label: string;
  items: CommandItem[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** The results, in the order they show. The caller does the searching; empty groups are left out. */
  groups: CommandGroup[];
  placeholder?: string;
  /** Said when there are no results. */
  emptyText?: string;
  /** Read out while results are on their way. */
  busy?: boolean;
  /** Between the field and the results: the scope choices (everywhere, this workspace, this folder). */
  scopes?: ReactNode;
  className?: string;
}

/**
 * Ctrl K or Cmd K (NAV-9): a field above grouped results, driven entirely from the keyboard. Arrow Down and Up move
 * through the results across groups and wrap, Enter runs the highlighted one and closes, Escape closes and
 * returns focus to where it was. Focus never leaves the field; the field is a combobox that points at the
 * highlighted option, and a polite live region says how many results there are. This is the presentational
 * shell: what is searched and what each result does is wired by the caller (Phase 3). Centered near the
 * top on a desktop, the whole screen below the desktop breakpoint.
 */
export function CommandPalette({ open, onOpenChange, query, onQueryChange, groups, placeholder = "Search records, collections and actions", emptyText = "Nothing matches", busy, scopes, className }: CommandPaletteProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const visible = useVisualViewport(open && !desktop);
  const input = useRef<HTMLInputElement>(null);
  const returnFocus = useReturnFocus();
  const host = usePortalHost();
  const uid = useId();
  const shown = groups.filter((g) => g.items.length > 0);
  const flat = shown.flatMap((g) => g.items.map((item) => ({ item, domId: `${uid}-${g.id}-${item.id}` })));
  const nav = useListNav(flat.map((f) => f.domId));
  const active = nav.index >= 0 ? flat[nav.index] : undefined;

  const run = (item: CommandItem) => {
    onOpenChange(false);
    item.onSelect();
  };
  const status = busy ? "Searching" : flat.length === 0 ? emptyText : `${flat.length} ${flat.length === 1 ? "result" : "results"}`;

  return (
    <D.Root open={open} onOpenChange={onOpenChange} modal={!host.inline}>
      <D.Portal container={host.container}>
        <D.Overlay className="ob-fade-in fixed inset-0 z-50 bg-overlay" />
        <D.Content
          aria-describedby={undefined}
          onCloseAutoFocus={returnFocus.onCloseAutoFocus}
          onOpenAutoFocus={(e) => {
            returnFocus.noteOpener();
            e.preventDefault();
            if (!host.inline) input.current?.focus();
          }}
          style={desktop ? undefined : { top: visible.top, height: visible.height }}
          className={cn(
            "fixed z-50 flex flex-col bg-surface outline-none",
            desktop
              ? "ob-dialog-in left-1/2 top-[12dvh] max-h-[min(34rem,76dvh)] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-line shadow-pop"
              : "ob-sheet-in inset-x-0",
            className,
          )}
        >
          <D.Title className="sr-only">Search everything</D.Title>
          <div className="flex shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
            <Icon icon={Search} className="text-muted" />
            <input
              ref={input}
              role="combobox"
              aria-expanded
              aria-controls={`${uid}-list`}
              aria-activedescendant={active?.domId}
              aria-autocomplete="list"
              aria-label="Search"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={query}
              placeholder={placeholder}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (nav.onKeyDown(e)) return;
                if (e.key === "Enter" && active) {
                  e.preventDefault();
                  run(active.item);
                }
              }}
              // 16 px on touch: anything smaller makes iOS zoom the page on focus.
              className="h-12 min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-faint max-md:text-read-phone"
            />
            {!desktop && (
              <D.Close asChild>
                <Button variant="ghost" className="text-primary-text">
                  Cancel
                </Button>
              </D.Close>
            )}
          </div>
          {scopes && <div className="shrink-0 border-b border-line px-3 py-2">{scopes}</div>}
          <div role="status" aria-live="polite" className="sr-only">
            {status}
          </div>
          <div id={`${uid}-list`} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
            {shown.map((g) => (
              <div key={g.id} role="group" aria-labelledby={`${uid}-${g.id}`}>
                <div id={`${uid}-${g.id}`} className="px-2.5 pb-1 pt-2 text-meta font-medium text-muted">
                  {g.label}
                </div>
                {g.items.map((item) => {
                  const domId = `${uid}-${g.id}-${item.id}`;
                  return (
                    <ListboxOption key={item.id} id={domId} active={domId === active?.domId} onSelect={() => run(item)} onHover={() => nav.setActive(flat.findIndex((f) => f.domId === domId))} leading={item.leading} hint={item.hint}>
                      {item.label}
                    </ListboxOption>
                  );
                })}
              </div>
            ))}
            {flat.length === 0 && <p className="px-3 py-8 text-center text-label text-muted">{busy ? "Searching" : emptyText}</p>}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
