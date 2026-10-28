/**
 * Typed endpoint functions for records, view queries, comments, history, attachments and the
 * schema calls the grid issues (fields, formula check). Every shape here is the one the server
 * sends (docs/plans §3.1) and is verified by the live contract tests in web/contract, which run
 * these functions against the real server and check the responses against the generated types.
 *
 *   - record writes (create 201, update 200, restore 200, move 200) answer `RecordsResponse`;
 *   - `DELETE` of records and comments answers 204 (no body, `void` here);
 *   - lists (history, comments) are bare arrays;
 *   - field create/update answer the `Field` plus the link `inverse` and `removed_field_ids`
 *     when the change touched other fields; field delete answers `DeleteFieldResponse`.
 */
import { http, request } from "./client";
import type {
  AggregationsResponse,
  AttachmentRef,
  Comment,
  CreateField,
  CreateRecords,
  DeleteFieldResponse,
  Field,
  FormulaCheckResult,
  HistoryEntry,
  LinkCandidates,
  MoveRecords,
  QueryRequest,
  QueryResponse,
  RecordsResponse,
  TableRecord,
  TransientConfig,
  UpdateField,
  UpdateRecords,
} from "./types";

const enc = encodeURIComponent;

/** Query-key helpers. Everything is under `["records", tableId, ...]` so live events invalidate it. */
export const recordKeys = {
  table: (tableId: string) => ["records", tableId] as const,
  viewQuery: (tableId: string, viewId: string, configKey: string, search: string) => ["records", tableId, viewId, "query", configKey, search] as const,
  page: (tableId: string, viewId: string, configKey: string, search: string, page: number) => ["records", tableId, viewId, "query", configKey, search, page] as const,
  aggregations: (tableId: string, viewId: string, configKey: string, search: string) => ["records", tableId, viewId, "aggregations", configKey, search] as const,
  record: (tableId: string, recordId: string) => ["records", tableId, "record", recordId] as const,
  /** Several records by id (linked-record previews), in the order given. */
  byIds: (tableId: string, ids: readonly string[]) => ["records", tableId, "byIds", ids.join(",")] as const,
  lookup: (tableId: string, q: string, viewId: string | null, fields: readonly string[] = []) => ["records", tableId, "lookup", q, viewId ?? "", fields.join(",")] as const,
  history: (tableId: string, recordId: string) => ["records", tableId, "history", recordId] as const,
};

/** A field as returned by create/update, plus the inverse link field the server maintains. */
export type FieldMutationResult = Field & { inverse?: Field; removed_field_ids?: string[] };

export const recordsApi = {
  query: (viewId: string, body: QueryRequest, signal?: AbortSignal) => http.post<QueryResponse>(`/api/views/${enc(viewId)}/query`, body, { signal }),
  /**
   * Summaries over the records that pass the view filter and `search`. `transient` (only its
   * filter matters here) is sent JSON-encoded in the query string.
   */
  aggregations: (viewId: string, opts: { search?: string; timezone?: string; transient?: TransientConfig | null; signal?: AbortSignal } = {}) =>
    http.get<AggregationsResponse>(`/api/views/${enc(viewId)}/aggregations`, {
      query: { search: opts.search || undefined, timezone: opts.timezone, transient: opts.transient ? JSON.stringify(opts.transient) : undefined },
      signal: opts.signal,
    }),
  get: (tableId: string, recordId: string) => http.get<TableRecord>(`/api/tables/${enc(tableId)}/records/${enc(recordId)}`),
  create: (tableId: string, body: CreateRecords) => http.post<RecordsResponse>(`/api/tables/${enc(tableId)}/records`, body),
  update: (tableId: string, body: UpdateRecords) => http.patch<RecordsResponse>(`/api/tables/${enc(tableId)}/records`, body),
  /** DELETE with a JSON body of ids (soft delete: restorable from the trash); answers 204. */
  remove: (tableId: string, ids: string[]) => request<void>(`/api/tables/${enc(tableId)}/records`, { method: "DELETE", body: { ids } }),
  /**
   * Take back a record the caller has just added and never changed, leaving no trace (no trash, no
   * history). Answers `{discarded: false}` when it is no longer untouched, so it stays.
   */
  discard: (tableId: string, recordId: string) => http.post<{ discarded: boolean }>(`/api/tables/${enc(tableId)}/records/${enc(recordId)}/discard`, {}),
  restore: (tableId: string, ids: string[]) => http.post<RecordsResponse>(`/api/tables/${enc(tableId)}/records/restore`, { ids }),
  /** Copy records, each right after its original (computed fields are left to recalculate); answers the copies in order. At most 100 ids. */
  duplicate: (tableId: string, ids: string[]) => http.post<RecordsResponse>(`/api/tables/${enc(tableId)}/records/duplicate`, { ids }),
  move: (tableId: string, body: MoveRecords) => http.post<RecordsResponse>(`/api/tables/${enc(tableId)}/records/move`, body),
  /** Link picker candidates: `q` matches the primary field's text, and that of `fields` too. */
  lookup: (tableId: string, q: string, opts: { limit?: number; viewId?: string | null; fields?: readonly string[]; signal?: AbortSignal } = {}) =>
    http.get<LinkCandidates>(`/api/tables/${enc(tableId)}/records/lookup`, {
      query: { q, limit: opts.limit ?? 30, view_id: opts.viewId ?? undefined, fields: opts.fields?.length ? opts.fields.join(",") : undefined },
      signal: opts.signal,
    }),
  /** Records by id, in that order (at most 100 per request); ids that are not live records are left out. */
  getMany: (tableId: string, ids: readonly string[], signal?: AbortSignal) => http.post<RecordsResponse>(`/api/tables/${enc(tableId)}/records/get`, { ids }, { signal }),
  /** Newest first. Pass the last entry's id as `before` for the next page. */
  history: (recordId: string, opts: { before?: number; limit?: number } = {}) =>
    http.get<HistoryEntry[]>(`/api/records/${enc(recordId)}/history`, { query: { before: opts.before, limit: opts.limit } }),
};

export const commentsApi = {
  list: (recordId: string) => http.get<Comment[]>(`/api/records/${enc(recordId)}/comments`),
  create: (recordId: string, body: string) => http.post<Comment>(`/api/records/${enc(recordId)}/comments`, { body }),
  update: (commentId: string, body: string) => http.patch<Comment>(`/api/comments/${enc(commentId)}`, { body }),
  remove: (commentId: string) => http.delete<void>(`/api/comments/${enc(commentId)}`),
};

export const attachmentsApi = {
  /** Multipart upload; the field name is `file`. */
  upload: (baseId: string, file: File, signal?: AbortSignal) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<AttachmentRef>(`/api/bases/${enc(baseId)}/attachments`, { method: "POST", body: form, signal });
  },
  thumbUrl: (id: string) => `/api/attachments/${enc(id)}/thumb`,
  downloadUrl: (id: string, filename: string) => `/api/attachments/${enc(id)}/${enc(filename)}`,
};

export const schemaApi = {
  createField: (tableId: string, body: CreateField) => http.post<FieldMutationResult>(`/api/tables/${enc(tableId)}/fields`, body),
  updateField: (fieldId: string, body: UpdateField) => http.patch<FieldMutationResult>(`/api/fields/${enc(fieldId)}`, body),
  deleteField: (fieldId: string) => http.delete<DeleteFieldResponse>(`/api/fields/${enc(fieldId)}`),
  /** Live parse + type check of a formula against the table; `preview` is evaluated on `recordId` (default: the first record). */
  checkFormula: (tableId: string, expression: string, opts: { recordId?: string | null; signal?: AbortSignal } = {}) =>
    http.post<FormulaCheckResult>(`/api/tables/${enc(tableId)}/formula/check`, { expression, record_id: opts.recordId ?? null }, { signal: opts.signal }),
};
