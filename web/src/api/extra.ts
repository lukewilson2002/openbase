/**
 * Wire shapes that the Rust DTO modules do not define (yet).
 *
 * The server handlers were still stubs when the web shell was written, so for
 * list endpoints the client accepts either a bare JSON array or an object
 * wrapping it (see `listOf`). Once the DTOs land in og_core::api they should
 * be exported through ts-rs and these shims removed.
 */
import type { AdminUpdateUser, AuditEntry } from "./types";

/** `PATCH /api/admin/users/{id}` also accepts clearing a user's 2FA. */
export type AdminUpdateUserRequest = AdminUpdateUser & { disable_two_factor?: boolean };

export interface AuditPage {
  entries: AuditEntry[];
  /** Total rows when the server reports it; otherwise undefined. */
  total?: number;
}

/** Result of accepting an invite; the target ids are optional hints for navigation. */
export interface AcceptInviteResult {
  workspace_id?: string | null;
  base_id?: string | null;
}

/** Pull an array out of `res`, which is either the array itself or `{ <key>: [...] }`. */
export function listOf<T>(res: unknown, ...keys: string[]): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object") {
    const obj = res as Record<string, unknown>;
    for (const k of keys) {
      const v = obj[k];
      if (Array.isArray(v)) return v as T[];
    }
    for (const v of Object.values(obj)) if (Array.isArray(v)) return v as T[];
  }
  return [];
}
