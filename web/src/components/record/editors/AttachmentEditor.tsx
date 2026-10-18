/** Attachment editor: list, remove and upload files (button, drag and drop, or paste). */
import { useId, useRef, useState } from "react";
import { FileText, Upload, X } from "lucide-react";
import { attachmentsApi } from "@/api/records";
import type { AttachmentRef, Field } from "@/api/types";
import { errorMessage } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/cn";
import { attachmentRefs } from "@/lib/cells/kinds";
import { EditorShell } from "./EditorShell";
import { useEditorEnv, type FieldEditorCallbacks } from "./env";

export interface AttachmentEditorProps extends FieldEditorCallbacks {
  field: Field;
  value: unknown;
  variant: "cell" | "form";
  target?: { width: number; height: number };
}

export interface UploadResult {
  uploaded: AttachmentRef[];
  errors: string[];
}

/** Upload files one by one; failures are collected instead of aborting the rest. */
export async function uploadFiles(baseId: string, files: readonly File[]): Promise<UploadResult> {
  const uploaded: AttachmentRef[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      uploaded.push(await attachmentsApi.upload(baseId, f));
    } catch (e) {
      errors.push(`${f.name}: ${errorMessage(e)}`);
    }
  }
  return { uploaded, errors };
}

export function AttachmentThumb({ file, size = 40 }: { file: AttachmentRef; size?: number }) {
  const isImage = file.mime.startsWith("image/");
  return isImage ? (
    <img src={attachmentsApi.thumbUrl(file.id)} alt="" width={size} height={size} loading="lazy" className="rounded object-cover" style={{ width: size, height: size }} />
  ) : (
    <span className="flex items-center justify-center rounded bg-subtle text-muted" style={{ width: size, height: size }}>
      <FileText aria-hidden className="size-5" />
    </span>
  );
}

export function AttachmentEditor({ field, value, variant, target, onChange, onCommit: commitUp, onCancel }: AttachmentEditorProps) {
  const env = useEditorEnv();
  const [files, setFiles] = useState<AttachmentRef[]>(() => attachmentRefs(value));
  const filesRef = useRef(files);
  filesRef.current = files;
  const [busy, setBusy] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const closeRef = useRef<() => void>(() => {});
  const commit: FieldEditorCallbacks["onCommit"] = (edit, move) => {
    commitUp(edit, move);
    closeRef.current();
  };

  const set = (next: AttachmentRef[]) => {
    setFiles(next);
    onChange?.({ json: next });
  };

  const upload = async (list: readonly File[]) => {
    if (list.length === 0) return;
    setBusy((n) => n + list.length);
    const res = await uploadFiles(env.baseId, list);
    setBusy((n) => n - list.length);
    setErrors(res.errors);
    if (res.uploaded.length > 0) set([...filesRef.current, ...res.uploaded]);
  };

  return (
    <EditorShell
      variant={variant}
      target={target}
      onCancel={onCancel}
      width={360}
      onDismiss={() => {
        if (variant === "form") commitUp({ json: filesRef.current });
      }}
      triggerLabel={field.name}
      trigger={files.length > 0 ? <span>{files.length} file{files.length === 1 ? "" : "s"}</span> : <span className="text-faint">Add files…</span>}
    >
      {({ close }) => {
        closeRef.current = close;
        return (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void upload([...e.dataTransfer.files]);
            }}
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files];
              if (pasted.length > 0) {
                e.preventDefault();
                void upload(pasted);
              }
            }}
            className={cn("flex flex-col", dragging && "bg-primary-soft")}
          >
            <ul aria-label={`Files in ${field.name}`} className="max-h-60 min-h-12 overflow-y-auto overscroll-contain p-2">
              {files.map((f) => (
                <li key={f.id} className="flex items-center gap-2 py-1">
                  <AttachmentThumb file={f} />
                  <a href={attachmentsApi.downloadUrl(f.id, f.filename)} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-[0.8125rem]">
                    {f.filename}
                    <span className="ml-2 text-xs text-muted">{formatBytes(f.size)}</span>
                  </a>
                  <button type="button" aria-label={`Remove ${f.filename}`} onClick={() => set(files.filter((x) => x.id !== f.id))} className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
                    <X aria-hidden className="size-4" />
                  </button>
                </li>
              ))}
              {files.length === 0 && busy === 0 && <li className="py-3 text-center text-[0.8125rem] text-muted">Drop files here, paste them, or use Upload.</li>}
              {busy > 0 && (
                <li className="flex items-center gap-2 py-2 text-[0.8125rem] text-muted">
                  <Spinner className="size-3.5" label="Uploading" /> Uploading {busy} file{busy === 1 ? "" : "s"}…
                </li>
              )}
            </ul>
            {errors.length > 0 && (
              <ul role="alert" className="border-t border-line px-3 py-2 text-xs text-danger">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between gap-2 border-t border-line p-2">
              <input
                ref={inputRef}
                id={inputId}
                type="file"
                multiple
                className="sr-only"
                aria-label={`Upload files to ${field.name}`}
                onChange={(e) => {
                  void upload([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
              <Button size="sm" data-autofocus onClick={() => inputRef.current?.click()}>
                <Upload aria-hidden className="size-4" /> Upload
              </Button>
              <Button size="sm" variant="primary" onClick={() => commit({ json: filesRef.current })} disabled={busy > 0}>
                Done
              </Button>
            </div>
          </div>
        );
      }}
    </EditorShell>
  );
}
