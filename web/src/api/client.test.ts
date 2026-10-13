import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, filenameFromDisposition, getClientId, http, isPublicRoute, request, requestFile, setApiBase, setUnauthorizedHandler, withQuery } from "./client";
import { apiError, mockApi } from "@/test/utils";

describe("api client", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    setUnauthorizedHandler(null);
    vi.unstubAllGlobals();
  });

  it("sends the CSRF header on every non-GET request and not on GET", async () => {
    const api = mockApi({ "GET /api/x": { ok: 1 }, "POST /api/x": {}, "PATCH /api/x": {}, "PUT /api/x": {}, "DELETE /api/x": { status: 204 } });
    await http.get("/api/x");
    await http.post("/api/x", { a: 1 });
    await http.patch("/api/x", { a: 1 });
    await http.put("/api/x", { a: 1 });
    await http.delete("/api/x");

    const byMethod = Object.fromEntries(api.calls.map((c) => [c.method, c]));
    expect(byMethod.GET?.headers.get("X-OpenGrid-CSRF")).toBeNull();
    for (const m of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(byMethod[m]?.headers.get("X-OpenGrid-CSRF"), m).toBe("1");
    }
  });

  it("sends same-origin credentials, JSON body and the per-tab client id", async () => {
    const api = mockApi({ "POST /api/things": { id: "t1" } });
    const fetchSpy = vi.mocked(fetch);
    const out = await http.post<{ id: string }>("/api/things", { name: "n" });
    expect(out).toEqual({ id: "t1" });
    const call = api.calls[0]!;
    expect(call.body).toEqual({ name: "n" });
    expect(call.headers.get("Content-Type")).toBe("application/json");
    expect(call.headers.get("X-Client-Id")).toBe(getClientId());
    expect(fetchSpy.mock.calls[0]?.[1]?.credentials).toBe("same-origin");
  });

  it("keeps one client id per tab (sessionStorage) and generates a UUID-like value", () => {
    const first = getClientId();
    expect(first).toMatch(/^[0-9a-f-]{16,}$/i);
    expect(getClientId()).toBe(first);
    expect(sessionStorage.getItem("og-client-id")).toBe(first);
    sessionStorage.clear();
    expect(getClientId()).not.toBe(first);
  });

  it("falls back when crypto.randomUUID is unavailable (plain-http origins)", () => {
    sessionStorage.clear();
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => a.fill(7) });
    expect(getClientId()).toBe("07".repeat(16));
  });

  it("does not set a JSON content type for GET requests without a body", async () => {
    const api = mockApi({ "GET /api/y": [] });
    await http.get("/api/y");
    expect(api.calls[0]?.headers.get("Content-Type")).toBeNull();
  });

  it("maps {error:{code,message}} bodies to ApiError", async () => {
    mockApi({ "POST /api/auth/login": apiError(400, "bad_request", "Email is invalid") });
    const err = await http.post("/api/auth/login", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(400);
    expect(e.code).toBe("bad_request");
    expect(e.message).toBe("Email is invalid");
  });

  it("maps non-JSON error bodies and network failures", async () => {
    mockApi({ "GET /api/boom": { status: 502, text: "<html>Bad gateway</html>" } });
    const bad = (await http.get("/api/boom").catch((e: unknown) => e)) as ApiError;
    expect(bad).toBeInstanceOf(ApiError);
    expect(bad.status).toBe(502);
    expect(bad.code).toBe("http_502");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const net = (await http.get("/api/anything").catch((e: unknown) => e)) as ApiError;
    expect(net).toBeInstanceOf(ApiError);
    expect(net.status).toBe(0);
    expect(net.code).toBe("network");
  });

  it("returns undefined for 204 without parsing a body", async () => {
    mockApi({ "DELETE /api/z": { status: 204 } });
    expect(await http.delete("/api/z")).toBeUndefined();
  });

  it("treats an empty 200 body as a broken response instead of guessing", async () => {
    mockApi({ "POST /api/z": { status: 200, text: "" } });
    await expect(http.post("/api/z")).rejects.toMatchObject({ code: "bad_response" });
  });

  it("prefixes paths with the configured base URL and sends extra headers", async () => {
    const api = mockApi({ "GET /api/x": { ok: 1 } });
    setApiBase("http://127.0.0.1:9999/");
    try {
      await http.get("/api/x", { headers: { Authorization: "Bearer t" } });
    } finally {
      setApiBase("");
    }
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("http://127.0.0.1:9999/api/x");
    expect(api.calls[0]?.headers.get("authorization")).toBe("Bearer t");
  });

  describe("401 handling", () => {
    it("redirects to login with the current location when on a protected route", async () => {
      window.history.replaceState(null, "", "/base/app1/tbl1?x=1");
      mockApi({ "GET /api/bases/app1": apiError(401, "unauthorized", "authentication required") });
      const handler = vi.fn();
      setUnauthorizedHandler(handler);
      await expect(http.get("/api/bases/app1")).rejects.toMatchObject({ status: 401 });
      expect(handler).toHaveBeenCalledExactlyOnceWith("/base/app1/tbl1?x=1");
    });

    it.each(["/login", "/login/2fa", "/setup", "/signup", "/invite/abc", "/forgot-password", "/reset-password"])("does not redirect on public route %s", async (path) => {
      window.history.replaceState(null, "", path);
      mockApi({ "GET /api/anything": apiError(401, "unauthorized", "authentication required") });
      const handler = vi.fn();
      setUnauthorizedHandler(handler);
      await expect(http.get("/api/anything")).rejects.toBeInstanceOf(ApiError);
      expect(handler).not.toHaveBeenCalled();
    });

    it("honours skipAuthRedirect", async () => {
      window.history.replaceState(null, "", "/");
      mockApi({ "GET /api/auth/me": apiError(401, "unauthorized", "authentication required") });
      const handler = vi.fn();
      setUnauthorizedHandler(handler);
      await expect(request("/api/auth/me", { skipAuthRedirect: true })).rejects.toMatchObject({ isUnauthorized: true });
      expect(handler).not.toHaveBeenCalled();
    });

    it("does not treat 403 or 404 as unauthenticated", async () => {
      window.history.replaceState(null, "", "/");
      mockApi({ "GET /api/a": apiError(403, "forbidden", "no"), "GET /api/b": apiError(404, "not_found", "gone") });
      const handler = vi.fn();
      setUnauthorizedHandler(handler);
      await expect(http.get("/api/a")).rejects.toMatchObject({ isForbidden: true });
      await expect(http.get("/api/b")).rejects.toMatchObject({ isNotFound: true });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  it("builds query strings, skipping undefined and null", () => {
    expect(withQuery("/api/x", { a: 1, b: "two words", c: undefined, d: null, e: false })).toBe("/api/x?a=1&b=two+words&e=false");
    expect(withQuery("/api/x")).toBe("/api/x");
    expect(withQuery("/api/x?z=1", { a: 2 })).toBe("/api/x?z=1&a=2");
  });

  it("recognises public routes by prefix without matching lookalikes", () => {
    expect(isPublicRoute("/login")).toBe(true);
    expect(isPublicRoute("/login/2fa")).toBe(true);
    expect(isPublicRoute("/invite/tok")).toBe(true);
    expect(isPublicRoute("/loginx")).toBe(false);
    expect(isPublicRoute("/")).toBe(false);
    expect(isPublicRoute("/base/app1")).toBe(false);
  });

  it("treats share links and public forms as public routes in both spellings", () => {
    for (const p of ["/share/tok", "/s/tok", "/form/tok", "/f/tok"]) expect(isPublicRoute(p)).toBe(true);
    expect(isPublicRoute("/share")).toBe(false);
    expect(isPublicRoute("/formula/x")).toBe(false);
    expect(isPublicRoute("/sx/tok")).toBe(false);
  });

  it("keeps the rest of an error object for the few errors that carry more than a message", async () => {
    mockApi({ "POST /api/x": { status: 422, json: { error: { code: "import_failed", message: "nope", rows: [{ row: 2, message: "bad" }] } } } });
    const err = await http.post("/api/x", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).details).toMatchObject({ rows: [{ row: 2, message: "bad" }] });
  });

  it("does not bounce public requests to the login page on a 401 when the address bar is a share link", async () => {
    window.history.replaceState(null, "", "/share/tok_1");
    mockApi({ "GET /api/public/shares/tok_1": apiError(401, "share_password_required", "protected") });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(http.get("/api/public/shares/tok_1")).rejects.toMatchObject({ code: "share_password_required" });
    expect(handler).not.toHaveBeenCalled();
    window.history.replaceState(null, "", "/");
  });

  describe("files", () => {
    it("reads the file name from Content-Disposition, preferring the UTF-8 form", () => {
      expect(filenameFromDisposition('attachment; filename="My view.csv"; filename*=UTF-8\'\'My%20view%20%E2%9C%93.csv')).toBe("My view \u2713.csv");
      expect(filenameFromDisposition('attachment; filename="plain.csv"')).toBe("plain.csv");
      expect(filenameFromDisposition("attachment; filename=bare.csv")).toBe("bare.csv");
      expect(filenameFromDisposition(null)).toBeNull();
      expect(filenameFromDisposition("attachment")).toBeNull();
    });

    it("returns the bytes and the suggested name of a successful download", async () => {
      mockApi({ "GET /api/views/viw1/export.csv": { status: 200, text: "a,b\r\n", headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="Tasks.csv"' } } });
      const file = await requestFile("/api/views/viw1/export.csv", { query: { timezone: "UTC" } });
      expect(file.filename).toBe("Tasks.csv");
      expect(await file.blob.text()).toBe("a,b\r\n");
    });

    it("throws the API error for a failed download", async () => {
      mockApi({ "GET /api/views/viw1/export.csv": apiError(404, "not_found", "view not found") });
      await expect(requestFile("/api/views/viw1/export.csv")).rejects.toMatchObject({ status: 404, message: "view not found" });
    });
  });
});
