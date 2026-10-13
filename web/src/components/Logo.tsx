import { cn } from "@/lib/cn";
import { LOCKUP_MARK_PATHS, LOCKUP_VIEW_BOX, LOCKUP_WORDMARK_PATH, MARK_PATHS, MARK_SMALL_PATHS, MARK_SMALL_VIEW_BOX, MARK_VIEW_BOX } from "./brandMarks";

/**
 * The OpenBase cube. `small` is the 16-32 px variant (wider gaps, no sliver): use it below 40 px
 * and for the footer line; the master mark is for larger sizes. The size comes from `className`.
 */
export function BrandMark({ className, small = false }: { className?: string; small?: boolean }) {
  return (
    <svg aria-hidden focusable="false" viewBox={small ? MARK_SMALL_VIEW_BOX : MARK_VIEW_BOX} className={cn("size-6 shrink-0", className)}>
      {(small ? MARK_SMALL_PATHS : MARK_PATHS).map(([fill, d]) => (
        <path key={fill} fill={fill} d={d} />
      ))}
    </svg>
  );
}

/**
 * The OpenBase logo: the mark alone (`showName={false}`) or the lockup, the mark with the outlined
 * wordmark. The wordmark follows the text colour, so it is ink on light and white on dark. The
 * wordmark is artwork, not text: do not retype the name in the UI font. Give the height with
 * `className` (the lockup should not be narrower than 120 px, so at least `h-9`).
 */
export function Logo({ className, showName = true }: { className?: string; showName?: boolean }) {
  if (!showName) return <BrandMark small className={cn("size-7", className)} />;
  return (
    <svg role="img" aria-label="OpenBase" viewBox={LOCKUP_VIEW_BOX} className={cn("h-9 w-auto shrink-0 text-fg", className)}>
      {LOCKUP_MARK_PATHS.map(([fill, d]) => (
        <path key={fill} fill={fill} d={d} />
      ))}
      <path fill="currentColor" d={LOCKUP_WORDMARK_PATH} />
    </svg>
  );
}
