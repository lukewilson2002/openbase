/**
 * Minimal typed fetch wrapper for the OpenBase JSON API.
 *
 * - same-origin cookies (`credentials: "same-origin"`), JSON in and out
 * - `X-OpenBase-CSRF: 1` on every non-GET request (server rejects cookie-authenticated
 *   unsafe requests without it; see crates/server/src/http.rs)
 * - `X-Client-Id` (per tab) on every request so SSE echoes of our own writes can be skipped
 * - errors normalised to {@link ApiError} from `{"error": {"code", "message"}}`
 * - 401 -> redirect to /login unless already on a public/auth route (browser only)
 * - optional base URL ({@link setApiBase}) for non-browser callers such as the live
 *   contract tests (web/contract), which run this same client against a real server
 *
 * Response contract (crates/server/src/api): 200/201 carry a JSON body typed by the
 * generated DTOs; DELETE routes answer 204 with no body (`undefined` here); every
 * error is `{"error": {"code", "message"}}`.
 */

export const CSRF_HEADER = "X-OpenBase-CSRF";
export const CLIENT_ID_HEADER = "X-Client-Id";
const CLIENT_ID_KEY = "ob-client-id";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The rest of the error object, for the few errors that carry more than a message (`import_failed` lists rows). */
  readonly details: Readonly<Record<string, unknown>> | null;

  constructor(status: number, code: string, message: string, details: Readonly<Record<string, unknown>> | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Human-readable message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return "Something went wrong.";
}

function randomId(): string {
  const c = globalThis.crypto;
  // randomUUID is unavailable on plain-http origins other than localhost.
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

let memoryClientId: string | null = null;

/** Stable id for this browser tab (sessionStorage, so reloads keep it but new tabs get their own). */
export function getClientId(): string {
  try {
    const existing = sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const created = randomId();
    sessionStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch {
    memoryClientId ??= randomId();
    return memoryClientId;
  }
}

let apiBase = "";

/**
 * Prefix for every request path, e.g. `http://127.0.0.1:8080`. Empty (the default) means
 * same-origin relative URLs, which is what the browser app uses. Without a trailing slash.
 */
export function setApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, "");
}

/** Routes reachable without a session; a 401 there must not bounce to /login. */
const PUBLIC_PREFIXES = [
  // Share links and public forms are for people without an account (both spellings of each).
  "/share/",
  "/s/",
  "/form/",
  "/f/",
  "/login",
  "/setup",
  "/signup",
  "/invite/",
  "/forgot-password",
  "/reset-password",
];

export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`));
}

type UnauthorizedHandler = (returnTo: string) => void;

const defaultUnauthorizedHandler: UnauthorizedHandler = (returnTo) => {
  if (typeof window === "undefined") return; // not in a browser: callers see the ApiError
  const target = returnTo && returnTo !== "/" ? `/login?next=${encodeURIComponent(returnTo)}` : "/login";
  window.location.assign(target);
};

let unauthorizedHandler: UnauthorizedHandler = defaultUnauthorizedHandler;

/** The app installs a router-aware handler; tests install a spy. Pass null to restore the default. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler ?? defaultUnauthorizedHandler;
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON body (objects/arrays) or FormData for uploads. */
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
  /** Do not redirect to /login on 401 (the caller handles it). */
  skipAuthRedirect?: boolean;
  /** Extra request headers, e.g. `Authorization: Bearer <token>` for API-token callers. */
  headers?: Record<string, string>;
}

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

async function parseError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = res.statusText || `Request failed (${res.status})`;
  let details: Record<string, unknown> | null = null;
  try {
    const text = await res.text();
    if (text) {
      const data: unknown = JSON.parse(text);
      const err = (data as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      if (err && typeof err === "object") {
        if (typeof err.code === "string") code = err.code;
        if (typeof err.message === "string") message = err.message;
        details = err as Record<string, unknown>;
      }
    }
  } catch {
    /* non-JSON error body: keep the status text */
  }
  return new ApiError(res.status, code, message, details);
}

/** Send a request and return the successful response; every failure is thrown as an {@link ApiError}. */
async function send(path: string, opts: RequestOptions): Promise<Response> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    [CLIENT_ID_HEADER]: getClientId(),
    ...opts.headers,
  };
  if (method !== "GET") headers[CSRF_HEADER] = "1";

  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body; // the browser sets the multipart boundary
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(apiBase + withQuery(path, opts.query), {
      method,
      headers,
      body,
      credentials: "same-origin",
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "network", "Cannot reach the server. Check your connection and try again.");
  }

  if (!res.ok) {
    const err = await parseError(res);
    if (err.status === 401 && !opts.skipAuthRedirect && typeof window !== "undefined" && !isPublicRoute(window.location.pathname)) {
      unauthorizedHandler(window.location.pathname + window.location.search);
    }
    throw err;
  }
  return res;
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(path, opts);
  // 204 No Content (DELETE routes): there is no body to parse.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, "bad_response", "The server sent an unexpected response.");
  }
}

/** The file name a `Content-Disposition` header suggests (`filename*=UTF-8''…` wins over `filename="…"`). */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?'[^']*'([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"|filename\s*=\s*([^;]+)/.exec(header);
  const raw = plain?.[1] ?? plain?.[2];
  return raw ? raw.replace(/\\(.)/g, "$1").trim() : null;
}

/** A successful response read as a file (CSV export): the bytes and the name the server suggests. */
export async function requestFile(path: string, opts: RequestOptions = {}): Promise<{ blob: Blob; filename: string | null }> {
  const res = await send(path, { ...opts, headers: { Accept: "*/*", ...opts.headers } });
  return { blob: await res.blob(), filename: filenameFromDisposition(res.headers.get("Content-Disposition")) };
}

export const http = {
  get: <T>(path: string, opts?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...opts, method: "GET" }),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...opts, method: "POST", body: body ?? {} }),
  put: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...opts, method: "PUT", body: body ?? {} }),
  patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...opts, method: "PATCH", body: body ?? {} }),
  delete: <T>(path: string, opts?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...opts, method: "DELETE" }),
};
