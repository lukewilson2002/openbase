/**
 * Typed endpoint functions for records, view queries, comments, history, attachments and the
 * schema calls the grid issues (fields, view config). Response shapes are exactly the DTOs in
 * `og_core::api::records` (the client never guesses; see the convention note in
 * crates/core/src/api/mod.rs and the response contract in ./client.ts).
 *
 * TODO(records handlers): crates/server/src/api/{records,comments}.rs are still stubs, so the
 * shapes below are assumed from the DTOs and must be re-checked against the live contract
 * tests once the handlers land:
 *   - GET    /api/records/{id}/comments  -> bare `Comment[]`
 *   - GET    /api/records/{id}/history   -> bare `HistoryEntry[]`
 *   - POST   /api/records/{id}/comments, PATCH /api/comments/{id} -> `Comment`
 *   - POST/PATCH /api/tables/{id}/records, POST .../records/restore, POST .../records/move
 *                                        -> `RecordsResponse`
 *   - DELETE /api/tables/{id}/records, DELETE /api/comments/{id} -> 204 No Content (`void`)
 * (Field create/update/delete are implemented server-side and typed from crates/server/src/api/fields.rs.)
 */
import { http, request } from "./client";
import type {
  AggregationsResponse,
  AttachmentRef,
  Comment,
  CreateField,
  CreateRecords,
  Field,
  HistoryEntry,
  LinkCandidates,
  MoveRecords,
  QueryRequest,
  QueryResponse,
  RecordsResponse,
  TableRecord,
  UpdateField,
  UpdateRecords,
  UpdateView,
  View,
} from "./types";

const enc = encodeURIComponent;

/** Query-key helpers. Everything is under `["records", tableId, ...]` so live events invalidate it. */
export const recordKeys = {
  table: (tableId: string) => ["records", tableId] as const,
  viewQuery: (tableId: string, viewId: string, configKey: string, search: string) => ["records", tableId, viewId, "query", configKey, search] as const,
  page: (tableId: string, viewId: string, configKey: string, search: string, page: number) => ["records", tableId, viewId, "query", configKey, search, page] as const,
  aggregations: (tableId: string, viewId: string, configKey: string, search: string) => ["records", tableId, viewId, "aggregations", configKey, search] as const,
  record: (tableId: string, recordId: string) => ["records", tableId, "record", recordId] as const,
  lookup: (tableId: string, q: string, viewId: string | null) => ["records", tableId, "lookup", q, viewId ?? ""] as const,
  history: (tableId: string, recordId: string) => ["records", tableId, "history", recordId] as const,
};

/** A field as returned by create/update, plus the inverse link field the server maintains. */
export type FieldMutationResult = Field & { inverse?: Field; removed_field_ids?: string[] };

/** `DELETE /api/fields/{id}` answer (crates/server/src/api/fields.rs): the field plus fields trashed with it. */
export interface DeleteFieldResult {
  ok: boolean;
  deleted_field_ids: string[];
}

export interface FormulaCheckResult {
  ok?: boolean;
  error?: string | null;
  result_type?: unknown;
  /** Rendered preview of the formula against a sample record. */
  preview?: unknown;
}

export const recordsApi = {
  query: (viewId: string, body: QueryRequest, signal?: AbortSignal) => http.post<QueryResponse>(`/api/views/${enc(viewId)}/query`, body, { signal }),
  aggregations: (viewId: string, search?: string, signal?: AbortSignal) =>
    http.get<AggregationsResponse>(`/api/views/${enc(viewId)}/aggregations`, { query: { search: search || undefined }, signal }),
  get: (tableId: string, recordId: string) => http.get<TableRecord>(`/api/tables/${enc(tableId)}/records/${enc(recordId)}`),
  create: (tableId: string, body: CreateRecords) => http.post<RecordsResponse>(`/api/tables/${enc(tableId)}/records`, body),
  update: (tableId: string, body: UpdateRecords) => http.patch<RecordsResponse>(`/api/tables/${enc(tableId)}/records`, body),
  /** DELETE with a JSON body of ids (soft delete: restorable from the trash). */
  remove: (tableId: string, ids: string[]) => request<void>(`/api/tables/${enc(tableId)}/records`, { method: "DELETE", body: { ids } }),
  restore: (tableId: string, ids: string[]) => http.post<RecordsResponse>(`/api/tables/${enc(tableId)}/records/restore`, { ids }),
  move: (tableId: string, body: MoveRecords) => http.post<RecordsResponse>(`/api/tables/${enc(tableId)}/records/move`, body),
  lookup: (tableId: string, q: string, opts: { limit?: number; viewId?: string | null; signal?: AbortSignal } = {}) =>
    http.get<LinkCandidates>(`/api/tables/${enc(tableId)}/records/lookup`, { query: { q, limit: opts.limit ?? 30, view_id: opts.viewId ?? undefined }, signal: opts.signal }),
  history: (recordId: string) => http.get<HistoryEntry[]>(`/api/records/${enc(recordId)}/history`),
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
  deleteField: (fieldId: string) => http.delete<DeleteFieldResult>(`/api/fields/${enc(fieldId)}`),
  /** The server answers with the updated view; the generated wrapper in endpoints.ts types it as void. */
  updateView: (viewId: string, body: UpdateView) => http.patch<View>(`/api/views/${enc(viewId)}`, body),
  /** Optional endpoint: a 404 means the server has no live formula check. */
  checkFormula: (tableId: string, expression: string, kind: "formula" | "rollup" = "formula", signal?: AbortSignal) =>
    http.post<FormulaCheckResult>(`/api/tables/${enc(tableId)}/formula/check`, { expression, kind }, { signal }),
};
