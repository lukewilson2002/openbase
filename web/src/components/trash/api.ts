import { http } from "@/api/client";
import type { RestoreRequest, TrashListing } from "@/api/types";

const enc = encodeURIComponent;

/** Days the server keeps deleted items unless the administrator changed `OPENGRID_TRASH_DAYS`. */
export const DEFAULT_RETENTION_DAYS = 30;

export const trashKeys = {
  base: (baseId: string) => ["trash", baseId] as const,
};

/** `restored_field_ids` lists fields restored along with it (a link field brings its inverse). */
export interface RestoreResult {
  ok: boolean;
  restored_field_ids?: string[];
}

export const trashApi = {
  list: (baseId: string) => http.get<TrashListing>(`/api/bases/${enc(baseId)}/trash`),
  restore: (body: RestoreRequest) => http.post<RestoreResult>("/api/trash/restore", body),
};
