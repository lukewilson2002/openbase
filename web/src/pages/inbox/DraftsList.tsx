/**
 * Your drafts below the capture box, newest change first: the first line of each, how long ago, and
 * how many files it holds. Tapping one opens it in the box to carry on.
 */
import { useQuery } from "@tanstack/react-query";
import { FileText, Paperclip, SquarePen } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { InboxItem } from "@/api/types";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relativeTime";
import { draftPreview } from "./targets";

export function DraftsList({ openId, canStartNew, onOpen, onNew }: { openId: string | null; canStartNew: boolean; onOpen: (item: InboxItem) => void; onNew: () => void }) {
  const drafts = useQuery({ queryKey: keys.inbox, queryFn: api.inbox.list });
  const items = drafts.data;

  return (
    <section aria-labelledby="drafts-heading" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h2 id="drafts-heading" className="px-1 text-[0.8125rem] font-semibold text-muted">
          Drafts
        </h2>
        <Button size="sm" disabled={!canStartNew} onClick={onNew}>
          <SquarePen aria-hidden className="size-4" /> New note
        </Button>
      </div>
      {drafts.isPending ? (
        <div className="flex justify-center py-6">
          <Spinner className="size-4" label="Loading drafts" />
        </div>
      ) : drafts.isError ? (
        <Notice tone="error">Your drafts could not be loaded: {errorMessage(drafts.error)}</Notice>
      ) : items && items.length === 0 ? (
        <p className="px-1 text-[0.875rem] text-muted">No drafts. What you write above is saved here as you type.</p>
      ) : (
        <ul className="flex flex-col overflow-hidden rounded-[12px] border border-line bg-surface">
          {items?.map((d) => {
            const current = d.id === openId;
            return (
              <li key={d.id} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  onClick={() => onOpen(d)}
                  aria-current={current ? "true" : undefined}
                  className={cn("flex min-h-12 w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-hover focus-visible:bg-hover", current && "bg-primary-soft hover:bg-primary-soft")}
                >
                  <FileText aria-hidden className="size-[1.125rem] shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.9375rem]">{draftPreview(d)}</span>
                    <span className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                      {current ? "Open in the box" : relativeTime(d.updated_at)}
                      {d.attachments.length > 0 && (
                        <span className="inline-flex items-center gap-0.5">
                          <Paperclip aria-hidden className="size-3" />
                          {d.attachments.length} {d.attachments.length === 1 ? "file" : "files"}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
