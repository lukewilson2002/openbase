import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { describePublicError, describeSubmitError, safeRedirect } from "./publicErrors";

describe("describing a public page problem", () => {
  it("tells the two password answers apart", () => {
    expect(describePublicError(new ApiError(401, "share_password_required", "x"), "view")).toEqual({ kind: "password_required" });
    expect(describePublicError(new ApiError(401, "share_password_invalid", "x"), "view")).toEqual({ kind: "password_invalid" });
  });

  it("treats a missing link as not available, for forms and views", () => {
    expect(describePublicError(new ApiError(404, "not_found", "x"), "form")).toMatchObject({ kind: "not_found", title: "This form is not available" });
    expect(describePublicError(new ApiError(404, "not_found", "x"), "view")).toMatchObject({ kind: "not_found", title: "This page is not available" });
  });

  it("explains rate limits and a dead connection", () => {
    expect(describePublicError(new ApiError(429, "too_many_requests", "x"), "view")).toMatchObject({ kind: "rate_limited" });
    expect(describePublicError(new ApiError(0, "network", "x"), "view")).toMatchObject({ kind: "offline" });
  });

  it("passes other messages through", () => {
    expect(describePublicError(new ApiError(500, "internal", "Boom"), "view")).toMatchObject({ kind: "other", message: "Boom" });
    expect(describePublicError(new Error("odd"), "view")).toMatchObject({ kind: "other", message: "odd" });
  });
});

describe("describing a failed submission", () => {
  it("is specific for a closed form and for rate limits", () => {
    expect(describeSubmitError(new ApiError(404, "not_found", "x"))).toMatch(/closed/);
    expect(describeSubmitError(new ApiError(429, "too_many_requests", "x"))).toMatch(/Too many submissions/);
  });

  it("shows the server's own words for a rejected answer", () => {
    expect(describeSubmitError(new ApiError(400, "bad_request", 'field "Email" is required'))).toBe('field "Email" is required');
  });
});

describe("redirect addresses", () => {
  it("only follows http and https", () => {
    expect(safeRedirect("https://example.com/thanks")).toBe("https://example.com/thanks");
    expect(safeRedirect("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(safeRedirect("javascript:alert(1)")).toBeNull();
    expect(safeRedirect("data:text/html,hi")).toBeNull();
    expect(safeRedirect("//evil.example")).toBeNull();
    expect(safeRedirect("")).toBeNull();
    expect(safeRedirect(null)).toBeNull();
  });
});
