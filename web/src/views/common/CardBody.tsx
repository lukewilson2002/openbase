/** Cover image, title and field list shared by kanban and gallery cards. */
import type { Field, TableRecord } from "@/api/types";
import { CellValue } from "@/components/record/CellValue";
import { cn } from "@/lib/cn";
import type { FormatCtx } from "@/lib/cells/format";
import { paletteColor } from "@/lib/cells/palette";
import { cardTitle, coverUrl, fieldsToShow } from "./cardFields";

export interface CardBodyProps {
  record: TableRecord;
  primary: Field | undefined;
  fields: readonly Field[];
  coverField?: Field;
  /** How the cover fills its box: crop to fill or fit inside. */
  coverFit?: "cover" | "contain";
  coverHeight?: number;
  format: FormatCtx;
  emails: ReadonlyMap<string, string>;
  /** Palette colour name from `QueryResponse.colors`. */
  color?: string;
  limit?: number;
}

export function CardBody({ record, primary, fields, coverField, coverFit = "cover", coverHeight = 120, format, emails, color, limit }: CardBodyProps) {
  const cover = coverUrl(coverField, record);
  const shown = fieldsToShow(fields, record, format, limit);
  return (
    <>
      {color && <span aria-hidden data-row-color={color} className="absolute inset-y-0 left-0 w-1" style={{ background: paletteColor(color).bg }} />}
      {cover && (
        <div className="overflow-hidden rounded-t-[inherit] bg-subtle" style={{ height: coverHeight }}>
          <img src={cover} alt="" loading="lazy" draggable={false} className={cn("size-full", coverFit === "cover" ? "object-cover" : "object-contain")} />
        </div>
      )}
      <div className="flex flex-col gap-1.5 p-2.5">
        <p className="line-clamp-2 break-words text-[0.8125rem] font-semibold">{cardTitle(primary, record, format)}</p>
        {shown.map((f) => (
          <div key={f.id} className="min-w-0">
            <p className="truncate text-[0.6875rem] uppercase tracking-wide text-faint">{f.name}</p>
            <CellValue field={f} value={record.values[f.id] ?? null} format={format} emails={emails} className="line-clamp-3 text-xs" markdown={false} />
          </div>
        ))}
      </div>
    </>
  );
}
