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
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
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
    <div aria-busy>
      <Skeleton className="h-28" />
      <span className="sr-only" role="status">
        Loading editor
      </span>
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
    // The thread scrolls and the box under it stays in view, in the side panel and in the phone's full-screen sheet alike.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-live="polite" aria-busy={list.isPending}>
        {list.isPending && (
          <div className="flex flex-col gap-4 p-4">
            {[0, 1].map((i) => (
              <div key={i} aria-hidden className="flex gap-2">
                <Skeleton className="size-6 shrink-0 rounded-pill" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-4 w-full" />
                </div>
              </div>
            ))}
            <span className="sr-only" role="status">
              Loading comments
            </span>
          </div>
        )}
        {list.isError && (
          <p role="alert" className="p-4 text-label text-danger">
            Could not load comments.
          </p>
        )}
        {list.isSuccess && comments.length === 0 && <EmptyState title="No comments yet." description={canComment ? "Write the first one below." : undefined} />}
        <ul className="flex flex-col gap-4 p-4">
          {comments.map((c) => {
            const mine = !!currentUserId && c.user_id === currentUserId;
            const isEditing = editing?.id === c.id;
            return (
              <li key={c.id} className="flex gap-2" aria-label={`Comment by ${c.user_name ?? "a former user"}`}>
                <Avatar name={c.user_name} email={c.user_id ? emailOf.get(c.user_id) : undefined} color={c.user_id ? colorOf.get(c.user_id) : undefined} own={mine} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-h-control-sm items-center gap-2 max-md:min-h-0">
                    <span className="truncate text-label font-semibold">{c.user_name ?? "Former user"}</span>
                    <time dateTime={new Date(c.created_at).toISOString()} className="shrink-0 text-meta text-muted">
                      {formatDateTime(c.created_at, timeZone)}
                    </time>
                    {c.updated_at > c.created_at + 1000 && <span className="shrink-0 text-meta text-faint">(edited)</span>}
                    {mine && canComment && !isEditing && (
                      <span className="-my-1 ml-auto flex shrink-0">
                        <IconButton label="Edit comment" size="sm" noTooltip onClick={() => setEditing({ id: c.id, body: c.body })}>
                          <Icon icon={Pencil} />
                        </IconButton>
                        <IconButton label="Delete comment" size="sm" noTooltip onClick={() => setDeleting(c)}>
                          <Icon icon={Trash2} />
                        </IconButton>
                      </span>
                    )}
                  </div>
                  {isEditing ? (
                    <div className="mt-1 flex flex-col gap-2">
                      <CommentEditor label="Edit comment" value={editing.body} onChange={(body) => setEditing({ id: c.id, body })} people={collaborators} upload={upload} onSubmit={() => editing.body.trim() && save.mutate(editing)} autoFocus />
                      <div className="flex justify-end gap-2">
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
          className="shrink-0 border-t border-line p-4 max-md:pb-[max(1rem,env(safe-area-inset-bottom))]"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) post.mutate(draft.trim());
          }}
        >
          <CommentEditor label="Write a comment" placeholder="Write a comment. Type @ to mention someone." value={draft} onChange={setDraft} people={collaborators} upload={upload} onSubmit={() => draft.trim() && post.mutate(draft.trim())} />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-meta text-muted max-md:hidden pointer-coarse:hidden">Ctrl+Enter to send</span>
            <Button type="submit" size="sm" variant="primary" loading={post.isPending} disabled={!draft.trim()} className="max-md:ml-auto">
              <Icon icon={Send} /> Comment
            </Button>
          </div>
        </form>
      ) : (
        <p className="shrink-0 border-t border-line p-4 text-meta text-muted">You can read comments but not write them.</p>
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this comment?"
        description="It is removed for everyone. This cannot be undone."
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
