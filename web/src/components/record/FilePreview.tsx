/**
 * A file as a square tile: its preview (an image itself, a PDF's first page, a video's first frame,
 * see lib/filePreview.ts) or, when it has none or the preview cannot be loaded, its type's tile
 * ("PDF", "DOCX"). Used wherever files are listed: record cells, the file editor, cards' file
 * fields, share pages and the Inbox.
 */
import { useState } from "react";
import { Play } from "lucide-react";
import type { AttachmentRef } from "@/api/types";
import { cn } from "@/lib/cn";
import { fileExt, hasPreview, isVideo, previewAlignTop } from "@/lib/filePreview";

export interface FilePreviewProps {
  file: AttachmentRef;
  /** The preview's address, or null while it is not known yet (a protected share fetching it). */
  src: string | null;
  size?: number;
  className?: string;
}

export function FilePreview({ file, src, size = 40, className }: FilePreviewProps) {
  // Remembered per file and address, so a cell showing another file tries again.
  const [failed, setFailed] = useState<string | null>(null);
  const key = `${file.id}|${src ?? ""}`;
  const box = { width: size, height: size };
  if (!hasPreview(file) || failed === key) {
    return (
      <span aria-hidden className={cn("flex shrink-0 select-none items-center justify-center rounded bg-subtle font-semibold text-muted", className)} style={{ ...box, fontSize: Math.max(8, Math.round(size / 4.5)) }}>
        {fileExt(file.filename)}
      </span>
    );
  }
  return (
    <span aria-hidden className={cn("relative block shrink-0 overflow-hidden rounded bg-subtle", className)} style={box}>
      {src && <img src={src} alt="" width={size} height={size} loading="lazy" draggable={false} onError={() => setFailed(key)} className={cn("size-full object-cover", previewAlignTop(file) && "object-top")} />}
      {isVideo(file) && (
        <span className="absolute bottom-0.5 left-0.5 flex items-center justify-center rounded-full bg-black/60 text-white" style={{ width: Math.max(12, size * 0.34), height: Math.max(12, size * 0.34) }}>
          <Play className="size-[55%] translate-x-[5%] fill-current" strokeWidth={0} />
        </span>
      )}
    </span>
  );
}
