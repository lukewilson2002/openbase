import type { ComponentProps, ReactNode } from "react";
import { FileText } from "lucide-react";
import { accentClass } from "@/lib/colors";
import { cn } from "@/lib/cn";
import { ColorMark } from "./color-mark";
import { Icon } from "./icon";

export interface FeedRowProps extends Omit<ComponentProps<"div">, "title"> {
  /** A checkbox, an event icon or a `FeedTile`. Interactive content works: it sits above the row's open target. */
  leading?: ReactNode;
  title: ReactNode;
  /** The line under the title: a collection name, who did it. */
  meta?: ReactNode;
  /** The collection's palette colour, drawn as an 8 px mark before `meta`. `null` takes the colour `metaMarkName` hashes to; leave it out for no mark. */
  metaHue?: string | null;
  metaMarkName?: string;
  /** Lets `meta` run onto more lines, for a row whose facts (where, who, how long) must not be cut off on a phone. */
  wrapMeta?: boolean;
  /** A date or time, display only: it sits under the row's open target. */
  trailing?: ReactNode;
  /** Opens the thing the row is about. The whole row is the target, so the title is the one tab stop. */
  onOpen?: () => void;
  /**
   * Opens it as a link, so it can be copied or opened in a new tab. With `onOpen` as well, a plain click runs
   * `onOpen` (a router navigation) instead of loading the page.
   */
  href?: string;
}

/** One line of a feed (activity, tasks due, drafts): 44 px tall, 56 on phone. */
export function FeedRow({ leading, title, meta, metaHue, metaMarkName, wrapMeta, trailing, onOpen, href, className, ...props }: FeedRowProps) {
  const openable = !!(href || onOpen);
  const text = (
    <>
      <span className="block truncate text-ui font-medium">{title}</span>
      {(meta != null || metaHue !== undefined) && (
        <span className="flex min-w-0 items-center gap-1.5 text-meta text-muted">
          {metaHue !== undefined && <ColorMark hue={metaHue} size={8} name={metaMarkName} />}
          <span className={wrapMeta ? "min-w-0" : "truncate"}>{meta}</span>
        </span>
      )}
    </>
  );
  // The open target stretches over the whole row (a pseudo-element), so the leading control stays clickable on its own.
  const body = "min-w-0 flex-1 text-left text-fg no-underline after:absolute after:inset-0 focus-visible:after:rounded-md";
  return (
    <div
      className={cn("relative flex min-h-row-feed items-center gap-3 px-2 max-md:min-h-row-feed-phone", wrapMeta && "py-2", openable && "hover:bg-hover", className)}
      {...props}
    >
      {leading != null && <div className="relative z-10 flex shrink-0 items-center">{leading}</div>}
      {href ? (
        <a
          href={href}
          onClick={(e) => {
            if (!onOpen || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            onOpen();
          }}
          className={body}
        >
          {text}
        </a>
      ) : onOpen ? (
        <button type="button" onClick={onOpen} className={body}>
          {text}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{text}</div>
      )}
      {trailing != null && <div className="num shrink-0 text-meta text-muted">{trailing}</div>}
    </div>
  );
}

/** The one generic page glyph a feed may show, on a tile tinted with the collection's hue. */
export function FeedTile({ hue, className }: { hue?: string | null; className?: string }) {
  return (
    <span aria-hidden className={cn(accentClass(hue, "tint"), "inline-flex size-8 shrink-0 items-center justify-center rounded-md", className)}>
      <Icon icon={FileText} />
    </span>
  );
}
