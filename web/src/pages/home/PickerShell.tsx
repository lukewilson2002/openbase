/**
 * Where a capture chip's choices open: a popover under the chip on a desktop, a bottom sheet on a phone (PH-3). The
 * chip is passed as a function so the shell can hand it what each surface needs (a Radix trigger, or a plain press).
 */
import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet } from "@/components/ui/sheet";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";

export interface PickerShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The sheet's title on a phone. */
  title: string;
  /** The chip; `onClick` is set on a phone only (a popover's trigger brings its own). */
  trigger: (props: { onClick?: () => void; "aria-haspopup": "dialog"; "aria-expanded": boolean }) => ReactNode;
  children: ReactNode;
  /** Wider than the default popover, for a list with two lines to a row. */
  wide?: boolean;
}

export function PickerShell({ open, onOpenChange, title, trigger, children, wide }: PickerShellProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  if (!desktop) {
    return (
      <>
        {trigger({ onClick: () => onOpenChange(true), "aria-haspopup": "dialog", "aria-expanded": open })}
        <Sheet open={open} onOpenChange={onOpenChange} title={title}>
          {children}
        </Sheet>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger({ "aria-haspopup": "dialog", "aria-expanded": open })}</PopoverTrigger>
      <PopoverContent className={wide ? "w-80" : undefined} aria-label={title}>
        {children}
      </PopoverContent>
    </Popover>
  );
}
