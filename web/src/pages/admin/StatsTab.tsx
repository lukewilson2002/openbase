import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { errorMessage } from "@/api/client";
import { Notice } from "@/components/layouts";
import { Card } from "@/components/ui/card";
import { PageSpinner } from "@/components/ui/spinner";
import { formatBytes, formatDateTime, formatNumber } from "@/lib/format";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <dt className="text-label text-muted">{label}</dt>
      <dd className="num mt-1 break-words text-h2">{value}</dd>
    </Card>
  );
}

export function StatsTab() {
  const stats = useQuery({ queryKey: keys.adminStats, queryFn: api.admin.stats });
  if (stats.isPending) return <PageSpinner label="Loading statistics" />;
  if (stats.isError) return <Notice tone="error">{errorMessage(stats.error)}</Notice>;
  const s = stats.data;
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Users" value={formatNumber(s.users)} />
        <Stat label="Workspaces" value={formatNumber(s.workspaces)} />
        <Stat label="Folders" value={formatNumber(s.bases)} />
        <Stat label="Records" value={formatNumber(s.records)} />
        <Stat label="Database size" value={formatBytes(s.database_bytes)} />
        <Stat label="Attachments" value={formatBytes(s.attachments_bytes)} />
        <Stat label="Last backup" value={s.last_backup_at ? formatDateTime(s.last_backup_at) : "Never"} />
        <Stat label="Version" value={s.version} />
      </dl>
    </div>
  );
}
