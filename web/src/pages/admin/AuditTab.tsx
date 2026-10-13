import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { errorMessage } from "@/api/client";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageSpinner } from "@/components/ui/spinner";
import { formatDateTime } from "@/lib/format";

export const AUDIT_PAGE_SIZE = 50;

export function AuditTab() {
  const [page, setPage] = useState(0);
  const audit = useQuery({
    queryKey: keys.adminAudit(page),
    queryFn: () => api.admin.audit(AUDIT_PAGE_SIZE, page * AUDIT_PAGE_SIZE),
    placeholderData: keepPreviousData,
  });

  if (audit.isPending) return <PageSpinner label="Loading audit log" />;
  if (audit.isError) return <Notice tone="error">{errorMessage(audit.error)}</Notice>;

  const { entries, total } = audit.data;
  const from = page * AUDIT_PAGE_SIZE + 1;
  const to = page * AUDIT_PAGE_SIZE + entries.length;
  const hasNext = total !== undefined ? to < total : entries.length === AUDIT_PAGE_SIZE;

  if (entries.length === 0 && page === 0) return <EmptyState title="Nothing logged yet" description="Sign-ins and administrative actions appear here." />;

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[44rem] text-left text-[0.8125rem]">
          <thead className="border-b border-line bg-subtle text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">When</th>
              <th scope="col" className="px-3 py-2 font-medium">Who</th>
              <th scope="col" className="px-3 py-2 font-medium">Action</th>
              <th scope="col" className="px-3 py-2 font-medium">Target</th>
              <th scope="col" className="px-3 py-2 font-medium">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{formatDateTime(e.created_at)}</td>
                <td className="px-3 py-2">{e.user_email ?? e.user_id ?? "System"}</td>
                <td className="px-3 py-2 font-mono text-xs">{e.action}</td>
                <td className="max-w-56 truncate px-3 py-2 text-muted" title={e.detail ? JSON.stringify(e.detail) : undefined}>
                  {e.target ?? ""}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted">{e.ip ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-[0.8125rem] text-muted">
        <span>
          {entries.length > 0 ? `${from}-${to}` : "No entries"}
          {total !== undefined ? ` of ${total}` : ""}
        </span>
        <div className="flex gap-2">
          <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            <ChevronLeft aria-hidden className="size-4" /> Newer
          </Button>
          <Button size="sm" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>
            Older <ChevronRight aria-hidden className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
