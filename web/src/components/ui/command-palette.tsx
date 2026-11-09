import { useId, useRef, type ReactNode, type Ref } from "react";
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
  /** What the row says; a node so the matched text can be marked. */
  label: ReactNode;
  /** A color mark, glyph or avatar before the label. */
  leading?: ReactNode;
  /** Quiet text at the right end: the collection a record is in. */
  hint?: ReactNode;
  /** A second, quiet line under the label: the text around a match in another property. */
  detail?: ReactNode;
  onSelect: () => void;
}

export interface CommandGroup {
  id: string;
  /** The group's heading: "Records", "Collections", "Actions". */
  label: string;
  items: CommandItem[];
  /**
   * The results are for text the person has since typed past. They stay on screen so the list does not blink
   * on every key, and a click still opens one, but Enter waits for the new ones: it must not open a result
   * the person never saw.
   */
  stale?: boolean;
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
  /** Said, as an alert, when the search itself failed. */
  error?: ReactNode;
  /** The field, for the caller that selects its text or puts focus back in it (after a scope choice). */
  inputRef?: Ref<HTMLInputElement>;
  /** Between the field and the results: the scope choices (everywhere, this workspace, this folder). */
  scopes?: ReactNode;
  className?: string;
}

/**
 * Ctrl K or Cmd K (NAV-9): a field above grouped results, driven entirely from the keyboard. Arrow Down and Up move
 * through the results across groups and wrap, Enter closes the palette and then runs the highlighted one, Escape closes and
 * returns focus to where it was. Focus never leaves the field; the field is a combobox that points at the
 * highlighted option, and a polite live region says how many results there are. This is the presentational
 * shell: what is searched and what each result does is wired by the caller (Phase 3). Centered near the
 * top on a desktop, the whole screen below the desktop breakpoint.
 */
export function CommandPalette({ open, onOpenChange, query, onQueryChange, groups, placeholder = "Search records, collections and actions", emptyText = "Nothing matches", busy, error, inputRef, scopes, className }: CommandPaletteProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const visible = useVisualViewport(open && !desktop);
  const input = useRef<HTMLInputElement | null>(null);
  const returnFocus = useReturnFocus(open);
  const host = usePortalHost();
  const uid = useId();
  const shown = groups.filter((g) => g.items.length > 0);
  const flat = shown.flatMap((g) => g.items.map((item) => ({ item, stale: !!g.stale, domId: `${uid}-${g.id}-${item.id}` })));
  const nav = useListNav(flat.map((f) => f.domId));
  const active = nav.index >= 0 ? flat[nav.index] : undefined;

  // A command runs once the palette has gone, not as it starts to leave: a dialog or panel that the command opens
  // would otherwise stack over a palette that is still fading, whose Escape handler would swallow the first Escape.
  const pending = useRef<(() => void) | null>(null);
  const run = (item: CommandItem) => {
    pending.current = item.onSelect;
    onOpenChange(false);
  };
  const status = error ? "Search is unavailable" : busy ? "Searching" : flat.length === 0 ? emptyText : `${flat.length} ${flat.length === 1 ? "result" : "results"}`;

  return (
    <D.Root open={open} onOpenChange={onOpenChange} modal={!host.inline}>
      <D.Portal container={host.container}>
        <D.Overlay className="ob-fade-in fixed inset-0 z-50 bg-overlay" />
        <D.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            returnFocus.onCloseAutoFocus(e);
            const command = pending.current;
            pending.current = null;
            command?.();
          }}
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
              ref={(el) => {
                input.current = el;
                if (typeof inputRef === "function") inputRef(el);
                else if (inputRef) inputRef.current = el;
              }}
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
                  if (!active.stale) run(active.item);
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
          {error && (
            <p role="alert" className="shrink-0 px-3 py-2 text-label text-danger">
              {error}
            </p>
          )}
          <div id={`${uid}-list`} role="listbox" aria-label="Results" aria-busy={busy} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
            {shown.map((g) => (
              <div key={g.id} role="group" aria-labelledby={`${uid}-${g.id}`}>
                <div id={`${uid}-${g.id}`} className="px-2.5 pb-1 pt-2 text-meta font-medium text-muted">
                  {g.label}
                </div>
                {g.items.map((item) => {
                  const domId = `${uid}-${g.id}-${item.id}`;
                  return (
                    <ListboxOption key={item.id} id={domId} active={domId === active?.domId} onSelect={() => run(item)} onHover={() => nav.setActive(flat.findIndex((f) => f.domId === domId))} leading={item.leading} hint={item.hint} detail={item.detail}>
                      {item.label}
                    </ListboxOption>
                  );
                })}
              </div>
            ))}
            {flat.length === 0 && !error && <p className="px-3 py-8 text-center text-label text-muted">{busy ? "Searching" : emptyText}</p>}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
