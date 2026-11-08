import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The names the design tokens add to Tailwind's theme (styles/index.css). Without them tailwind-merge
 * reads `text-ui` as a text colour and drops it when `text-muted` follows, and `h-control-md` never
 * conflicts with `h-9`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        "meta",
        "label",
        "ui",
        "read",
        "read-phone",
        "h3",
        "sheet",
        "h2",
        "title",
        "home",
        "home-phone",
        "record",
        "record-phone",
        "capture",
        "capture-phone",
      ],
      radius: ["pill", "tile"],
      spacing: [
        "control-sm",
        "control-md",
        "control-lg",
        "control-touch",
        "row-table",
        "row-feed",
        "row-feed-phone",
        "gutter",
        "sidebar",
        "record",
        "home",
        "panel",
      ],
      container: ["sidebar", "record", "home", "panel"],
      ease: ["enter"],
    },
    classGroups: {
      // The motion tokens' duration classes (the numeric duration-150 is already known).
      duration: [{ duration: ["fast", "base", "slow", "fast-leave", "base-leave", "slow-leave"] }],
    },
  },
});

/** Join class names, resolving conflicting Tailwind utilities (last wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
