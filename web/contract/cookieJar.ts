/**
 * A tiny cookie jar around `fetch`, for the contract tests only. Node's fetch has no cookie
 * handling, and the real client relies on the browser to keep the session cookie.
 *
 * One jar = one browser profile. Install it as the global fetch with {@link as} while calling
 * the real API client, so the client code under test is unchanged.
 */
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export interface CookieJar {
  fetch: typeof fetch;
  /** Current cookies, name -> value. */
  cookies: Map<string, string>;
  /** HTTP status of the most recent response (the API client hides 200 vs 201 vs 204). */
  lastStatus: number;
  /** The client address this profile claims via X-Forwarded-For, if any. */
  ip: string | undefined;
  /** When set, sent as `X-Client-Id` on every request (it overrides the one the API client adds). */
  clientId: string | undefined;
}

function isExpired(attrs: string[]): boolean {
  for (const a of attrs) {
    const [k, v = ""] = a.split("=");
    const key = k?.trim().toLowerCase();
    if (key === "max-age" && Number(v) <= 0) return true;
    if (key === "expires" && Date.parse(v) < Date.now()) return true;
  }
  return false;
}

/**
 * @param ip address to present as the client (X-Forwarded-For). The contract server runs with
 *   OPENBASE_TRUST_PROXY=true (it only listens on loopback), which gives every profile its own
 *   rate-limit bucket and session `ip`.
 */
export function createCookieJar(ip?: string, clientId?: string): CookieJar {
  const cookies = new Map<string, string>();
  const jar: CookieJar = { fetch: undefined as unknown as typeof fetch, cookies, lastStatus: 0, ip, clientId };
  jar.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (ip) headers.set("x-forwarded-for", ip);
    if (jar.clientId) headers.set("x-client-id", jar.clientId);
    if (cookies.size > 0) headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await nativeFetch(input, { ...init, headers, redirect: "manual" });
    jar.lastStatus = res.status;
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || isExpired(attrs)) cookies.delete(name);
      else cookies.set(name, value);
    }
    return res;
  }) as typeof fetch;
  return jar;
}

/** Run `fn` (which calls the real API client) with `jar` acting as the browser. */
export async function as<T>(jar: CookieJar, fn: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = jar.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previous;
  }
}

/** The untouched fetch (no cookies), for raw requests that bypass the API client. */
export const rawFetch = nativeFetch;
