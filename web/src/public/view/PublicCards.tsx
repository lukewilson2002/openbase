/** Read-only cards of a shared gallery and board: cover image, title and the first few filled fields. */
import { useMemo, useState } from "react";
import type { Field, TableRecord } from "@/api/types";
import { cardTitle, descriptionText, fieldsToShow, isDescriptionField } from "@/views/common/cardFields";
import { DescriptionHover } from "@/views/common/description";
import { buildStacks, stackKind } from "@/views/kanban/stacks";
import { cn } from "@/lib/cn";
import { attachmentRefs, displayShapeOf } from "@/lib/cells/kinds";
import { coverFile, previewAlignTop } from "@/lib/filePreview";
import { swatchColor } from "@/lib/cells/palette";
import { useThumbSrc } from "./PublicAttachments";
import { PublicCell } from "./PublicCell";
import { useShare } from "./ShareContext";

export interface CardFields {
  title: Field | undefined;
  /** Fields shown under the title (already without the title, cover, description and stack fields). */
  rest: readonly Field[];
  cover?: Field;
  /** Text drawn under the title as a clamped preview (boards). */
  description?: Field;
}

function Cover({ record, field, fit, height }: { record: TableRecord; field: Field; fit: "cover" | "contain"; height: number }) {
  const image = coverFile(attachmentRefs(record.values[field.id]));
  const src = useThumbSrc(image);
  const [broken, setBroken] = useState(false);
  if (!image || broken) return null;
  return (
    <div className="overflow-hidden rounded-t-[inherit] bg-subtle" style={{ height }}>
      {src && <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} className={cn("size-full", fit === "cover" ? "object-cover" : "object-contain", previewAlignTop(image) && "object-top")} />}
    </div>
  );
}

export function PublicCard({ record, fields, color, coverFit = "cover", coverHeight = 120 }: { record: TableRecord; fields: CardFields; color?: string; coverFit?: "cover" | "contain"; coverHeight?: number }) {
  const { format } = useShare();
  const shown = fieldsToShow(fields.rest, record, format);
  const descValue = fields.description ? record.values[fields.description.id] : undefined;
  const description = useMemo(() => descriptionText(fields.description, descValue, format), [fields.description, descValue, format]);
  return (
    <article data-record-id={record.id} aria-label={cardTitle(fields.title, record, format)} className="relative overflow-hidden rounded-lg border border-line bg-surface text-left shadow-sm">
      {color && <span aria-hidden data-row-color={color} className="absolute inset-y-0 left-0 z-[1] w-1" style={{ background: swatchColor(color) }} />}
      {fields.cover && <Cover record={record} field={fields.cover} fit={coverFit} height={coverHeight} />}
      <div className="flex flex-col gap-1.5 p-2.5">
        <h3 className="line-clamp-2 break-words text-[0.8125rem] font-semibold">{cardTitle(fields.title, record, format)}</h3>
        {description && (
          <DescriptionHover field={fields.description} record={record} title={cardTitle(fields.title, record, format)} format={format}>
            <p data-card-description className="-mt-0.5 line-clamp-3 break-words text-[0.8125rem] leading-[1.45] text-muted">
              {description}
            </p>
          </DescriptionHover>
        )}
        {shown.map((f) => (
          <div key={f.id} className="min-w-0">
            <p className="truncate text-[0.6875rem] uppercase tracking-wide text-faint">{f.name}</p>
            <PublicCell field={f} value={record.values[f.id] ?? null} compact className="line-clamp-3 text-xs" markdown={false} />
          </div>
        ))}
      </div>
    </article>
  );
}

/**
 * Which fields a card shows: everything visible except the title, the cover, the description and
 * (on boards) the stack field. `list` holds only the shared fields, so a description the view hides
 * (which the server never names) cannot appear.
 */
export function cardFieldsFor(list: readonly Field[], title: Field | undefined, coverId: string | null | undefined, exclude: ReadonlySet<string> = new Set(), descriptionId?: string | null): CardFields {
  const cover = list.find((f) => f.id === coverId && f.type === "attachment");
  const description = list.find((f) => f.id === descriptionId && f.id !== title?.id && isDescriptionField(f));
  const rest = list.filter((f) => f.id !== title?.id && f.id !== cover?.id && f.id !== description?.id && !exclude.has(f.id) && displayShapeOf(f) !== "button");
  return { title, rest, cover, description };
}

const GALLERY_STEP = 60;

export function PublicGallery({ records, fields, colors, fit }: { records: readonly TableRecord[]; fields: CardFields; colors: Readonly<Record<string, string>>; fit: "cover" | "contain" }) {
  const [shown, setShown] = useState(GALLERY_STEP);
  const visible = records.slice(0, shown);
  return (
    <div>
      <ul aria-label="Records" className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {visible.map((r) => (
          <li key={r.id}>
            <PublicCard record={r} fields={fields} color={colors[r.id]} coverFit={fit} coverHeight={160} />
          </li>
        ))}
      </ul>
      {records.length === 0 && <p className="py-10 text-center text-[0.8125rem] text-muted">No records to show.</p>}
      {records.length > shown && (
        <div className="mt-4 text-center">
          <button type="button" onClick={() => setShown((n) => n + GALLERY_STEP)} className="rounded-md border border-line-strong px-3 py-1.5 text-[0.8125rem] hover:bg-hover">
            Show more ({records.length - shown} left)
          </button>
        </div>
      )}
    </div>
  );
}

/** A board of read-only stacks. The stack field must be a single select, single user or checkbox. */
export function PublicKanban({ stackField, hideEmpty, records, fields, colors }: { stackField: Field; hideEmpty: boolean; records: readonly TableRecord[]; fields: CardFields; colors: Readonly<Record<string, string>> }) {
  const stacks = useMemo(() => (stackKind(stackField) ? buildStacks(stackField, records, { stackOrder: [], hideEmpty, people: [] }) : []), [stackField, records, hideEmpty]);
  return (
    <div role="list" aria-label="Stacks" className="flex items-start gap-3 overflow-x-auto pb-3">
      {stacks.map((stack) => (
        <section key={stack.key} role="listitem" aria-label={`Stack: ${stack.label}`} className="flex w-[min(18rem,85vw)] shrink-0 flex-col rounded-lg border border-line bg-subtle">
          <div className="flex items-center gap-1.5 px-2.5 py-2">
            {stack.color && <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: swatchColor(stack.color) }} />}
            <h3 className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold">{stack.label}</h3>
            <span className="text-xs tabular-nums text-muted" aria-label={`${stack.records.length} cards`}>
              {stack.records.length}
            </span>
          </div>
          <ul className="flex flex-col gap-2 px-2 pb-2" aria-label={`Cards in ${stack.label}`}>
            {stack.records.slice(0, 100).map((r) => (
              <li key={r.id}>
                <PublicCard record={r} fields={fields} color={colors[r.id]} />
              </li>
            ))}
            {stack.records.length === 0 && <li className="px-2 py-3 text-center text-xs text-faint">No cards</li>}
            {stack.records.length > 100 && <li className="px-2 py-1 text-center text-xs text-muted">and {stack.records.length - 100} more</li>}
          </ul>
        </section>
      ))}
    </div>
  );
}

