/**
 * Carrying on with an Inbox draft (HOME-8): its title, its text and its files, saved back to the draft with `PATCH
 * /api/inbox/{id}` so it can be filed later. The old Inbox page opened a draft in its box; on Home the capture box is for
 * new things, so a draft opens here.
 */
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Paperclip, X } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { InboxItem, WorkspaceSummary } from "@/api/types";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { AttachmentChips } from "./AttachmentChips";
import { useUploads } from "./useUploads";

export function EditDraftDialog({ draft, workspace, onClose }: { draft: InboxItem; workspace: WorkspaceSummary; onClose: () => void }) {
  const qc = useQueryClient();
  const chooser = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const uploads = useUploads(draft.id, (file) => api.inbox.upload(file), undefined, draft.attachments);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const sameFiles = uploads.files.length === draft.attachments.length && uploads.files.every((f, i) => f.id === draft.attachments[i]?.id);
  const changed = title !== draft.title || body !== draft.body || !sameFiles;
  // A draft is never empty: the server needs a title, text or a file.
  const hasContent = title.trim() !== "" || body.trim() !== "" || uploads.files.length > 0;
  const canSave = changed && hasContent && uploads.uploading.length === 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setProblem(null);
    try {
      await api.inbox.update(draft.id, { title: title.trim(), body: body.trim(), attachments: uploads.files });
      void qc.invalidateQueries({ queryKey: keys.inbox });
      void qc.invalidateQueries({ queryKey: keys.home(workspace.id) });
      onClose();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Edit draft"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!canSave} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Title">{(ctl) => <Input {...ctl} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={1_000} autoComplete="off" className="max-md:text-read-phone" />}</Field>
        <Field label="Text" hint="Markdown">
          {(ctl) => <Textarea {...ctl} rows={8} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20_000} className="max-md:text-read-phone" />}
        </Field>
        <div className="flex flex-col gap-2">
          <AttachmentChips files={uploads.files} uploading={uploads.uploading} onRemove={uploads.remove} />
          <div>
            <input
              ref={chooser}
              type="file"
              multiple
              tabIndex={-1}
              className="sr-only"
              aria-label="Add files to the draft"
              onChange={(e) => {
                void uploads.upload(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <Button onClick={() => chooser.current?.click()}>
              <Paperclip aria-hidden className="size-4" /> Add files
            </Button>
          </div>
        </div>
        {uploads.errors.length > 0 && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-label text-danger">
            <ul className="min-w-0 flex-1">
              {uploads.errors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            <button type="button" aria-label="Dismiss" onClick={uploads.dismissErrors} className="relative -my-1 inline-flex size-7 shrink-0 items-center justify-center rounded hover:bg-hover max-md:after:absolute max-md:after:-inset-2 pointer-coarse:after:absolute pointer-coarse:after:-inset-2">
              <X aria-hidden className="size-4" />
            </button>
          </div>
        )}
        {problem && <Notice tone="error">{problem}</Notice>}
      </form>
    </Dialog>
  );
}
