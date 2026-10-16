/**
 * Read-only DOM rendering of a cell value (expanded record, revision history, previews).
 * The canvas renderer in views/grid/glide draws the same things for the grid.
 */
import { ExternalLink, Star, Heart } from "lucide-react";
import type { Field } from "@/api/types";
import { cn } from "@/lib/cn";
import { attachmentRefs, displayShapeOf } from "@/lib/cells/kinds";
import { chipItems, displayText, isFormulaError, type FormatCtx } from "@/lib/cells/format";
import { hrefFor, isSafeLink } from "@/lib/cells/text";
import { ratingColor } from "@/lib/cells/palette";
import { Markdown } from "./Markdown";
import { AttachmentThumb } from "./editors/AttachmentEditor";
import { Pill } from "./editors/ChoiceEditor";
import { LinkChip } from "./editors/LinkEditor";
import { UserChip } from "./editors/UserEditor";

export interface CellValueProps {
  field: Field;
  value: unknown;
  format: FormatCtx;
  /** Collaborator emails for avatars, by user id. */
  emails?: ReadonlyMap<string, string>;
  className?: string;
  /** Render rich long text as markdown (default true). */
  markdown?: boolean;
}

export function CellValue({ field, value, format, emails, className, markdown = true }: CellValueProps) {
  const shape = displayShapeOf(field);
  const text = displayText(field, value, format);
  const empty = <span className="text-faint">—</span>;
  const wrap = (children: React.ReactNode) => <div className={cn("min-w-0 text-[0.8125rem]", className)}>{children}</div>;

  if (isFormulaError(value)) return wrap(<span className="text-danger">{value.error}</span>);

  switch (shape) {
    case "checkbox":
      return wrap(value === true ? <span aria-label="Checked">✓</span> : empty);
    case "rating": {
      if (field.type !== "rating" || typeof value !== "number" || value <= 0) return wrap(empty);
      const Icon = field.options.icon === "heart" ? Heart : Star;
      const tint = ratingColor(field.options.color);
      return wrap(
        <span className="inline-flex gap-0.5" role="img" aria-label={`${value} of ${field.options.max}`}>
          {Array.from({ length: value }, (_, i) => (
            <Icon key={i} aria-hidden className="size-4" style={{ color: tint }} fill={tint} />
          ))}
        </span>,
      );
    }
    case "select":
    case "multi_select": {
      const chips = chipItems(field, value, format);
      return wrap(chips.length ? <span className="flex flex-wrap gap-1">{chips.map((c) => <Pill key={c.id} choice={{ name: c.text, color: c.color ?? "gray" }} />)}</span> : empty);
    }
    case "link": {
      const chips = chipItems(field, value, format);
      return wrap(chips.length ? <span className="flex flex-wrap gap-1">{chips.map((c) => <LinkChip key={c.id ?? c.text} name={c.text} />)}</span> : empty);
    }
    case "user": {
      const chips = chipItems(field, value, format);
      return wrap(chips.length ? <span className="flex flex-wrap gap-1">{chips.map((c) => <UserChip key={c.id ?? c.text} name={c.text} email={c.id ? emails?.get(c.id) : undefined} color={c.color} />)}</span> : empty);
    }
    case "list": {
      const chips = chipItems(field, value, format);
      return wrap(chips.length ? <span className="flex flex-wrap gap-1">{chips.map((c, i) => <span key={`${c.text}-${i}`} className="rounded-full bg-hover px-2 py-0.5 text-xs">{c.text}</span>)}</span> : empty);
    }
    case "attachment": {
      const files = attachmentRefs(value);
      return wrap(
        files.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {files.map((f) => (
              <li key={f.id} title={f.filename}>
                <AttachmentThumb file={f} size={48} />
              </li>
            ))}
          </ul>
        ) : (
          empty
        ),
      );
    }
    case "url":
    case "email":
    case "phone": {
      const href = typeof value === "string" ? hrefFor(shape, value) : null;
      if (!text) return wrap(empty);
      return wrap(
        href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all">
            {text}
            <ExternalLink aria-hidden className="size-3 shrink-0" />
          </a>
        ) : (
          <span className="break-all">{text}</span>
        ),
      );
    }
    case "button": {
      if (field.type !== "button" || typeof value !== "string" || !value) return wrap(empty);
      return wrap(
        isSafeLink(value) ? (
          <a href={value} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-fg no-underline hover:bg-primary-hover">
            {field.options.label}
          </a>
        ) : (
          <span className="text-muted">{field.options.label} (unsafe link)</span>
        ),
      );
    }
    case "long_text":
      if (!text) return wrap(empty);
      return wrap(field.type === "long_text" && field.options.rich && markdown ? <Markdown source={text} /> : <p className="whitespace-pre-wrap break-words">{text}</p>);
    default:
      return wrap(text ? <span className={cn("break-words", shape === "number" && "tabular-nums")}>{text}</span> : empty);
  }
}
