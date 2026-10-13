/**
 * What went wrong on a public page, in words a visitor can act on. The public endpoints answer
 * with a small, fixed set of problems (docs/api.md §3): a link that is switched off, deleted or of
 * the wrong kind is a plain 404; a protected link wants `X-Share-Password` (401
 * `share_password_required` / `share_password_invalid`); heavy use is a 429.
 */
import { ApiError } from "@/api/client";

export type PublicProblem =
  | { kind: "password_required" }
  | { kind: "password_invalid" }
  | { kind: "not_found"; title: string; message: string }
  | { kind: "rate_limited"; title: string; message: string }
  | { kind: "offline"; title: string; message: string }
  | { kind: "other"; title: string; message: string };

export function describePublicError(e: unknown, what: "form" | "view"): PublicProblem {
  if (e instanceof ApiError) {
    if (e.status === 401 && e.code === "share_password_required") return { kind: "password_required" };
    if (e.status === 401 && e.code === "share_password_invalid") return { kind: "password_invalid" };
    if (e.status === 404) {
      return {
        kind: "not_found",
        title: what === "form" ? "This form is not available" : "This page is not available",
        message: `The link may have been switched off or deleted, or the address may be mistyped. Ask the person who shared it with you for a new link.`,
      };
    }
    if (e.status === 429) {
      return { kind: "rate_limited", title: "Too many requests", message: "This link has been used a lot in a short time. Wait a minute and try again." };
    }
    if (e.status === 0) return { kind: "offline", title: "Cannot reach the server", message: "Check your connection and try again." };
    return { kind: "other", title: "Something went wrong", message: e.message };
  }
  return { kind: "other", title: "Something went wrong", message: e instanceof Error ? e.message : "Try again in a moment." };
}

/** The message for a failed submission, kept on the form so the visitor does not lose their answers. */
export function describeSubmitError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return "This form has been closed. Your answers were not saved.";
    if (e.status === 429) return "Too many submissions from your address in a short time. Wait a few minutes and try again.";
    if (e.status === 401) return "The password was refused. Reload the page and enter it again.";
    if (e.status === 413) return e.message;
    if (e.status === 0) return e.message;
    return e.message;
  }
  return e instanceof Error ? e.message : "Your answers could not be sent. Try again.";
}

/** Whether an address from the form config may be navigated to (http and https only). */
export function safeRedirect(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
