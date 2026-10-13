/**
 * Share links, public pages (shared views and forms) and CSV import/export (docs/api.md §3-4).
 *
 * - `sharesApi` is the management side (signed-in Creators): list/create/enable/disable/delete
 *   the links of a view.
 * - `publicApi` is what the public pages call. No credentials: the token in the URL is the
 *   capability, an optional password travels in `X-Share-Password` (held in memory by the page,
 *   never stored). Public calls never redirect to /login on a 401: `share_password_required` and
 *   `share_password_invalid` are answers the page handles itself.
 * - `csvApi` covers the three CSV endpoints. Imports are multipart; a rejected file answers
 *   422 `import_failed` with the first problem rows, surfaced as {@link ImportFailedError}.
 */
import { ApiError, http, request, requestFile, type RequestOptions } from "./client";
import type {
  AttachmentRef,
  CreateShare,
  FormSubmission,
  ImportResult,
  ImportRowError,
  OkResponse,
  PublicForm,
  PublicQueryResponse,
  PublicView,
  QueryRequest,
  ShareLink,
  UpdateShare,
} from "./types";

const enc = encodeURIComponent;

export const SHARE_PASSWORD_HEADER = "X-Share-Password";

/** Largest CSV the server accepts (`csv_io::MAX_FILE_BYTES`). */
export const MAX_CSV_BYTES = 20 * 1024 * 1024;

export const sharesApi = {
  list: (viewId: string) => http.get<ShareLink[]>(`/api/views/${enc(viewId)}/shares`),
  create: (viewId: string, body: CreateShare) => http.post<ShareLink>(`/api/views/${enc(viewId)}/shares`, body),
  /** `password: null` removes the password, a string sets it, leaving it out keeps it. */
  update: (id: string, body: UpdateShare) => http.patch<ShareLink>(`/api/shares/${enc(id)}`, body),
  remove: (id: string) => http.delete<void>(`/api/shares/${enc(id)}`),
};

/** The share password header for a request, when the visitor has entered one. */
function passwordHeaders(password: string | null | undefined): Record<string, string> | undefined {
  return password ? { [SHARE_PASSWORD_HEADER]: password } : undefined;
}

function publicOpts(password: string | null | undefined, signal?: AbortSignal): Pick<RequestOptions, "skipAuthRedirect" | "headers" | "signal"> {
  return { skipAuthRedirect: true, headers: passwordHeaders(password), signal };
}

export const publicApi = {
  form: (token: string, password?: string | null, signal?: AbortSignal) => http.get<PublicForm>(`/api/public/forms/${enc(token)}`, publicOpts(password, signal)),
  /** Creates one record anonymously. Values are keyed by the field ids of `PublicForm.fields`. */
  submitForm: (token: string, values: FormSubmission["values"], password?: string | null) =>
    http.post<{ ok: boolean }>(`/api/public/forms/${enc(token)}/submit`, { values } satisfies FormSubmission, publicOpts(password)),
  /** Uploads a file for an attachment field of the form; the answer goes into the submission. */
  uploadFormFile: (token: string, file: File, password?: string | null, signal?: AbortSignal) => {
    const body = new FormData();
    body.append("file", file, file.name);
    return request<AttachmentRef>(`/api/public/forms/${enc(token)}/attachments`, { method: "POST", body, ...publicOpts(password, signal) });
  },
  view: (token: string, password?: string | null, signal?: AbortSignal) => http.get<PublicView>(`/api/public/shares/${enc(token)}`, publicOpts(password, signal)),
  query: (token: string, body: QueryRequest, password?: string | null, signal?: AbortSignal) =>
    http.post<PublicQueryResponse>(`/api/public/shares/${enc(token)}/query`, body, publicOpts(password, signal)),
  /**
   * URL of an attachment of a shared view. Browsers cannot send `X-Share-Password` from an `<img>`,
   * so this only works for links without a password; protected shares fetch the file with
   * {@link publicApi.attachmentBlob} instead.
   */
  attachmentUrl: (token: string, id: string, filename: string) => `/api/attachments/${enc(id)}/${enc(filename)}?share=${enc(token)}`,
  thumbUrl: (token: string, id: string) => `/api/attachments/${enc(id)}/thumb?share=${enc(token)}`,
  /** An attachment (or its thumbnail, `filename` null) fetched with the password header. */
  attachmentBlob: (token: string, id: string, filename: string | null, password: string | null | undefined, signal?: AbortSignal) =>
    requestFile(filename === null ? `/api/attachments/${enc(id)}/thumb` : `/api/attachments/${enc(id)}/${enc(filename)}`, { query: { share: token }, ...publicOpts(password, signal), headers: { Accept: "image/*,*/*", ...passwordHeaders(password) } }),
};

/** A rejected import: nothing was written; `rows` are the first problems (at most 50). */
export class ImportFailedError extends ApiError {
  readonly rows: ImportRowError[];
  readonly truncated: boolean;

  constructor(message: string, rows: ImportRowError[], truncated: boolean) {
    super(422, "import_failed", message);
    this.name = "ImportFailedError";
    this.rows = rows;
    this.truncated = truncated;
  }
}

function isRowError(v: unknown): v is ImportRowError {
  return !!v && typeof v === "object" && typeof (v as ImportRowError).row === "number" && typeof (v as ImportRowError).message === "string";
}

/** A 422 `import_failed` carries the offending rows next to the message; everything else passes through. */
async function importRequest(path: string, form: FormData): Promise<ImportResult> {
  try {
    return await request<ImportResult>(path, { method: "POST", body: form });
  } catch (e) {
    if (e instanceof ApiError && e.status === 422 && e.code === "import_failed" && Array.isArray(e.details?.["rows"])) {
      throw new ImportFailedError(e.message, (e.details["rows"] as unknown[]).filter(isRowError), e.details["truncated"] === true);
    }
    throw e;
  }
}

export interface ImportOptions {
  /** `{csvColumn: fieldId | null}`; keys are the header names the server derives (see lib/csv). */
  mapping?: Record<string, string | null>;
  hasHeader?: boolean;
}

function csvForm(file: File, hasHeader: boolean | undefined): FormData {
  const form = new FormData();
  form.append("file", file, file.name);
  if (hasHeader !== undefined) form.append("has_header", hasHeader ? "true" : "false");
  return form;
}

export const csvApi = {
  /** `GET /api/views/{id}/export.csv`: the view's visible fields, filter and sort applied. */
  exportView: (viewId: string, timezone?: string) => requestFile(`/api/views/${enc(viewId)}/export.csv`, { query: { timezone } }),
  /** Into an existing table (Editor). All or nothing. */
  importIntoTable: (tableId: string, file: File, opts: ImportOptions = {}) => {
    const form = csvForm(file, opts.hasHeader);
    if (opts.mapping) form.append("mapping", JSON.stringify(opts.mapping));
    return importRequest(`/api/tables/${enc(tableId)}/import`, form);
  },
  /** A new table with inferred field types (Creator). */
  importNewTable: (baseId: string, file: File, opts: { name?: string; hasHeader?: boolean } = {}) => {
    const form = csvForm(file, opts.hasHeader);
    if (opts.name) form.append("name", opts.name);
    return importRequest(`/api/bases/${enc(baseId)}/import`, form);
  },
};

export type { OkResponse };
