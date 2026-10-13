/**
 * The trash of a base: deleted tables, fields, views and records with a Restore button each.
 * `GET /api/bases/{id}/trash` (creators and owners) and `POST /api/trash/restore {kind, id}`.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Trash2 } from "lucide-react";
import { errorMessage } from "@/api/client";
import { keys } from "@/api/keys";
import type { BaseSchema, TrashItem } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { basePermissions } from "@/base/permissions";
import { relativeTime } from "@/lib/relativeTime";
import { DEFAULT_RETENTION_DAYS, trashApi, trashKeys } from "./api";
import { TRASH_KIND_LABELS, groupTrash, trashItemName } from "./groupTrash";

/** Toolbar button that opens the trash; renders nothing for roles that cannot see it. */
export function TrashButton({ schema }: { schema: BaseSchema }) {
  const [open, setOpen] = useState(false);
  if (!basePermissions.manageTables(schema.role)) return null;
  return (
    <>
      <IconButton label="Trash" onClick={() => setOpen(true)}>
        <Trash2 aria-hidden className="size-4" />
      </IconButton>
      {open && <TrashDialog open={open} onOpenChange={setOpen} schema={schema} />}
    </>
  );
}

function where(item: TrashItem, schema: BaseSchema): string | null {
  if (!item.table_id) return null;
  const table = schema.tables.find((t) => t.id === item.table_id);
  return table ? `in ${table.name}` : null;
}

export function TrashDialog({ open, onOpenChange, schema }: { open: boolean; onOpenChange: (open: boolean) => void; schema: BaseSchema }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [restoring, setRestoring] = useState<string | null>(null);
  const listing = useQuery({ queryKey: trashKeys.base(schema.id), queryFn: () => trashApi.list(schema.id), enabled: open, gcTime: 0, staleTime: 0 });

  const restore = useMutation({
    mutationFn: (item: TrashItem) => trashApi.restore({ kind: item.kind, id: item.id }),
    onMutate: (item) => setRestoring(`${item.kind}:${item.id}`),
    onSuccess: (_res, item) => {
      toast.toast({ title: `Restored ${trashItemName(item)}`, variant: "success" });
      void qc.invalidateQueries({ queryKey: trashKeys.base(schema.id) });
      // A restored table, field or view changes the schema; restored records show up in every view.
      void qc.invalidateQueries({ queryKey: keys.base(schema.id) });
      void qc.invalidateQueries({ queryKey: ["records"] });
    },
    onError: (e, item) => toast.error(e, `Could not restore ${trashItemName(item)}`),
    onSettled: () => setRestoring(null),
  });

  const groups = groupTrash(listing.data?.items ?? []);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Trash"
      size="lg"
      description={`Deleted tables, fields, views and records stay here for ${DEFAULT_RETENTION_DAYS} days by default, then they are removed for good. Restore brings one back as it was.`}
    >
      {listing.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner className="size-5" label="Loading the trash" />
        </div>
      ) : listing.isError ? (
        <div role="alert" className="flex flex-col items-center gap-2 py-8 text-center text-[0.8125rem]">
          <p className="text-muted">Could not load the trash: {errorMessage(listing.error)}</p>
          <Button size="sm" onClick={() => void listing.refetch()}>
            Try again
          </Button>
        </div>
      ) : groups.length === 0 ? (
        <p className="py-10 text-center text-[0.8125rem] text-muted">The trash is empty.</p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <section key={g.kind} aria-labelledby={`trash-${g.kind}`}>
              <h3 id={`trash-${g.kind}`} className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                {TRASH_KIND_LABELS[g.kind].plural} <span className="font-normal">({g.items.length})</span>
              </h3>
              <ul className="divide-y divide-line rounded-md border border-line">
                {g.items.map((item) => {
                  const key = `${item.kind}:${item.id}`;
                  const name = trashItemName(item);
                  const place = where(item, schema);
                  return (
                    <li key={key} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[0.8125rem] font-medium">{name}</p>
                        <p className="text-xs text-muted">
                          Deleted {relativeTime(item.deleted_at)}
                          {place ? ` ${place}` : ""}
                        </p>
                      </div>
                      <Button size="sm" aria-label={`Restore ${name}`} loading={restoring === key} disabled={restore.isPending} onClick={() => restore.mutate(item)}>
                        <RotateCcw aria-hidden className="size-3.5" /> Restore
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}
