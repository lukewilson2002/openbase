/**
 * The boxes an embed is when it is not a live table (REC-6). The same words are in Markdown.tsx's HTML for
 * the places that render without React components, so a block reads the same wherever it is shown.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export const STATIC_TEXT = "Embedded view";
export const UNREADABLE_TEXT = "This embed can't be shown";
export const CANT_OPEN_TEXT = "You can't open this view";

/** `trailing` is what the editor adds at the end of the box (its Remove button). */
function Note({ kind, children, detail, trailing }: { kind: "static" | "unreadable" | "closed"; children: ReactNode; detail?: ReactNode; trailing?: ReactNode }) {
  return (
    <div role="note" className={cn("ob-embed", `ob-embed-${kind}`)}>
      <span>{children}</span>
      {detail && <span className="ob-embed-detail">{detail}</span>}
      {trailing && <span className="ml-auto">{trailing}</span>}
    </div>
  );
}

/** What an embed is where it is not alive: public share pages, forms, comments, grid cells. Nothing is fetched for it. */
export function StaticEmbed({ trailing }: { trailing?: ReactNode }) {
  return (
    <Note kind="static" trailing={trailing}>
      {STATIC_TEXT}
    </Note>
  );
}

/** A block that does not read as an embed (or one that names something this page cannot show); its text is left as it is. */
export function UnreadableEmbed({ trailing }: { trailing?: ReactNode }) {
  return (
    <Note kind="unreadable" trailing={trailing}>
      {UNREADABLE_TEXT}
    </Note>
  );
}

/** A view the reader cannot open. It says nothing of the view's name or records. */
export function CantOpenEmbed({ detail, trailing }: { detail?: string; trailing?: ReactNode }) {
  return (
    <Note kind="closed" detail={detail} trailing={trailing}>
      {CANT_OPEN_TEXT}
    </Note>
  );
}

/** A live embed waiting for its records, in the shape of a table. */
export function EmbedLoading({ label }: { label: string }) {
  return (
    <div aria-busy className="ob-embed my-3 rounded-lg border border-line bg-surface p-3">
      <div aria-hidden className="ob-skeleton h-4 w-1/3 rounded-md" />
      <div aria-hidden className="ob-skeleton mt-3 h-4 w-full rounded-md" />
      <div aria-hidden className="ob-skeleton mt-2 h-4 w-4/5 rounded-md" />
      <span className="sr-only" role="status">
        {label}
      </span>
    </div>
  );
}
