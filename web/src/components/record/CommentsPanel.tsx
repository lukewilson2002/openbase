/** Comment thread of a record: list, post with @mention autocomplete, edit and delete your own. */
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Send, Trash2 } from "lucide-react";
import { commentsApi } from "@/api/records";
import { keys } from "@/api/keys";
import type { Collaborator, Comment } from "@/api/types";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { personColors } from "@/lib/colors";
import { formatDateTime } from "@/lib/format";
import { insertMention, openMention, parseComment } from "./mentions";

export interface CommentsPanelProps {
  recordId: string;
  collaborators: readonly Collaborator[];
  currentUserId: string | null;
  /** Commenters and above may post; viewers only read. */
  canComment: boolean;
  timeZone: string;
}

export function CommentBody({ body }: { body: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-[0.8125rem]">
      {parseComment(body).map((p, i) =>
        p.kind === "text" ? (
          <span key={i}>{p.text}</span>
        ) : (
          <span key={i} className="rounded bg-primary-soft px-1 font-medium text-primary">
            @{p.name}
          </span>
        ),
      )}
    </p>
  );
}

/** A textarea that offers collaborators after typing `@`. */
function MentionTextarea({ value, onChange, collaborators, label, onSubmit, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; collaborators: readonly Collaborator[]; label: string; onSubmit: () => void; placeholder?: string; autoFocus?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const listId = useId();
  const open = openMention(value, caret);
  const matches = useMemo(() => {
    if (!open) return [];
    const q = open.query.toLowerCase();
    return collaborators.filter((c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().startsWith(q)).slice(0, 6);
  }, [open, collaborators]);
  const colors = useMemo(() => personColors(collaborators), [collaborators]);

  // The caret is restored after React has applied the new text (never before, or typing races it).
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(at, at);
    setCaret(at);
  });

  const choose = (c: Collaborator) => {
    if (!open) return;
    const out = insertMention(value, caret, open, { userId: c.id, name: c.name });
    pendingCaret.current = out.caret;
    onChange(out.text);
  };

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        aria-label={label}
        rows={3}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        maxLength={10000}
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={matches.length > 0 ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? 0);
          setActive(0);
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (matches.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % matches.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a - 1 + matches.length) % matches.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              const c = matches[active];
              if (c) choose(c);
              return;
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setCaret(0);
              return;
            }
          }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      {matches.length > 0 && (
        <ul id={listId} role="listbox" aria-label="People to mention" className="absolute bottom-full z-30 mb-1 w-64 overflow-hidden rounded-md border border-line bg-surface p-1 shadow-pop">
          {matches.map((c, i) => (
            <li key={c.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
              <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(c)} className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[0.8125rem]", i === active && "bg-hover")}>
                <Avatar name={c.name} email={c.email} color={colors.get(c.id)} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate">{c.name}</span>
                  <span className="block truncate text-xs text-muted">{c.email}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CommentsPanel({ recordId, collaborators, currentUserId, canComment, timeZone }: CommentsPanelProps) {
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
      <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
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
                      <MentionTextarea label="Edit comment" value={editing.body} onChange={(body) => setEditing({ id: c.id, body })} collaborators={collaborators} onSubmit={() => editing.body.trim() && save.mutate(editing)} autoFocus />
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
          <MentionTextarea label="Write a comment" placeholder="Write a comment. Type @ to mention someone." value={draft} onChange={setDraft} collaborators={collaborators} onSubmit={() => draft.trim() && post.mutate(draft.trim())} />
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
