/** Attachment editor: list, reorder (by each file's handle), remove and upload files (button, drag and drop, or paste). */
import { useId, useRef, useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Upload, X } from "lucide-react";
import { attachmentsApi } from "@/api/records";
import type { AttachmentRef, Field } from "@/api/types";
import { errorMessage } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/cn";
import { attachmentRefs } from "@/lib/cells/kinds";
import { FilePreview } from "../FilePreview";
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

/** `files` with the file `activeId` moved to where `overId` is, or null when nothing moves. */
export function moveFile(files: readonly AttachmentRef[], activeId: string, overId: string | null): AttachmentRef[] | null {
  const from = files.findIndex((f) => f.id === activeId);
  const to = overId === null ? -1 : files.findIndex((f) => f.id === overId);
  return from >= 0 && to >= 0 && from !== to ? arrayMove([...files], from, to) : null;
}

/** A file's preview tile (see FilePreview), for a signed-in person. */
export function AttachmentThumb({ file, size = 40 }: { file: AttachmentRef; size?: number }) {
  return <FilePreview file={file} src={attachmentsApi.thumbUrl(file.id)} size={size} />;
}

/** One file of the editor's list: its handle (drag, or Space and the arrow keys), preview, name and Remove. */
function FileRow({ file, sortable, onRemove }: { file: AttachmentRef; sortable: boolean; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: file.id, disabled: !sortable });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn("flex items-center gap-2 rounded bg-surface py-1", isDragging && "relative z-10 shadow-pop")}>
      {sortable && (
        <button
          type="button"
          aria-label={`Drag ${file.filename} to reorder`}
          className="-mx-1 inline-flex h-10 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-faint hover:bg-hover hover:text-fg active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden className="size-4" />
        </button>
      )}
      <AttachmentThumb file={file} />
      <a href={attachmentsApi.downloadUrl(file.id, file.filename)} target="_blank" rel="noopener noreferrer" draggable={false} className="min-w-0 flex-1 truncate text-[0.8125rem]">
        {file.filename}
        <span className="ml-2 text-xs text-muted">{formatBytes(file.size)}</span>
      </a>
      <button type="button" aria-label={`Remove ${file.filename}`} onClick={onRemove} className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
        <X aria-hidden className="size-4" />
      </button>
    </li>
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

  // Files are put in order by their handles only, so a swipe elsewhere still scrolls the list.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onSortEnd = (e: DragEndEvent) => {
    const next = moveFile(filesRef.current, String(e.active.id), e.over ? String(e.over.id) : null);
    if (next) set(next);
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
            onKeyDown={(e) => {
              if (variant !== "cell" || busy > 0) return;
              // Tab is done, going on to the next cell; so is Enter (Ctrl or Cmd with it from anywhere), unless it is
              // pressing a button or following a link of the panel.
              const onControl = (e.target as Element).closest("button, a, input, [role='button']");
              if (e.key === "Tab") {
                e.preventDefault();
                e.stopPropagation();
                commit({ json: filesRef.current }, [e.shiftKey ? -1 : 1, 0]);
              } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || !onControl)) {
                e.preventDefault();
                e.stopPropagation();
                commit({ json: filesRef.current }, [0, e.shiftKey ? -1 : 1]);
              }
            }}
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
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onSortEnd}>
              <SortableContext items={files.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                <ul aria-label={`Files in ${field.name}`} className="max-h-60 min-h-12 overflow-y-auto overscroll-contain p-2">
                  {files.map((f) => (
                    <FileRow key={f.id} file={f} sortable={files.length > 1} onRemove={() => set(files.filter((x) => x.id !== f.id))} />
                  ))}
                  {files.length === 0 && busy === 0 && <li className="py-3 text-center text-[0.8125rem] text-muted">Drop files here, paste them, or use Upload.</li>}
                  {busy > 0 && (
                    <li className="flex items-center gap-2 py-2 text-[0.8125rem] text-muted">
                      <Spinner className="size-3.5" label="Uploading" /> Uploading {busy} file{busy === 1 ? "" : "s"}…
                    </li>
                  )}
                </ul>
              </SortableContext>
            </DndContext>
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
