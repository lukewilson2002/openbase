import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { errorMessage } from "@/api/client";
import { Notice, SettingsRow } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
        <p className="text-label text-muted">Automatic daily backups are kept according to the retention setting. Download a copy to store it off this server.</p>
        <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
          Create backup now
        </Button>
      </div>
      {backups.data.length === 0 ? (
        <EmptyState title="No backups yet" description="Create one now, or wait for the next scheduled backup." />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line" aria-label="Backups">
            {backups.data.map((b) => (
              <SettingsRow
                key={b.name}
                title={<span className="block truncate font-mono text-label">{b.name}</span>}
                description={`${formatDateTime(b.created_at)} - ${formatBytes(b.size)}`}
                action={
                  <Button asChild>
                    <a href={api.admin.backupUrl(b.name)} download={b.name}>
                      Download
                    </a>
                  </Button>
                }
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
