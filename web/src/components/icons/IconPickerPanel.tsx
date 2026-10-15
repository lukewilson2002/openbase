/**
 * The body of the icon picker: search box, the 20 popular icons, the full list in a windowed
 * (virtualized) grid, and "Remove icon". Loaded lazily by `IconPicker.tsx`; it asks `registry.ts`
 * for the full set as soon as it mounts, so the popular icons are on screen first and the rest
 * fills in.
 *
 * Keyboard: the search box owns the text; ArrowDown moves into the grid, where the arrow keys,
 * Home/End and PageUp/PageDown move between icons (one tab stop, roving tabindex), ArrowUp from the
 * first row goes back to the search box, Enter/Space on an icon picks it, and Enter in the search
 * box picks the best match. Escape closes the popover or sheet (Radix).
 *
 * With `fill`, the panel takes the height its parent gives it and the list gets whatever is left
 * (the phone sheet); otherwise the list is six rows tall.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { useDebounced } from "@/components/record/editors/useDebounced";
import { ICON_COLS, IconCell, PopularSection } from "./PopularSection";
import { POPULAR_ICONS } from "./popular";
import { loadFullIconSet, peekFullIconSet, subscribeIconSet } from "./registry";
import { searchIcons } from "./search";

const ROW_HEIGHT = 34;
const VIEW_ROWS = 6;
const VIEW_HEIGHT = ROW_HEIGHT * VIEW_ROWS;
const OVERSCAN_ROWS = 3;
export const SEARCH_DEBOUNCE_MS = 120;

export interface IconPickerPanelProps {
  value?: string | null;
  /** `null` = remove the icon. */
  onSelect: (icon: string | null) => void;
  /** Focus the search box on open (off on touch screens, where that opens the keyboard). */
  autoFocusSearch?: boolean;
  /** Fill the parent's height instead of showing six rows. */
  fill?: boolean;
}

export default function IconPickerPanel({ value, onSelect, autoFocusSearch = true, fill = false }: IconPickerPanelProps) {
  const set = useSyncExternalStore(subscribeIconSet, peekFullIconSet, () => null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const [scrollTop, setScrollTop] = useState(0);
  const [active, setActive] = useState(0);
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    scroller.current = el;
    setScrollerEl(el);
  }, []);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const viewHeight = fill && measuredHeight > 0 ? measuredHeight : VIEW_HEIGHT;
  const pageRows = Math.max(1, Math.floor(viewHeight / ROW_HEIGHT));

  useLayoutEffect(() => {
    if (!fill || !scrollerEl) return;
    const measure = () => setMeasuredHeight(scrollerEl.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scrollerEl);
    return () => observer.disconnect();
  }, [fill, scrollerEl]);

  // The full set loads as the picker opens (it is cached, so reopening is instant).
  useEffect(() => {
    let live = true;
    setLoadFailed(false);
    loadFullIconSet().catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, [attempt]);

  const term = debounced.trim();
  const searching = term.length > 0;
  const results = useMemo(() => (searching ? searchIcons(set, term) : set ? set.names : []), [set, term, searching]);
  const popular = searching ? [] : POPULAR_ICONS.map((p) => p.name);
  const offset = popular.length;
  const total = offset + results.length;

  // A new result list starts at its first icon, scrolled to the top.
  useEffect(() => {
    setActive(0);
    setScrollTop(0);
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [term]);

  const rows = Math.ceil(results.length / ICON_COLS);
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const lastRow = Math.min(rows - 1, Math.floor((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN_ROWS);
  const visible: { name: string; index: number; row: number; col: number }[] = [];
  for (let r = firstRow; r <= lastRow; r++) {
    for (let c = 0; c < ICON_COLS; c++) {
      const i = r * ICON_COLS + c;
      const name = results[i];
      if (name !== undefined) visible.push({ name, index: offset + i, row: r, col: c });
    }
  }

  /** Move the roving tab stop (and focus) to `index`, scrolling the list to it first. */
  const goTo = (index: number) => {
    const next = Math.max(0, Math.min(total - 1, index));
    if (next >= offset) {
      const top = Math.floor((next - offset) / ICON_COLS) * ROW_HEIGHT;
      const el = scroller.current;
      if (el) {
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + ROW_HEIGHT > el.scrollTop + viewHeight) el.scrollTop = top + ROW_HEIGHT - viewHeight;
        setScrollTop(el.scrollTop);
      }
    }
    setActive(next);
    setPendingFocus(next);
  };

  // Focus the requested icon once it is in the DOM (the window may have just moved).
  useLayoutEffect(() => {
    if (pendingFocus === null) return;
    const el = root.current?.querySelector<HTMLElement>(`[data-icon-index="${pendingFocus}"]`);
    if (el) {
      el.focus();
      setPendingFocus(null);
    }
  }, [pendingFocus, scrollTop, term, set]);

  const onGridKey = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const raw = target.getAttribute?.("data-icon-index");
    if (raw === null || raw === undefined) return;
    const i = Number(raw);
    let next: number | null = null;
    switch (e.key) {
      case "ArrowRight":
        next = i + 1;
        break;
      case "ArrowLeft":
        next = i - 1;
        break;
      case "ArrowDown":
        next = i + ICON_COLS < total ? i + ICON_COLS : null;
        break;
      case "ArrowUp":
        if (i < ICON_COLS) {
          e.preventDefault();
          search.current?.focus();
          return;
        }
        next = i - ICON_COLS;
        break;
      case "Home":
        next = e.ctrlKey ? 0 : i - (i % ICON_COLS);
        break;
      case "End":
        next = e.ctrlKey ? total - 1 : Math.min(total - 1, i - (i % ICON_COLS) + ICON_COLS - 1);
        break;
      case "PageDown":
        next = Math.min(total - 1, i + pageRows * ICON_COLS);
        break;
      case "PageUp":
        next = Math.max(0, i - pageRows * ICON_COLS);
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next !== null) goTo(next);
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && total > 0) {
      e.preventDefault();
      goTo(0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Use the live text, not the debounced one, so Enter right after typing picks what is typed.
      const best = searchIcons(set, query)[0];
      if (query.trim() && best) onSelect(best);
    }
  };

  const status = searching ? (results.length === 0 ? `No icons match “${term}”` : `${results.length.toLocaleString()} icon${results.length === 1 ? "" : "s"}`) : set ? `${set.names.length.toLocaleString()} icons` : "";

  return (
    <div ref={root} onKeyDown={onGridKey} className={cn("flex flex-col", fill && "min-h-0 flex-1")}>
      <div className="relative border-b border-line p-2">
        <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <input
          ref={search}
          type="search"
          autoFocus={autoFocusSearch}
          autoComplete="off"
          spellCheck={false}
          aria-label="Search icons"
          placeholder="Search icons by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          className="h-8 w-full rounded-md border border-line-strong bg-surface pl-8 pr-2 text-[0.8125rem] placeholder:text-faint focus-visible:border-ring focus-visible:outline-2 focus-visible:-outline-offset-1"
        />
      </div>

      {!searching && <PopularSection value={value} active={active} onPick={onSelect} />}

      <section aria-labelledby="icon-all" className={cn("border-t border-line px-2 pb-2 pt-2", fill && "flex min-h-0 flex-1 flex-col")}>
        <div className="mb-1 flex items-baseline justify-between px-1">
          <h3 id="icon-all" className="text-xs font-medium uppercase tracking-wide text-muted">
            {searching ? "Results" : "All icons"}
          </h3>
          <span role="status" className="text-xs text-muted">
            {status}
          </span>
        </div>
        {!set && !loadFailed && !searching ? (
          <div role="status" className={cn("flex items-center justify-center gap-2", fill && "flex-1")} style={fill ? undefined : { height: VIEW_HEIGHT }}>
            <Spinner className="size-4" label="Loading icons" />
            <span className="text-[0.8125rem] text-muted">Loading all icons…</span>
          </div>
        ) : !set && loadFailed && !searching ? (
          <div role="alert" className={cn("flex flex-col items-center justify-center gap-2 text-center text-[0.8125rem] text-muted", fill && "flex-1")} style={fill ? undefined : { height: VIEW_HEIGHT }}>
            <p>The full icon list could not be loaded.</p>
            <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : results.length === 0 ? (
          <p className={cn("flex items-center justify-center text-[0.8125rem] text-muted", fill && !searching && "flex-1")} style={{ height: searching ? 72 : fill ? undefined : VIEW_HEIGHT }}>
            {searching ? "Try another word, such as “cart” or “chart”." : "No icons."}
          </p>
        ) : (
          <div
            ref={attachScroller}
            role="group"
            aria-label={searching ? "Matching icons" : "All icons"}
            data-testid="icon-list"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            className={cn("overflow-y-auto overscroll-contain", fill && "min-h-0 flex-1")}
            style={fill ? undefined : { height: Math.min(VIEW_HEIGHT, rows * ROW_HEIGHT) }}
          >
            <div className="relative" style={{ height: rows * ROW_HEIGHT }}>
              {visible.map(({ name, index, row, col }) => (
                <div key={name} className="absolute flex items-center justify-center" style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT, left: `${col * (100 / ICON_COLS)}%`, width: `${100 / ICON_COLS}%` }}>
                  <IconCell name={name} index={index} selected={value === name} tabbable={active === index} onPick={onSelect} />
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {value && (
        <div className="border-t border-line p-2">
          <Button size="sm" variant="ghost" className="w-full justify-center" onClick={() => onSelect(null)}>
            <Trash2 aria-hidden className="size-3.5" /> Remove icon
          </Button>
        </div>
      )}
    </div>
  );
}
