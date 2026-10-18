/** Revision history of a record: who changed what, old -> new per field, formatted like the grid. */
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { recordKeys, recordsApi } from "@/api/records";
import type { Field, HistoryEntry } from "@/api/types";
import { Spinner } from "@/components/ui/spinner";
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

function Change({ field, name, oldValue, newValue, format }: { field: Field | undefined; name: string; oldValue: unknown; newValue: unknown; format: FormatCtx }) {
  const before = historyValueText(field, oldValue, format);
  const after = historyValueText(field, newValue, format);
  return (
    <li className="text-[0.8125rem]">
      <span className="font-medium">{name}</span>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
        <span className="max-w-full break-words rounded bg-danger-soft px-1.5 py-0.5 text-xs line-through decoration-danger/60">{before || "(empty)"}</span>
        <ArrowRight aria-label="changed to" className="size-3.5 shrink-0 text-muted" />
        <span className="max-w-full break-words rounded bg-success-soft px-1.5 py-0.5 text-xs">{after || "(empty)"}</span>
      </div>
    </li>
  );
}

function Entry({ entry, fields, format }: { entry: HistoryEntry; fields: readonly Field[]; format: FormatCtx }) {
  const byId = new Map(fields.map((f) => [f.id, f] as const));
  const changes = Object.entries(entry.changes);
  return (
    <li className="border-b border-line px-3 py-2.5 last:border-0">
      <div className="flex items-baseline gap-2">
        <span className="truncate text-[0.8125rem] font-medium">{entry.user_name ?? "Someone"}</span>
        <time dateTime={new Date(entry.created_at).toISOString()} className="text-xs text-muted">
          {formatDateTime(entry.created_at, format.timeZone)}
        </time>
      </div>
      {(entry.kind !== "update" || changes.length === 0) && <p className="text-xs text-muted">{KIND_LABELS[entry.kind] ?? entry.kind}</p>}
      {changes.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-2" aria-label="Changes">
          {changes.map(([fid, ch]) => (
            <Change key={fid} field={byId.get(fid)} name={byId.get(fid)?.name ?? "(deleted field)"} oldValue={ch.old} newValue={ch.new} format={format} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function HistoryPanel({ tableId, recordId, fields, format }: HistoryPanelProps) {
  const history = useQuery({ queryKey: recordKeys.history(tableId, recordId), queryFn: () => recordsApi.history(recordId) });
  if (history.isPending)
    return (
      <div className="flex justify-center py-6">
        <Spinner label="Loading history" />
      </div>
    );
  if (history.isError) return <p role="alert" className="p-3 text-[0.8125rem] text-danger">Could not load the history.</p>;
  const entries = (history.data ?? []).slice().sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  if (entries.length === 0) return <p className="p-3 text-[0.8125rem] text-muted">No changes recorded yet.</p>;
  return (
    <ul aria-label="Revision history" className="min-h-0 md:overflow-y-auto">
      {entries.map((e) => (
        <Entry key={e.id} entry={e} fields={fields} format={format} />
      ))}
    </ul>
  );
}
