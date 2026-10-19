/**
 * The files in the open draft, as chips with their size and a way to remove them; files still going
 * up show a spinner. A chip opens its file in a new tab (an image shows there, anything else
 * downloads); an inbox upload is readable by its uploader only, so that is the person here.
 */
import { X } from "lucide-react";
import { attachmentsApi } from "@/api/records";
import type { AttachmentRef } from "@/api/types";
import { FilePreview } from "@/components/record/FilePreview";
import { Spinner } from "@/components/ui/spinner";
import { formatBytes } from "@/lib/format";

const chip = "flex min-h-9 max-w-full items-center gap-2 rounded-[10px] border border-line bg-subtle px-2.5 py-1 text-[0.8125rem] pointer-coarse:min-h-11";

export function AttachmentChips({ files, uploading, onRemove }: { files: readonly AttachmentRef[]; uploading: readonly string[]; onRemove: (id: string) => void }) {
  if (files.length === 0 && uploading.length === 0) return null;
  return (
    <ul aria-label="Attached files" className="flex flex-wrap gap-2">
      {files.map((f) => {
        return (
          <li key={f.id} className={chip}>
            <a
              href={attachmentsApi.downloadUrl(f.id, f.filename)}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${f.filename}`}
              className="flex min-w-0 items-center gap-2 text-fg no-underline hover:underline"
            >
              <FilePreview file={f} src={attachmentsApi.thumbUrl(f.id)} size={24} />
              <span className="min-w-0 truncate">{f.filename}</span>
              <span className="shrink-0 text-xs text-muted">{formatBytes(f.size)}</span>
            </a>
            <button
              type="button"
              aria-label={`Remove ${f.filename}`}
              onClick={() => onRemove(f.id)}
              className="-mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg pointer-coarse:size-9"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </li>
        );
      })}
      {uploading.map((name, i) => (
        <li key={`${name}:${i}`} className={chip}>
          <Spinner className="size-4" label={`Uploading ${name}`} />
          <span className="min-w-0 truncate text-muted">{name}</span>
        </li>
      ))}
    </ul>
  );
}
