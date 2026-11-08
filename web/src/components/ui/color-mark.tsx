import { accentClass } from "@/lib/colors";
import { workspaceColor } from "@/lib/workspaceColor";
import { cn } from "@/lib/cn";

/** Pixel sizes of the mark, each with its own radius token (`--mark-<px>-radius`, styles/index.css). */
export type ColorMarkSize = 8 | 10 | 14 | 24 | 26 | 28;

// Whole class names so Tailwind's scanner and the stylesheet agree on them.
const SIZE_CLASS: Record<ColorMarkSize, string> = {
  8: "ob-mark-8",
  10: "ob-mark-10",
  14: "ob-mark-14",
  24: "ob-mark-24",
  26: "ob-mark-26",
  28: "ob-mark-28",
};

export interface ColorMarkProps {
  /** A palette colour (`lib/colors.ts`), as stored on a workspace, folder or collection. */
  hue?: string | null;
  /** 14 is the sidebar row. */
  size?: ColorMarkSize;
  /**
   * The entity's name. Without a stored hue the mark takes the one its name hashes to
   * (`lib/workspaceColor.ts`), so it is never blank and looks the same everywhere.
   */
  name?: string;
  className?: string;
}

/**
 * The colour that identifies a workspace, folder or collection (DL-3): a solid rounded square that
 * always sits beside the name, so it is decoration for assistive technology and hidden from it.
 */
export function ColorMark({ hue, size = 14, name = "", className }: ColorMarkProps) {
  return <span aria-hidden className={cn("ob-mark", SIZE_CLASS[size], accentClass(workspaceColor({ name, color: hue }), "solid"), className)} />;
}
