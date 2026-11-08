import type { ComponentProps } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export interface IconProps extends Omit<ComponentProps<"svg">, "ref" | "children" | "color" | "fill" | "stroke" | "strokeWidth" | "width" | "height"> {
  /** The Lucide glyph to draw. */
  icon: LucideIcon;
  /**
   * `md` is the icon: 16 px on desktop, 20 on phone. `sm` (12 px) is for a glyph inside a small control that is
   * itself the target (the x on a chip, the tick in a checkbox). `fit` draws no size at all, for the few places that
   * size it themselves (a spinner, which is as big as the space it fills).
   */
  size?: "md" | "sm" | "fit";
}

/**
 * The one way the core components draw an icon (DL-4): a stroke icon at stroke width 2, in the surrounding
 * text colour, hidden from assistive technology because it only decorates. An icon that is the whole
 * content of a button is named by the button (`IconButton` requires its `label`), never by the icon.
 *
 * Phone sizes switch on at the compact layout and on touch screens, like the 44 px targets they sit in.
 */
export function Icon({ icon: Glyph, size = "md", className, ...props }: IconProps) {
  return (
    <Glyph
      aria-hidden
      strokeWidth={2}
      className={cn("shrink-0", size === "md" && "size-4 max-md:size-5 pointer-coarse:size-5", size === "sm" && "size-3", className)}
      {...props}
    />
  );
}
