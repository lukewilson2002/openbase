/**
 * Cover image, title, description and properties shared by kanban and gallery cards. A kanban card is a
 * List row on a card (title in 600, then its properties on one line, see CardProperties); a gallery card
 * has the width for a label above each value.
 */
import { useMemo, useState } from "react";
import { attachmentsApi } from "@/api/records";
import type { Field, TableRecord } from "@/api/types";
import { CellValue } from "@/components/record/CellValue";
import { cn } from "@/lib/cn";
import type { FormatCtx } from "@/lib/cells/format";
import { swatchColor } from "@/lib/cells/palette";
import { previewAlignTop } from "@/lib/filePreview";
import { cardTitle, coverOf, descriptionText, fieldsToShow } from "./cardFields";
import { CARD_PROPERTY_LIMIT, CardProperties } from "./CardProperties";
import { DescriptionHover } from "./description";

export interface CardBodyProps {
  record: TableRecord;
  primary: Field | undefined;
  /** Fields shown as label/value rows; leave the description field out of them. */
  fields: readonly Field[];
  coverField?: Field;
  /** Text field drawn under the title as a clamped preview (the whole of it on hover). */
  descriptionField?: Field;
  /** How the cover fills its box: crop to fill or fit inside. */
  coverFit?: "cover" | "contain";
  coverHeight?: number;
  /**
   * `rows`: the title, then the properties on one line (kanban cards stay short in a narrow stack);
   * `stacked`: a small label above each value (gallery cards have the width for it).
   */
  layout?: "rows" | "stacked";
  format: FormatCtx;
  emails: ReadonlyMap<string, string>;
  /** Palette colour name from `QueryResponse.colors`. */
  color?: string;
  limit?: number;
}

export function CardBody({ record, primary, fields, coverField, descriptionField, coverFit = "cover", coverHeight = 120, layout = "rows", format, emails, color, limit = CARD_PROPERTY_LIMIT }: CardBodyProps) {
  const coverFile = coverOf(coverField, record);
  // A file without a preview (the server answers 404) shows no cover rather than a broken image.
  const [failedCover, setFailedCover] = useState<string | null>(null);
  const cover = coverFile && failedCover !== coverFile.id ? attachmentsApi.thumbUrl(coverFile.id) : null;
  const shown = fieldsToShow(fields, record, format, limit);
  const title = cardTitle(primary, record, format);
  const descValue = descriptionField ? record.values[descriptionField.id] : undefined;
  // Rich text goes through the markdown parser; a board re-renders every card while one is dragged.
  const description = useMemo(() => descriptionText(descriptionField, descValue, format), [descriptionField, descValue, format]);
  return (
    <>
      {color && <span aria-hidden data-row-color={color} className="absolute inset-y-0 left-0 z-[1] w-1" style={{ background: swatchColor(color) }} />}
      {cover && (
        <div className="overflow-hidden rounded-t-[inherit] bg-subtle" style={{ height: coverHeight }}>
          <img src={cover} alt="" loading="lazy" draggable={false} onError={() => setFailedCover(coverFile?.id ?? null)} className={cn("size-full", coverFit === "cover" ? "object-cover" : "object-contain", coverFile && previewAlignTop(coverFile) && "object-top")} />
        </div>
      )}
      {layout === "rows" ? (
        <div className="flex flex-col gap-1 px-3.5 py-3">
          <h3 className="line-clamp-2 break-words text-ui font-semibold">{title}</h3>
          {description && (
            <DescriptionHover field={descriptionField} record={record} title={title} format={format}>
              <p data-card-description className="line-clamp-3 break-words text-label text-muted">
                {description}
              </p>
            </DescriptionHover>
          )}
          <CardProperties fields={shown} record={record} format={format} emails={emails} className="mt-0.5" />
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 px-4 pb-4 pt-3.5">
          <h3 className="line-clamp-2 break-words text-ui font-semibold">{title}</h3>
          {description && (
            <DescriptionHover field={descriptionField} record={record} title={title} format={format}>
              <p data-card-description className="-mt-1 line-clamp-3 break-words text-ui text-muted">
                {description}
              </p>
            </DescriptionHover>
          )}
          {shown.map((f) => (
            <div key={f.id} className="min-w-0">
              <p className="mb-0.5 truncate text-meta text-faint">{f.name}</p>
              <div className="flex min-h-5 items-center">
                <CellValue field={f} value={record.values[f.id] ?? null} format={format} emails={emails} className="line-clamp-3 text-ui" markdown={false} />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
