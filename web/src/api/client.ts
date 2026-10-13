/**
 * Minimal typed fetch wrapper for the OpenGrid JSON API.
 *
 * - same-origin cookies (`credentials: "same-origin"`), JSON in and out
 * - `X-OpenGrid-CSRF: 1` on every non-GET request (server rejects cookie-authenticated
 *   unsafe requests without it; see crates/server/src/http.rs)
 * - `X-Client-Id` (per tab) on every request so SSE echoes of our own writes can be skipped
 * - errors normalised to {@link ApiError} from `{"error": {"code", "message"}}`
 * - 401 -> redirect to /login unless already on a public/auth route
 */

export const CSRF_HEADER = "X-OpenGrid-CSRF";
export const CLIENT_ID_HEADER = "X-Client-Id";
const CLIENT_ID_KEY = "og-client-id";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
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

/** Routes reachable without a session; a 401 there must not bounce to /login. */
const PUBLIC_PREFIXES = [
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
  try {
    const text = await res.text();
    if (text) {
      const data: unknown = JSON.parse(text);
      const err = (data as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      if (err && typeof err === "object") {
        if (typeof err.code === "string") code = err.code;
        if (typeof err.message === "string") message = err.message;
      }
    }
  } catch {
    /* non-JSON error body: keep the status text */
  }
  return new ApiError(res.status, code, message);
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    [CLIENT_ID_HEADER]: getClientId(),
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
    res = await fetch(withQuery(path, opts.query), {
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
    if (err.status === 401 && !opts.skipAuthRedirect && !isPublicRoute(window.location.pathname)) {
      unauthorizedHandler(window.location.pathname + window.location.search);
    }
    throw err;
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, "bad_response", "The server sent an unexpected response.");
  }
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
