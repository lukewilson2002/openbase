import { Suspense, lazy, useEffect, useRef, useState, type ReactElement, type TouchEvent } from "react";
import { Search, Shapes, X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { Dialog } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { COARSE_POINTER, useMediaQuery } from "@/hooks/useMediaQuery";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { cn } from "@/lib/cn";
import { EntityIcon } from "./EntityIcon";
import { PopularSection } from "./PopularSection";

// The search box, the windowed list and the keyboard handling are a chunk of their own, fetched the
// first time a picker opens. The popular 20 below are bundled, so they never wait for it.
const loadPanel = () => import("./IconPickerPanel");
const IconPickerPanel = lazy(loadPanel);

/** Touch screens and narrow windows get the picker as a bottom sheet instead of a popover (same breakpoint as the 16px fields in index.css). */
const SHEET_MEDIA = "(pointer: coarse), (max-width: 639.98px)";
const SHEET_MAX_HEIGHT = 544;
/** Backdrop left visible above the sheet, so it reads as a sheet and there is something to tap. */
const SHEET_TOP_GAP = 8;

export interface IconPickerBodyProps {
  value?: string | null;
  /** `null` = remove the icon. */
  onSelect: (icon: string | null) => void;
  /** Fill the parent's height (the phone sheet) instead of showing six rows of the full list. */
  fill?: boolean;
}

/** What the picker shows: the popular icons at once, the search and the full list as soon as their chunk is in. */
export function IconPickerBody({ value, onSelect, fill = false }: IconPickerBodyProps) {
  // On a touch screen, focusing the search box opens the keyboard, which covers half the picker
  // before the user has decided to search. There it waits for a tap.
  const coarse = useMediaQuery(COARSE_POINTER);
  return (
    <Suspense
      fallback={
        <div className={cn("flex flex-col", fill && "min-h-0 flex-1")}>
          <div className="relative border-b border-line p-2">
            <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input aria-label="Search icons" placeholder="Search icons by name" disabled className="h-8 w-full rounded-md border border-line-strong bg-surface pl-8 pr-2 text-[0.8125rem] placeholder:text-faint" />
          </div>
          <PopularSection value={value} active={0} onPick={onSelect} />
        </div>
      }
    >
      <IconPickerPanel value={value} onSelect={onSelect} autoFocusSearch={!coarse} fill={fill} />
    </Suspense>
  );
}

export interface IconPickerProps {
  /** The current icon name, if any. */
  value?: string | null;
  /** Called with the chosen icon, or `null` when "Remove icon" is used. The popover closes first. */
  onChange: (icon: string | null) => void;
  /** Accessible name of the default trigger button. */
  label?: string;
  disabled?: boolean;
  /** Replace the default square trigger with your own button (it receives the popover trigger props). */
  children?: ReactElement;
  className?: string;
  align?: "start" | "center" | "end";
}

/**
 * Icon picker for workspaces, bases and tables: "Popular" (20 icons, visible at once), a search box,
 * the full scrollable list and "Remove icon". A popover with a mouse; a bottom sheet on touch screens
 * and narrow windows. Only render it for people who may rename the entity (viewers just see the icon).
 */
export function IconPicker({ value, onChange, label = "Choose icon", disabled, children, className, align = "start" }: IconPickerProps) {
  const [open, setOpen] = useState(false);
  const asSheet = useMediaQuery(SHEET_MEDIA);
  // Fetch the (small) panel chunk once a picker is on screen, so keystrokes typed right after opening
  // are not lost to its loading state. The ~190 kB icon set is NOT touched here: it loads on open.
  useEffect(() => {
    const t = setTimeout(() => void loadPanel().catch(() => {}), 300);
    return () => clearTimeout(t);
  }, []);
  const pick = (icon: string | null) => {
    setOpen(false);
    onChange(icon);
  };
  const trigger = children ?? (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-line-strong bg-surface text-fg transition-colors hover:border-faint hover:bg-hover",
        "focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60",
        !value && "text-muted",
        className,
      )}
    >
      {value ? <EntityIcon name={value} className="size-4" /> : <Shapes aria-hidden className="size-4" />}
    </button>
  );
  if (asSheet) {
    return (
      <IconPickerSheet open={open} onOpenChange={setOpen} title={label} value={value} onSelect={pick}>
        <D.Trigger asChild disabled={disabled}>
          {trigger}
        </D.Trigger>
      </IconPickerSheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[22rem] p-0" aria-label="Icon picker">
        <IconPickerBody value={value} onSelect={pick} />
      </PopoverContent>
    </Popover>
  );
}

/** "Change icon…" from a menu: the same picker body in a dialog (a popover cannot hang off a closing menu). */
export function IconPickerDialog({ open, onOpenChange, title, value, onChange }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; value?: string | null; onChange: (icon: string | null) => void }) {
  const asSheet = useMediaQuery(SHEET_MEDIA);
  const pick = (icon: string | null) => {
    onOpenChange(false);
    onChange(icon);
  };
  if (asSheet) return <IconPickerSheet open={open} onOpenChange={onOpenChange} title={title} value={value} onSelect={pick} />;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} size="sm" className="[&>div:nth-child(2)]:p-0">
      <IconPickerBody value={value} onSelect={pick} />
    </Dialog>
  );
}

/** A tap moves less than this; more is a scroll or a swipe that happened to end on the backdrop. */
const TAP_SLOP = 10;

/**
 * The picker as a modal bottom sheet sized to the visible part of the screen. `children` is an
 * optional `D.Trigger`; without one the caller controls `open` (focus goes back to whatever had it).
 */
function IconPickerSheet({ open, onOpenChange, title, value, onSelect, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; value?: string | null; onSelect: (icon: string | null) => void; children?: ReactElement }) {
  const coarse = useMediaQuery(COARSE_POINTER);
  const visible = useVisualViewport(open);
  const content = useRef<HTMLDivElement>(null);
  const tapStart = useRef<{ x: number; y: number } | null>(null);
  // Sized and placed from the visual viewport: iOS Safari leaves the layout viewport at full height
  // under the keyboard, so a sheet at `bottom: 0` or `100dvh` tall would sit behind the keyboard and
  // Safari would pan the page to show the focused search box, pushing the sheet's top off screen.
  const height = Math.max(0, Math.min(SHEET_MAX_HEIGHT, visible.height - SHEET_TOP_GAP));
  const top = visible.top + visible.height - height;

  const onBackdropTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    tapStart.current = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
  };
  // Radix closes on the click that follows a tap outside, but iOS Safari sends no click for a tap on
  // an element without a click listener of its own, and the backdrop has none (React listens on
  // <body> for portals, which iOS ignores). So a tap on the backdrop left the picker open.
  // preventDefault stops the late click from landing on whatever is under the closed sheet.
  const onBackdropTouchEnd = (e: TouchEvent) => {
    const start = tapStart.current;
    const t = e.changedTouches[0];
    tapStart.current = null;
    if (!start || !t || Math.hypot(t.clientX - start.x, t.clientY - start.y) > TAP_SLOP) return;
    e.preventDefault();
    onOpenChange(false);
  };

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {children}
      <D.Portal>
        <D.Overlay data-testid="icon-picker-backdrop" className="ob-fade-in fixed inset-0 z-50 bg-overlay" onTouchStart={onBackdropTouchStart} onTouchEnd={onBackdropTouchEnd} />
        <D.Content
          ref={content}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // Focus the sheet itself on touch screens: Radix would focus the close button or, once
            // loaded, the search box would take focus and open the keyboard.
            if (!coarse) return;
            e.preventDefault();
            content.current?.focus();
          }}
          className="ob-sheet-in fixed inset-x-0 z-50 mx-auto flex w-full max-w-md flex-col overflow-hidden rounded-t-xl border border-b-0 border-line bg-surface shadow-pop outline-none"
          style={{ top, height }}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line py-1 pl-4 pr-1">
            <D.Title className="min-w-0 truncate text-base font-semibold">{title}</D.Title>
            <D.Close aria-label="Close" className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-ring">
              <X aria-hidden className="size-4" />
            </D.Close>
          </div>
          <IconPickerBody value={value} onSelect={onSelect} fill />
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
