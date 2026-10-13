import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, HardDriveDownload } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { errorMessage } from "@/api/client";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageSpinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { formatBytes, formatDateTime } from "@/lib/format";

export function BackupsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const backups = useQuery({ queryKey: keys.adminBackups, queryFn: api.admin.backups });
  const create = useMutation({
    mutationFn: api.admin.createBackup,
    onSuccess: () => {
      toast.toast({ title: "Backup created", variant: "success" });
      void qc.invalidateQueries({ queryKey: keys.adminBackups });
      void qc.invalidateQueries({ queryKey: keys.adminStats });
    },
    onError: (e) => toast.error(e, "Backup failed"),
  });

  if (backups.isPending) return <PageSpinner label="Loading backups" />;
  if (backups.isError) return <Notice tone="error">{errorMessage(backups.error)}</Notice>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[0.8125rem] text-muted">Automatic daily backups are kept according to the retention setting. Download a copy to store it off this server.</p>
        <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
          <HardDriveDownload aria-hidden className="size-4" /> Create backup now
        </Button>
      </div>
      {backups.data.length === 0 ? (
        <EmptyState title="No backups yet" description="Create one now, or wait for the next scheduled backup." />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {backups.data.map((b) => (
            <li key={b.name} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate font-mono text-[0.8125rem]">{b.name}</p>
                <p className="text-xs text-muted">
                  {formatDateTime(b.created_at)} - {formatBytes(b.size)}
                </p>
              </div>
              <Button asChild size="sm">
                <a href={api.admin.backupUrl(b.name)} download={b.name}>
                  <Download aria-hidden className="size-4" /> Download
                </a>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
