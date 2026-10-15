/** Cover image, title and field list shared by kanban and gallery cards. */
import type { Field, TableRecord } from "@/api/types";
import { CellValue } from "@/components/record/CellValue";
import { cn } from "@/lib/cn";
import type { FormatCtx } from "@/lib/cells/format";
import { swatchColor } from "@/lib/cells/palette";
import { cardTitle, coverUrl, fieldsToShow } from "./cardFields";

export interface CardBodyProps {
  record: TableRecord;
  primary: Field | undefined;
  fields: readonly Field[];
  coverField?: Field;
  /** How the cover fills its box: crop to fill or fit inside. */
  coverFit?: "cover" | "contain";
  coverHeight?: number;
  /**
   * `rows`: label and value side by side (kanban cards stay short in a narrow stack);
   * `stacked`: a small label above each value (gallery cards have the width for it).
   */
  layout?: "rows" | "stacked";
  format: FormatCtx;
  emails: ReadonlyMap<string, string>;
  /** Palette colour name from `QueryResponse.colors`. */
  color?: string;
  limit?: number;
}

export function CardBody({ record, primary, fields, coverField, coverFit = "cover", coverHeight = 120, layout = "rows", format, emails, color, limit }: CardBodyProps) {
  const cover = coverUrl(coverField, record);
  const shown = fieldsToShow(fields, record, format, limit);
  const title = cardTitle(primary, record, format);
  return (
    <>
      {color && <span aria-hidden data-row-color={color} className="absolute inset-y-0 left-0 z-[1] w-1" style={{ background: swatchColor(color) }} />}
      {cover && (
        <div className="overflow-hidden rounded-t-[inherit] bg-subtle" style={{ height: coverHeight }}>
          <img src={cover} alt="" loading="lazy" draggable={false} className={cn("size-full", coverFit === "cover" ? "object-cover" : "object-contain")} />
        </div>
      )}
      {layout === "rows" ? (
        <div className="px-3.5 py-3">
          <h3 className="line-clamp-2 break-words text-[0.875rem] font-semibold">{title}</h3>
          {shown.length > 0 && (
            <dl className="mt-2 grid grid-cols-[76px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-[0.8125rem]">
              {shown.map((f) => (
                <div key={f.id} className="contents">
                  <dt className="truncate text-faint">{f.name}</dt>
                  <dd className="min-w-0">
                    <CellValue field={f} value={record.values[f.id] ?? null} format={format} emails={emails} className="line-clamp-2 text-[0.8125rem]" markdown={false} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 px-4 pb-4 pt-3.5">
          <h3 className="line-clamp-2 break-words text-[0.9375rem] font-[650]">{title}</h3>
          {shown.map((f) => (
            <div key={f.id} className="min-w-0">
              <p className="mb-[3px] truncate text-xs text-faint">{f.name}</p>
              <div className="flex min-h-5 items-center">
                <CellValue field={f} value={record.values[f.id] ?? null} format={format} emails={emails} className="line-clamp-3 text-[0.875rem]" markdown={false} />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
