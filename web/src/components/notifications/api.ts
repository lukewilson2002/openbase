import { http } from "@/api/client";
import type { MarkRead, OkResponse } from "@/api/types";

export const notificationsApi = {
  /** Mark the given notifications read; no ids marks all of them. */
  markRead: (ids?: string[]) => http.post<OkResponse>("/api/notifications/read", (ids && ids.length > 0 ? { ids } : {}) satisfies MarkRead),
};
