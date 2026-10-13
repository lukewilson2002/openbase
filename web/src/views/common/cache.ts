/**
 * Pure helpers over the cached result of a whole-view query (`ViewRecordsData`). Optimistic edits
 * in every view go through these so rollback is just "put the previous data back".
 */
import type { GroupHeader, TableRecord } from "@/api/types";

/** What `useViewRecords` caches: every record of the query (up to the cap) in view order. */
export interface ViewRecordsData {
  records: TableRecord[];
  /** Matching records on the server (may exceed `records.length` when truncated). */
  total: number;
  groups: GroupHeader[];
  /** Row colour (palette name) per record id. */
  colors: Record<string, string>;
  /** True when `total` exceeds the cap and only the first records were loaded. */
  truncated: boolean;
}

export function isViewRecordsData(v: unknown): v is ViewRecordsData {
  return !!v && typeof v === "object" && Array.isArray((v as ViewRecordsData).records) && typeof (v as ViewRecordsData).total === "number";
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0);
}

/** Apply view-form values (empty/null deletes the key) to one record; other records are shared. */
export function patchRecordValues(data: ViewRecordsData, recordId: string, values: Record<string, unknown>): ViewRecordsData {
  const i = data.records.findIndex((r) => r.id === recordId);
  if (i < 0) return data;
  const prev = data.records[i]!;
  const next: Record<string, unknown> = { ...prev.values };
  for (const [k, v] of Object.entries(values)) {
    if (isEmpty(v)) delete next[k];
    else next[k] = v;
  }
  const records = data.records.slice();
  records[i] = { ...prev, values: next as TableRecord["values"] };
  return { ...data, records };
}

/** Replace records by id with server versions (records not in the data are ignored). */
export function upsertRecords(data: ViewRecordsData, updated: readonly TableRecord[]): ViewRecordsData {
  const byId = new Map(updated.map((r) => [r.id, r] as const));
  if (!data.records.some((r) => byId.has(r.id))) return data;
  return { ...data, records: data.records.map((r) => byId.get(r.id) ?? r) };
}

/**
 * Move a record next to another one in the list (manual order). Returns the same data when the
 * anchor or the record is unknown, or the record is already there.
 */
export function moveRecordInList(data: ViewRecordsData, recordId: string, target: { beforeId?: string | null; afterId?: string | null }): ViewRecordsData {
  const anchorId = target.beforeId ?? target.afterId;
  if (!anchorId || anchorId === recordId) return data;
  const from = data.records.findIndex((r) => r.id === recordId);
  if (from < 0 || !data.records.some((r) => r.id === anchorId)) return data;
  const records = data.records.slice();
  const [rec] = records.splice(from, 1);
  const anchor = records.findIndex((r) => r.id === anchorId);
  records.splice(target.beforeId ? anchor : anchor + 1, 0, rec!);
  const unchanged = records.every((r, i) => r === data.records[i]);
  return unchanged ? data : { ...data, records };
}

/** Add a freshly created record (at the end unless `afterId` names a record in the list). */
export function insertRecord(data: ViewRecordsData, record: TableRecord, afterId?: string | null): ViewRecordsData {
  if (data.records.some((r) => r.id === record.id)) return data;
  const records = data.records.slice();
  const at = afterId ? records.findIndex((r) => r.id === afterId) : -1;
  records.splice(at >= 0 ? at + 1 : records.length, 0, record);
  return { ...data, records, total: data.total + 1 };
}

/** Remove records (deleted or no longer matching). */
export function removeRecords(data: ViewRecordsData, ids: ReadonlySet<string>): ViewRecordsData {
  if (!data.records.some((r) => ids.has(r.id))) return data;
  const records = data.records.filter((r) => !ids.has(r.id));
  return { ...data, records, total: Math.max(0, data.total - (data.records.length - records.length)) };
}
