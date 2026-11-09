/**
 * The address of a record's page (decision 5): `/base/:baseId/:tableId/r/:recordId`, or with the view it
 * was opened from (which previous and next follow) `/base/:baseId/:tableId/:viewId/r/:recordId`.
 */
const e = encodeURIComponent;

export function recordPath(baseId: string, tableId: string, recordId: string, viewId?: string | null): string {
  return `/base/${e(baseId)}/${e(tableId)}${viewId ? `/${e(viewId)}` : ""}/r/${e(recordId)}`;
}

/**
 * Where an old `?record=` or `?linked=` link goes. The record modal and the linked-record panel stack (decision 5)
 * are gone, but emails, notifications and history carry their links. `linked` holds the steps opened on top of
 * the record (`tblB.recB,tblC.recC`); the last one is what the person was looking at, so it wins.
 */
export function legacyRecordTarget(baseId: string, tableId: string, viewId: string | undefined, search: string): string | null {
  const params = new URLSearchParams(search);
  const record = params.get("record");
  if (!record) return null;
  const steps = (params.get("linked") ?? "").split(",").filter(Boolean);
  const [linkedTable, linkedRecord] = (steps[steps.length - 1] ?? "").split(".");
  if (linkedTable && linkedRecord) return recordPath(baseId, linkedTable, linkedRecord);
  return recordPath(baseId, tableId, record, viewId);
}
