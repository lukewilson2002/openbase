/**
 * Read-only DOM rendering of a cell value (expanded record, revision history, previews).
 * The canvas renderer in views/grid/glide draws the same things for the grid.
 */
import { ExternalLink, Star, Heart } from "lucide-react";
import { attachmentsApi } from "@/api/records";
import type { Field } from "@/api/types";
import { cn } from "@/lib/cn";
import { attachmentRefs, displayShapeOf } from "@/lib/cells/kinds";
import { chipItems, displayText, isFormulaError, type FormatCtx } from "@/lib/cells/format";
import { hrefFor, isSafeLink } from "@/lib/cells/text";
import { ratingColor } from "@/lib/cells/palette";
import { Markdown } from "./Markdown";
import { AttachmentThumb } from "./editors/AttachmentEditor";
import { Pill } from "./editors/ChoiceEditor";
import { UserChip } from "./editors/UserEditor";
import { LinkChipList, LinkedRecordCards, useLinkCards } from "./linked/LinkedRecords";

export interface CellValueProps {
  field: Field;
  value: unknown;
  format: FormatCtx;
  /** Collaborator emails for avatars, by user id. */
  emails?: ReadonlyMap<string, string>;
  className?: string;
  /** Render rich text as markdown (default true). */
  markdown?: boolean;
  /** Attachments open their file (in a new tab) when clicked, instead of being pictures only. */
  linkFiles?: boolean;
}

/** Height of one row of chips (a person chip: a 16 px face and 2 px above and below). */
const CHIP_ROW_PX = 20;

export function CellValue({ field, value, format, emails, className, markdown = true, linkFiles = false }: CellValueProps) {
  const shape = displayShapeOf(field);
  const linkCards = useLinkCards();
  const text = displayText(field, value, format);
  const empty = <span className="text-faint">—</span>;
  const wrap = (children: React.ReactNode) => <div className={cn("min-w-0 text-[0.8125rem]", className)}>{children}</div>;
  // Chips are taller than a line of text, so a line clamp or `truncate` on their box cuts the tops
  // and bottoms off the pills and faces (WebKit clamps a flex row by text lines, not by its height).
  // They get the same limit counted in whole chip rows instead.
  const chipRow = (children: React.ReactNode) => {
    const lines = Number(/\bline-clamp-(\d)\b/.exec(className ?? "")?.[1] ?? 0);
    const oneLine = /\btruncate\b/.test(className ?? "");
    const rest = (className ?? "").replace(/\b(line-clamp-\d|truncate)\b/g, "");
    return (
      <div className={cn("min-w-0 text-[0.8125rem]", rest)}>
        <span className={cn("flex gap-1", oneLine ? "flex-nowrap overflow-hidden" : "flex-wrap", lines > 0 && "overflow-hidden")} style={lines > 0 ? { maxHeight: `${lines * CHIP_ROW_PX + (lines - 1) * 4}px` } : undefined}>
          {children}
        </span>
      </div>
    );
  };

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
      return chips.length ? chipRow(chips.map((c) => <Pill key={c.id} choice={{ name: c.text, color: c.color ?? "gray" }} />)) : wrap(empty);
    }
    case "link": {
      const chips = chipItems(field, value, format);
      if (!chips.length) return wrap(empty);
      const chipList = <LinkChipList field={field} chips={chips} format={format} emails={emails} className={(className ?? "").replace(/\b(line-clamp-\d|truncate)\b/g, "")} />;
      // In the record panel a link field's own records are cards; anywhere else (a card, a record's
      // summary inside one of those) they are small chips, the first few and "+N more".
      return linkCards && field.type === "link" ? wrap(<LinkedRecordCards field={field} value={value} format={format} emails={emails} fallback={chipList} />) : chipList;
    }
    case "user": {
      const chips = chipItems(field, value, format);
      return chips.length ? chipRow(chips.map((c) => <UserChip key={c.id ?? c.text} name={c.text} email={c.id ? emails?.get(c.id) : undefined} color={c.color} />)) : wrap(empty);
    }
    case "list": {
      const chips = chipItems(field, value, format);
      return chips.length ? chipRow(chips.map((c, i) => <span key={`${c.text}-${i}`} className="shrink-0 rounded-full bg-hover px-2 py-0.5 text-xs">{c.text}</span>)) : wrap(empty);
    }
    case "attachment": {
      const files = attachmentRefs(value);
      return wrap(
        files.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {files.map((f) => (
              <li key={f.id} title={f.filename}>
                {linkFiles ? (
                  <a href={attachmentsApi.downloadUrl(f.id, f.filename)} target="_blank" rel="noopener noreferrer" aria-label={f.filename} className="block">
                    <AttachmentThumb file={f} size={48} />
                  </a>
                ) : (
                  <AttachmentThumb file={f} size={48} />
                )}
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
    case "multiline":
      if (!text) return wrap(empty);
      return wrap(field.type === "rich_text" && markdown ? <Markdown source={text} /> : <p className="whitespace-pre-wrap break-words">{text}</p>);
    default:
      return wrap(text ? <span className={cn("break-words", shape === "number" && "tabular-nums")}>{text}</span> : empty);
  }
}
