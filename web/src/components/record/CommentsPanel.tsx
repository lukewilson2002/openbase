/**
 * Comment thread of a record: list, post, edit and delete your own. A comment is rich text, written in
 * the editor of rich text fields (with @mentions of the project's people, and files for those who
 * may upload them) and stored as Markdown; Markdown.tsx shows it.
 */
import { Suspense, lazy, useMemo, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Send, Trash2 } from "lucide-react";
import { commentsApi } from "@/api/records";
import { keys } from "@/api/keys";
import type { AttachmentRef, Collaborator, Comment } from "@/api/types";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { personColors } from "@/lib/colors";
import { formatDateTime } from "@/lib/format";
import { Markdown } from "./Markdown";

// Tiptap is a chunk of its own, fetched when a comment box first shows.
const RichTextEditor = lazy(() => import("@/components/richtext/RichTextEditor").then((m) => ({ default: m.RichTextEditor })));

export interface CommentsPanelProps {
  recordId: string;
  collaborators: readonly Collaborator[];
  currentUserId: string | null;
  /** Commenters and above may post; viewers only read. */
  canComment: boolean;
  timeZone: string;
  /** Uploads a file to the record's project (editors and above); without it comments cannot add files. */
  upload?: (file: File) => Promise<AttachmentRef>;
}

export function CommentBody({ body }: { body: string }) {
  return <Markdown source={body} className="break-words" />;
}

/** The rich text box of a comment; Ctrl/Cmd+Enter sends it. */
function CommentEditor({ value, onChange, onSubmit, label, placeholder, autoFocus, people, upload }: { value: string; onChange: (md: string) => void; onSubmit: () => void; label: string; placeholder?: string; autoFocus?: boolean; people: readonly Collaborator[]; upload?: (file: File) => Promise<AttachmentRef> }) {
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    // Before the editor sees it: there Cmd+Enter would add a line break.
    e.preventDefault();
    e.stopPropagation();
    onSubmit();
  };
  return (
    <div onKeyDownCapture={onKeyDownCapture}>
      <Suspense fallback={<EditorLoading />}>
        <RichTextEditor value={value} onChange={onChange} autoFocus={autoFocus} compact placeholder={placeholder} people={people} upload={upload} aria-label={label} />
      </Suspense>
    </div>
  );
}

function EditorLoading() {
  return (
    <div className="flex min-h-[7rem] items-center justify-center rounded-md border border-line-strong bg-surface">
      <Spinner label="Loading editor" />
    </div>
  );
}

export function CommentsPanel({ recordId, collaborators, currentUserId, canComment, timeZone, upload }: CommentsPanelProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: keys.comments(recordId), queryFn: () => commentsApi.list(recordId) });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [deleting, setDeleting] = useState<Comment | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.comments(recordId) });

  const post = useMutation({
    mutationFn: (body: string) => commentsApi.create(recordId, body),
    onSuccess: () => {
      setDraft("");
      void refresh();
    },
    onError: (e) => toast.error(e, "Could not post the comment"),
  });
  const save = useMutation({
    mutationFn: (v: { id: string; body: string }) => commentsApi.update(v.id, v.body),
    onSuccess: () => {
      setEditing(null);
      void refresh();
    },
    onError: (e) => toast.error(e, "Could not save the comment"),
  });

  const comments = (list.data ?? []).slice().sort((a, b) => a.created_at - b.created_at);
  const emailOf = new Map(collaborators.map((c) => [c.id, c.email] as const));
  const colorOf = useMemo(() => personColors(collaborators), [collaborators]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 md:overflow-y-auto" aria-live="polite">
        {list.isPending && (
          <div className="flex justify-center py-6">
            <Spinner label="Loading comments" />
          </div>
        )}
        {list.isError && <p role="alert" className="p-3 text-[0.8125rem] text-danger">Could not load comments.</p>}
        {list.isSuccess && comments.length === 0 && <p className="p-3 text-[0.8125rem] text-muted">No comments yet.</p>}
        <ul className="flex flex-col gap-3 p-3">
          {comments.map((c) => {
            const mine = !!currentUserId && c.user_id === currentUserId;
            const isEditing = editing?.id === c.id;
            return (
              <li key={c.id} className="flex gap-2" aria-label={`Comment by ${c.user_name ?? "a former user"}`}>
                <Avatar name={c.user_name} email={c.user_id ? emailOf.get(c.user_id) : undefined} color={c.user_id ? colorOf.get(c.user_id) : undefined} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[0.8125rem] font-medium">{c.user_name ?? "Former user"}</span>
                    <time dateTime={new Date(c.created_at).toISOString()} className="text-xs text-muted">
                      {formatDateTime(c.created_at, timeZone)}
                    </time>
                    {c.updated_at > c.created_at + 1000 && <span className="text-xs text-faint">(edited)</span>}
                    {mine && canComment && !isEditing && (
                      <span className="ml-auto flex shrink-0">
                        <IconButton label="Edit comment" size="sm" noTooltip onClick={() => setEditing({ id: c.id, body: c.body })}>
                          <Pencil aria-hidden className="size-3.5" />
                        </IconButton>
                        <IconButton label="Delete comment" size="sm" noTooltip onClick={() => setDeleting(c)}>
                          <Trash2 aria-hidden className="size-3.5" />
                        </IconButton>
                      </span>
                    )}
                  </div>
                  {isEditing ? (
                    <div className="mt-1 flex flex-col gap-1.5">
                      <CommentEditor label="Edit comment" value={editing.body} onChange={(body) => setEditing({ id: c.id, body })} people={collaborators} upload={upload} onSubmit={() => editing.body.trim() && save.mutate(editing)} autoFocus />
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                        <Button size="sm" variant="primary" loading={save.isPending} disabled={!editing.body.trim()} onClick={() => save.mutate(editing)}>
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <CommentBody body={c.body} />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      {canComment ? (
        <form
          className="border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) post.mutate(draft.trim());
          }}
        >
          <CommentEditor label="Write a comment" placeholder="Write a comment. Type @ to mention someone." value={draft} onChange={setDraft} people={collaborators} upload={upload} onSubmit={() => draft.trim() && post.mutate(draft.trim())} />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted">Ctrl+Enter to send</span>
            <Button type="submit" size="sm" variant="primary" loading={post.isPending} disabled={!draft.trim()}>
              <Send aria-hidden className="size-3.5" /> Comment
            </Button>
          </div>
        </form>
      ) : (
        <p className="border-t border-line p-3 text-xs text-muted">You can read comments but not write them.</p>
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this comment?"
        description="It will be removed for everyone."
        confirmLabel="Delete comment"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          await commentsApi.remove(deleting.id);
          await refresh();
        }}
      />
    </div>
  );
}
