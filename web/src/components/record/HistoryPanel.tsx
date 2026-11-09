/** Revision history of a record: who changed what, old -> new per field, formatted like the grid. */
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { recordKeys, recordsApi } from "@/api/records";
import type { Field, HistoryEntry } from "@/api/types";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { displayText, type FormatCtx } from "@/lib/cells/format";
import { linkRefs } from "@/lib/cells/kinds";
import { formatDateTime } from "@/lib/format";

export interface HistoryPanelProps {
  tableId: string;
  recordId: string;
  fields: readonly Field[];
  format: FormatCtx;
}

const KIND_LABELS: Record<string, string> = {
  create: "Created this record",
  update: "Changed this record",
  delete: "Deleted this record",
  restore: "Restored this record",
};

/** Text of a historical value. Linked records may arrive as names or as bare ids. */
export function historyValueText(field: Field | undefined, value: unknown, format: FormatCtx): string {
  if (value === null || value === undefined) return "";
  if (!field) return typeof value === "object" ? JSON.stringify(value) : String(value);
  if (field.type === "link") {
    const refs = linkRefs(value);
    if (refs.length > 0 && refs.every((r) => r.name && r.name !== r.id)) return refs.map((r) => r.name).join(", ");
    return refs.length === 0 ? "" : `${refs.length} linked record${refs.length === 1 ? "" : "s"}`;
  }
  return displayText(field, value, format);
}

// A value as long as a page is cut after a few lines: the panel says what changed, not the whole text.
function Change({ field, name, oldValue, newValue, format }: { field: Field | undefined; name: string; oldValue: unknown; newValue: unknown; format: FormatCtx }) {
  const before = historyValueText(field, oldValue, format);
  const after = historyValueText(field, newValue, format);
  return (
    <li className="text-label">
      <span className="font-semibold">{name}</span>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <span className="line-clamp-6 max-w-full break-words rounded-sm bg-danger-soft px-1.5 py-0.5 line-through decoration-danger/60">{before || "(empty)"}</span>
        <Icon icon={ArrowRight} size="sm" aria-hidden={false} aria-label="changed to" role="img" className="text-muted" />
        <span className="line-clamp-6 max-w-full break-words rounded-sm bg-success-soft px-1.5 py-0.5">{after || "(empty)"}</span>
      </div>
    </li>
  );
}

function Entry({ entry, fields, format }: { entry: HistoryEntry; fields: readonly Field[]; format: FormatCtx }) {
  const byId = new Map(fields.map((f) => [f.id, f] as const));
  const changes = Object.entries(entry.changes);
  const who = entry.user_name ?? "Someone";
  return (
    <li className="flex gap-2 border-b border-line px-4 py-3 last:border-0">
      <Avatar name={entry.user_name} email={entry.user_id ? format.userEmail?.(entry.user_id) : undefined} color={entry.user_id ? format.userColor?.(entry.user_id) : undefined} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex min-h-control-sm items-center gap-2 max-md:min-h-0">
          <span className="truncate text-label font-semibold">{who}</span>
          <time dateTime={new Date(entry.created_at).toISOString()} className="shrink-0 text-meta text-muted">
            {formatDateTime(entry.created_at, format.timeZone)}
          </time>
        </div>
        {(entry.kind !== "update" || changes.length === 0) && <p className="text-meta text-muted">{KIND_LABELS[entry.kind] ?? entry.kind}</p>}
        {changes.length > 0 && (
          <ul className="mt-2 flex flex-col gap-3" aria-label="Changes">
            {changes.map(([fid, ch]) => (
              <Change key={fid} field={byId.get(fid)} name={byId.get(fid)?.name ?? "(deleted property)"} oldValue={ch.old} newValue={ch.new} format={format} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

export function HistoryPanel({ tableId, recordId, fields, format }: HistoryPanelProps) {
  const history = useQuery({ queryKey: recordKeys.history(tableId, recordId), queryFn: () => recordsApi.history(recordId) });
  if (history.isPending)
    return (
      <div aria-busy className="flex flex-col gap-4 p-4">
        {[0, 1, 2].map((i) => (
          <div key={i} aria-hidden className="flex gap-2">
            <Skeleton className="size-6 shrink-0 rounded-pill" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-4 w-full" />
            </div>
          </div>
        ))}
        <span className="sr-only" role="status">
          Loading history
        </span>
      </div>
    );
  if (history.isError)
    return (
      <p role="alert" className="p-4 text-label text-danger">
        Could not load the history.
      </p>
    );
  const entries = (history.data ?? []).slice().sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  if (entries.length === 0) return <EmptyState title="No changes recorded yet." />;
  return (
    // A scroll box with nothing to focus in it cannot be scrolled from the keyboard: it takes the focus itself.
    <ul aria-label="Revision history" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
      {entries.map((e) => (
        <Entry key={e.id} entry={e} fields={fields} format={format} />
      ))}
    </ul>
  );
}
