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

/**
 * The credential behind an action, when it was not the person's own session: the connected app
 * (OAuth) or the personal access token that did it (`detail.via`, written by the server).
 */
export function viaOf(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const via = (detail as Record<string, unknown>)["via"];
  if (!via || typeof via !== "object") return null;
  const v = via as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === "string" ? x : "");
  if (v["kind"] === "oauth") return `connected app ${text(v["client"]) || text(v["grant_id"])}`;
  if (v["kind"] === "token") return `API token ${text(v["token"]) || text(v["token_id"])}`;
  return null;
}

/**
 * The audit log is cursor-paged (`GET /api/admin/audit?before=<id>&limit=<n>`, newest first):
 * each page returns `next_before`, the cursor for the next older page. `cursors` is the trail of
 * cursors visited so "Newer" can step back (the first page's cursor is null).
 */
export function AuditTab() {
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const before = cursors[cursors.length - 1] ?? null;
  const page = cursors.length - 1;
  const audit = useQuery({
    queryKey: keys.adminAudit(before),
    queryFn: () => api.admin.audit({ before, limit: AUDIT_PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  if (audit.isPending) return <PageSpinner label="Loading audit log" />;
  if (audit.isError) return <Notice tone="error">{errorMessage(audit.error)}</Notice>;

  const { entries, next_before } = audit.data;
  const older = next_before ?? null;

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
                <td className="px-3 py-2">
                  {e.user_email ?? e.user_id ?? "System"}
                  {viaOf(e.detail) && (
                    <span className="block text-xs text-muted">
                      via <bdi>{viaOf(e.detail)}</bdi>
                    </span>
                  )}
                </td>
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
          {entries.length > 0 ? `Page ${page + 1} (${entries.length} entries)` : "No entries"}
        </span>
        <div className="flex gap-2">
          <Button size="sm" disabled={page === 0} onClick={() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))}>
            <ChevronLeft aria-hidden className="size-4" /> Newer
          </Button>
          <Button size="sm" disabled={older === null} onClick={() => older !== null && setCursors((c) => [...c, older])}>
            Older <ChevronRight aria-hidden className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
