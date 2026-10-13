import { Suspense, lazy, useEffect, useState, type ReactElement } from "react";
import { Search, Shapes } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { EntityIcon } from "./EntityIcon";
import { PopularSection } from "./PopularSection";

// The search box, the windowed list and the keyboard handling are a chunk of their own, fetched the
// first time a picker opens. The popular 20 below are bundled, so they never wait for it.
const loadPanel = () => import("./IconPickerPanel");
const IconPickerPanel = lazy(loadPanel);

export interface IconPickerBodyProps {
  value?: string | null;
  /** `null` = remove the icon. */
  onSelect: (icon: string | null) => void;
}

/** What the picker shows: the popular icons at once, the search and the full list as soon as their chunk is in. */
export function IconPickerBody({ value, onSelect }: IconPickerBodyProps) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col">
          <div className="relative border-b border-line p-2">
            <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input aria-label="Search icons" placeholder="Search icons by name" disabled className="h-8 w-full rounded-md border border-line-strong bg-surface pl-8 pr-2 text-[0.8125rem] placeholder:text-faint" />
          </div>
          <PopularSection value={value} active={0} onPick={onSelect} />
        </div>
      }
    >
      <IconPickerPanel value={value} onSelect={onSelect} />
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
 * Popover icon picker for workspaces, bases and tables: "Popular" (20 icons, visible at once), a
 * search box, the full scrollable list and "Remove icon". Only render it for people who may rename
 * the entity (viewers just see the icon).
 */
export function IconPicker({ value, onChange, label = "Choose icon", disabled, children, className, align = "start" }: IconPickerProps) {
  const [open, setOpen] = useState(false);
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
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {children ?? (
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
        )}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[22rem] p-0" aria-label="Icon picker">
        <IconPickerBody value={value} onSelect={pick} />
      </PopoverContent>
    </Popover>
  );
}

/** "Change icon…" from a menu: the same picker body in a dialog (a popover cannot hang off a closing menu). */
export function IconPickerDialog({ open, onOpenChange, title, value, onChange }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; value?: string | null; onChange: (icon: string | null) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} size="sm" className="[&>div:nth-child(2)]:p-0">
      <IconPickerBody
        value={value}
        onSelect={(icon) => {
          onOpenChange(false);
          onChange(icon);
        }}
      />
    </Dialog>
  );
}
