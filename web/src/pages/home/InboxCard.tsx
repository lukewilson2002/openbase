/**
 * Home's Inbox card (HOME-8): the person's drafts, which belong to them rather than to a workspace and so show on every Home.
 * Each has File (into a collection of this workspace, through the target form) and Delete.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Paperclip } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { InboxItem, WorkspaceSummary } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FeedRow } from "@/components/ui/feed-row";
import { Icon } from "@/components/ui/icon";
import { relativeTime } from "@/lib/relativeTime";
import { FileDraftDialog } from "./FileDraftDialog";
import { draftPreview } from "./targets";

export function InboxCard({ drafts, workspace }: { drafts: readonly InboxItem[]; workspace: WorkspaceSummary }) {
  const qc = useQueryClient();
  const [filing, setFiling] = useState<InboxItem | null>(null);
  const [deleting, setDeleting] = useState<InboxItem | null>(null);
  if (drafts.length === 0) return null;
  return (
    <section aria-labelledby="home-inbox" className="flex min-w-0 flex-col gap-2">
      <h2 id="home-inbox" className="text-h3 max-md:text-sheet">
        Inbox
      </h2>
      <Card padded={false}>
        <ul className="divide-y divide-line">
          {drafts.map((d) => (
            <li key={d.id}>
              <FeedRow
                title={draftPreview(d)}
                meta={
                  <span className="inline-flex items-center gap-2">
                    {relativeTime(d.updated_at)}
                    {d.attachments.length > 0 && (
                      <span className="inline-flex items-center gap-0.5">
                        <Icon icon={Paperclip} size="sm" />
                        {d.attachments.length} {d.attachments.length === 1 ? "file" : "files"}
                      </span>
                    )}
                  </span>
                }
                trailing={
                  <span className="flex items-center gap-1">
                    <Button size="sm" onClick={() => setFiling(d)} aria-label={`File ${draftPreview(d)}`}>
                      File
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(d)} aria-label={`Delete ${draftPreview(d)}`}>
                      Delete
                    </Button>
                  </span>
                }
              />
            </li>
          ))}
        </ul>
      </Card>
      {filing && <FileDraftDialog key={filing.id} draft={filing} workspace={workspace} onClose={() => setFiling(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this draft?"
        description="The text and the files in it are deleted. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          await api.inbox.remove(deleting.id);
          void qc.invalidateQueries({ queryKey: keys.inbox });
          void qc.invalidateQueries({ queryKey: keys.home(workspace.id) });
        }}
      />
    </section>
  );
}
