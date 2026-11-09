/**
 * Filing an Inbox draft into a collection (HOME-8), through the same form a record page uses: the collection's title, the
 * property that takes the note and the one that takes the files, and the other properties. The draft's first line is its
 * title and the rest its page; the files it holds move into the record.
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { recordKeys } from "@/api/records";
import type { InboxItem, WorkspaceSummary } from "@/api/types";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field as Labelled, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { recordPath } from "@/lib/recordPath";
import { AttachmentChips } from "./AttachmentChips";
import { CollectionPicker } from "./CollectionPicker";
import { FileChooser, FormStatus, NoteChooser, OtherFields, TitleField } from "./TargetFormParts";
import { INBOX_CHOICE, lastCaptured, pickFileTarget, type TableRef, type TargetChoice } from "./capture";
import { NOTE_AS_COMMENT, fileFields, hasContent, isTextTitle, primaryField } from "./targets";
import { useCollections } from "./useCollections";
import { useTargetForm } from "./useTargetForm";

export function FileDraftDialog({ draft, workspace, onClose }: { draft: InboxItem; workspace: WorkspaceSummary; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  // Every collection the person can add to, whatever kind its title is: the form has an editor for each.
  const { found, loading } = useCollections(workspace, undefined, true, "any");
  const [chosen, setChosen] = useState<TableRef | null>(null);
  const ref = pickFileTarget(chosen, lastCaptured(workspace.id), found, workspace);
  const choice: TargetChoice = ref ? { kind: "collection", ...ref } : INBOX_CHOICE;
  const form = useTargetForm(ref);
  const [title, setTitle] = useState(draft.title);
  const [filing, setFiling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A text title takes the draft's title; any other kind of title has its own editor and the title leads the note instead.
  const primary = form.table ? primaryField(form.table) : undefined;
  const titleIsPrimary = !!primary && isTextTitle(primary);
  const note = !titleIsPrimary && title.trim() ? `${title.trim()}\n\n${draft.body}` : draft.body;
  const values = titleIsPrimary && primary ? { ...form.values, [primary.id]: title } : form.values;
  const fields = form.table ? fileFields({ table: form.table, values, note, noteFieldId: form.noteFieldId, attachments: draft.attachments, attachmentFieldId: form.fileFieldId }) : null;
  // A note filed as a comment is content enough for a record of its own.
  const asComment = form.noteFieldId === NOTE_AS_COMMENT && draft.body.trim() !== "";
  const canFile = !!form.table && !!fields && (hasContent(fields) || asComment) && Object.keys(form.errors).length === 0 && !filing;

  const file = async () => {
    if (!form.table || !fields || !canFile) return;
    const table = form.table;
    setFiling(true);
    setProblem(null);
    try {
      const record = await api.inbox.file(draft.id, { table_id: table.id, fields, ...(asComment ? { note_as_comment: true } : {}) });
      void qc.invalidateQueries({ queryKey: keys.inbox });
      void qc.invalidateQueries({ queryKey: keys.home(workspace.id) });
      void qc.invalidateQueries({ queryKey: recordKeys.table(table.id) });
      toast.toast({ title: `Filed to ${table.name}`, variant: "success", action: { label: "Open", onClick: () => navigate(recordPath(table.base_id, table.id, record.id)) } });
      onClose();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setFiling(false);
    }
  };

  const none = !loading && found.options.length === 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="File this draft"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={filing} disabled={!canFile} onClick={() => void file()}>
            File
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {none ? (
          <p className="text-label text-muted">You can't add records to any collection in this workspace yet. Ask for the Editor role on a folder, or make a collection of your own.</p>
        ) : (
          <div>
            <CollectionPicker options={found.options} loading={loading} value={choice} withInbox={false} verb="Files to" onPick={(c) => c.kind === "collection" && setChosen({ baseId: c.baseId, tableId: c.tableId })} />
          </div>
        )}
        <FormStatus form={form} />
        {titleIsPrimary && primary && (
          <Labelled label={primary.name}>{(ctl) => <Input {...ctl} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={1_000} autoComplete="off" className="max-md:text-read-phone" />}</Labelled>
        )}
        <TitleField form={form} />
        {draft.body.trim() && <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-subtle px-3 py-2 text-ui">{draft.body}</p>}
        {ref && <NoteChooser form={form} />}
        <AttachmentChips files={draft.attachments} uploading={[]} />
        <FileChooser form={form} count={draft.attachments.length} />
        <OtherFields form={form} />
        {problem && <Notice tone="error">{problem}</Notice>}
      </div>
    </Dialog>
  );
}
