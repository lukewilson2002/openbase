/**
 * The capture box of the Inbox: a rich text box with Attach files and Save to… under it. With no
 * table picked what is written is a draft, saved as it is typed. With a table picked the box
 * becomes that table's form (its primary field as the title, the note in a long text field, the
 * other fields below, the files in an attachment field) and Save files it as a new record.
 * Cmd/Ctrl+Enter is Save (or, for a plain note, "save the draft now").
 */
import { Suspense, lazy, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { FolderInput, Paperclip, X } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { recordKeys } from "@/api/records";
import type { InboxItem, WorkspaceSummary } from "@/api/types";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { AttachmentChips } from "./AttachmentChips";
import { FileChooser, FormStatus, NoteChooser, OtherFields, TargetBar, TitleField } from "./TargetFormParts";
import { TargetPicker } from "./TargetPicker";
import { NOTE_AS_COMMENT, fileFields, hasContent, isBlank, type TargetRef } from "./targets";
import { DraftsList } from "./DraftsList";
import { useDraft, type Draft } from "./useDraft";
import { useTargetForm } from "./useTargetForm";
import { useUploads } from "./useUploads";

// Tiptap is a chunk of its own, fetched when the Inbox opens (like the expanded record's rich text).
const RichTextEditor = lazy(() => import("@/components/richtext/RichTextEditor").then((m) => ({ default: m.RichTextEditor })));

/** A record that was just filed, for the "Open record" link. */
interface Filed {
  baseId: string;
  tableId: string;
  recordId: string;
  tableName: string;
}

export function Capture({ workspaces }: { workspaces: readonly WorkspaceSummary[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const draft = useDraft();
  const boxRef = useRef<HTMLElement>(null);
  const [target, setTarget] = useState<TargetRef | null>(null);
  const form = useTargetForm(target);
  const [picking, setPicking] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [filing, setFiling] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [filed, setFiled] = useState<Filed | null>(null);
  const uploads = useUploads(draft.attachments.length, draft.addAttachment);
  const input = useRef<HTMLInputElement>(null);

  const fields = form.table
    ? fileFields({ table: form.table, values: form.values, note: draft.body, noteFieldId: form.noteFieldId, attachments: draft.attachments, attachmentFieldId: form.fileFieldId })
    : null;
  const problems = Object.keys(form.errors).length > 0;
  // A note filed as a comment is content enough for a record of its own.
  const asComment = form.noteFieldId === NOTE_AS_COMMENT && draft.body.trim() !== "";
  const canFile = !!target && !!form.table && !!fields && (hasContent(fields) || asComment) && !problems && uploads.uploading.length === 0 && !filing;
  const hasDraft = draft.id !== null || !isBlank(draft.body, draft.attachments);

  const file = async () => {
    if (!form.table || !fields || !canFile) return;
    const table = form.table;
    setFiling(true);
    setFileError(null);
    try {
      // The draft has to exist (with its files) for the server to file it.
      const id = await draft.save(true);
      if (!id) throw new Error("The draft could not be saved, so it cannot be filed yet. Try again.");
      const record = await api.inbox.file(id, { table_id: table.id, fields, ...(asComment ? { note_as_comment: true } : {}) });
      qc.setQueryData<InboxItem[]>(keys.inbox, (list) => list?.filter((i) => i.id !== id));
      void qc.invalidateQueries({ queryKey: keys.inbox });
      void qc.invalidateQueries({ queryKey: recordKeys.table(table.id) });
      draft.reset();
      form.clear();
      setFiled({ baseId: table.base_id, tableId: table.id, recordId: record.id, tableName: table.name });
      toast.toast({ title: `Saved to ${table.name}`, variant: "success" });
    } catch (e) {
      setFileError(errorMessage(e));
    } finally {
      setFiling(false);
    }
  };

  const onKeyDownCapture = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    // Before the editor sees it: there Cmd+Enter would add a line break.
    e.preventDefault();
    e.stopPropagation();
    if (target) void file();
    else void draft.save();
  };

  const attach = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (input.current) input.current.value = "";
    if (files.length > 0) void uploads.upload(files);
  };

  /** Another draft (or a blank one) in the box. Its fields start empty; the table stays picked. */
  const open = async (item?: InboxItem) => {
    if (!(await draft.open(item))) return;
    form.clear();
    setFiled(null);
    setFileError(null);
    boxRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const pick = (t: TargetRef) => {
    setTarget(t);
    setPicking(false);
    setFileError(null);
  };

  return (
    <div className="flex flex-col gap-8">
    <section ref={boxRef} aria-label="Capture" className="flex flex-col rounded-[16px] border border-line-strong bg-surface shadow-sm focus-within:border-ring">
      <div className="flex flex-col gap-3 p-3 sm:p-4" onKeyDownCapture={onKeyDownCapture}>
        {filed && (
          <Notice tone="success">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1">Saved to {filed.tableName}.</span>
              <Link to={`/base/${filed.baseId}/${filed.tableId}?record=${filed.recordId}`} className="font-semibold underline underline-offset-2">
                Open record
              </Link>
              <button type="button" aria-label="Dismiss" onClick={() => setFiled(null)} className="-my-1 inline-flex size-7 items-center justify-center rounded hover:bg-black/5 pointer-coarse:size-9">
                <X aria-hidden className="size-4" />
              </button>
            </span>
          </Notice>
        )}
        {target && <TargetBar form={form} target={target} workspaces={workspaces} onChange={() => setPicking(true)} onRemove={() => setTarget(null)} />}
        {target && <FormStatus form={form} />}
        {target && <TitleField form={form} />}
        <Suspense
          fallback={
            <div className="flex min-h-[8rem] items-center justify-center rounded-md border border-line-strong">
              <Spinner label="Loading editor" />
            </div>
          }
        >
          <RichTextEditor key={draft.key} value={draft.body} onChange={draft.setBody} onBlur={() => void draft.save()} autoFocus={desktop} placeholder="Write something…" aria-label="Note" />
        </Suspense>
        {target && <NoteChooser form={form} />}
        <AttachmentChips files={draft.attachments} uploading={uploads.uploading} onRemove={draft.removeAttachment} />
        {uploads.errors.length > 0 && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-[0.8125rem] text-danger">
            <ul className="min-w-0 flex-1">
              {uploads.errors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            <button type="button" aria-label="Dismiss" onClick={uploads.dismissErrors} className="-my-1 inline-flex size-7 shrink-0 items-center justify-center rounded hover:bg-black/5 pointer-coarse:size-9">
              <X aria-hidden className="size-4" />
            </button>
          </div>
        )}
        {target && <FileChooser form={form} count={draft.attachments.length} />}
        {target && <OtherFields form={form} />}
        {fileError && <Notice tone="error">{fileError}</Notice>}
      </div>

      {/* Stays at the bottom of the screen while a long form scrolls, so Save is never a long way down. */}
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-b-[16px] border-t border-line bg-surface px-3 py-2.5 sm:px-4">
        <input ref={input} type="file" multiple tabIndex={-1} aria-label="Attach files" onChange={(e) => attach(e.target.files)} className="sr-only" />
        <Button size="sm" onClick={() => input.current?.click()}>
          <Paperclip aria-hidden className="size-4" /> Attach files
        </Button>
        {!target && (
          <Button size="sm" onClick={() => setPicking(true)}>
            <FolderInput aria-hidden className="size-4" /> Save to…
          </Button>
        )}
        <DraftStatus draft={draft} />
        <div className="ml-auto flex items-center gap-2">
          {hasDraft && (
            <Button size="sm" variant="ghost" onClick={() => setDiscarding(true)}>
              Discard
            </Button>
          )}
          {target && (
            <Button variant="primary" size="md" loading={filing} disabled={!canFile} onClick={() => void file()} title="Save (Ctrl+Enter)">
              Save
            </Button>
          )}
        </div>
      </div>

      <TargetPicker open={picking} onOpenChange={setPicking} workspaces={workspaces} onPick={pick} />
      <ConfirmDialog
        open={discarding}
        onOpenChange={setDiscarding}
        title="Discard this draft?"
        description="The text and the files in it are deleted. This cannot be undone."
        confirmLabel="Discard"
        destructive
        onConfirm={async () => {
          await draft.discard();
          form.clear();
          setFiled(null);
        }}
      />
    </section>
    <DraftsList openId={draft.id} canStartNew={hasDraft} onOpen={(item) => void open(item)} onNew={() => void open()} />
    </div>
  );
}

/** "Saving…", "Saved as draft", or what went wrong, announced politely. */
function DraftStatus({ draft }: { draft: Draft }) {
  return (
    <p role="status" aria-label="Draft status" aria-live="polite" className={cn("min-w-0 text-xs", draft.status === "error" ? "text-danger" : "text-muted")}>
      {draft.status === "saving" && "Saving…"}
      {draft.status === "saved" && "Saved as draft"}
      {draft.status === "error" && (
        <>
          Could not save the draft{draft.error ? `: ${draft.error}` : ""}{" "}
          <button type="button" onClick={() => void draft.save()} className="font-semibold underline underline-offset-2">
            Try again
          </button>
        </>
      )}
    </p>
  );
}
