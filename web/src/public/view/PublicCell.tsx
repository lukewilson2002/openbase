/** A cell of a shared view: the signed-in display code, with attachments served through the share. */
import { CellValue } from "@/components/record/CellValue";
import type { Field } from "@/api/types";
import { attachmentRefs, displayShapeOf } from "@/lib/cells/kinds";
import { PublicAttachments } from "./PublicAttachments";
import { useShare } from "./ShareContext";

export function PublicCell({ field, value, className, compact, markdown = true }: { field: Field; value: unknown; className?: string; compact?: boolean; markdown?: boolean }) {
  const { format } = useShare();
  if (displayShapeOf(field) === "attachment") return <PublicAttachments files={attachmentRefs(value)} compact={compact} />;
  return <CellValue field={field} value={value} format={format} className={className} markdown={markdown} />;
}
