/**
 * Every error the server can produce answers with `{"error": {"code", "message"}}`, including the
 * ones raised before a handler runs (malformed bodies, unknown routes, CSRF, rate limits). The
 * web client's ApiError parsing depends on it. These tests are independent of flow.contract.test.ts.
 */
import { describe, expect, inject, it } from "vitest";
import { rawFetch } from "./cookieJar";

const { baseUrl } = inject("contract");

interface Envelope {
  error: { code: string; message: string };
}

async function send(method: string, path: string, init: { body?: string; contentType?: string | null; csrf?: boolean; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": "10.2.0.1", ...init.headers };
  if (init.csrf !== false) headers["x-opengrid-csrf"] = "1";
  if (init.contentType !== null) headers["content-type"] = init.contentType ?? "application/json";
  const res = await rawFetch(`${baseUrl}${path}`, { method, headers, body: init.body });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", text, json };
}

function expectEnvelope(res: Awaited<ReturnType<typeof send>>, status: number, code: string): Envelope["error"] {
  expect(res.contentType, `body: ${res.text}`).toContain("application/json");
  expect(res.status, `body: ${res.text}`).toBe(status);
  const err = (res.json as Envelope | undefined)?.error;
  expect(err, `body: ${res.text}`).toBeDefined();
  expect(err!.code).toBe(code);
  expect(typeof err!.message).toBe("string");
  expect(err!.message.length).toBeGreaterThan(0);
  return err!;
}

describe("error envelope", () => {
  it("answers malformed JSON with a 400 envelope that names the problem", async () => {
    const err = expectEnvelope(await send("POST", "/api/auth/login", { body: "{" }), 400, "bad_request");
    expect(err.message).toContain("invalid JSON request body");
    expectEnvelope(await send("POST", "/api/auth/login", { body: "" }), 400, "bad_request");
    expectEnvelope(await send("POST", "/api/auth/signup", { body: "[1,2,3]" }), 400, "bad_request");
  });

  it("answers a missing or mistyped field with a 400 that says which", async () => {
    const missing = expectEnvelope(await send("POST", "/api/auth/login", { body: JSON.stringify({ email: "a@example.test" }) }), 400, "bad_request");
    expect(missing.message).toContain("missing field `password`");
    const wrong = expectEnvelope(await send("POST", "/api/auth/login", { body: JSON.stringify({ email: 5, password: "x" }) }), 400, "bad_request");
    expect(wrong.message).toContain("invalid type");
  });

  it("answers a body without a JSON content type with a 400 envelope", async () => {
    const err = expectEnvelope(await send("POST", "/api/auth/login", { body: '{"email":"a","password":"b"}', contentType: "text/plain" }), 400, "bad_request");
    expect(err.message).toContain("Content-Type");
  });

  it("answers an unknown API route with a 404 envelope", async () => {
    expectEnvelope(await send("GET", "/api/definitely/not/here"), 404, "not_found");
  });

  it("answers the wrong method on a known route with a 405 envelope", async () => {
    expectEnvelope(await send("POST", "/api/setup", { body: "{}" }), 405, "method_not_allowed");
  });

  it("answers a cookie-authenticated write without the CSRF header with a 403 envelope", async () => {
    const res = await send("POST", "/api/auth/logout", { body: "{}", csrf: false, headers: { cookie: "og_session=whatever" } });
    expectEnvelope(res, 403, "forbidden");
  });

  it("answers a protected route without credentials with a 401 envelope", async () => {
    expectEnvelope(await send("GET", "/api/auth/me"), 401, "unauthorized");
    expectEnvelope(await send("GET", "/api/admin/users"), 401, "unauthorized");
    expectEnvelope(await send("GET", "/api/tokens/whoami", { headers: { authorization: "Bearer pat_nope" } }), 401, "unauthorized");
  });

  it("answers too many sign-in attempts with a 429 envelope", async () => {
    const ip = "10.2.0.77"; // its own rate-limit bucket
    const attempt = () => send("POST", "/api/auth/login", { body: JSON.stringify({ email: "ghost@example.test", password: "nope" }), headers: { "x-forwarded-for": ip } });
    let last = await attempt();
    for (let i = 0; i < 10 && last.status !== 429; i++) last = await attempt();
    expectEnvelope(last, 429, "too_many_requests");
  });
});
