import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { http } from "@/api/client";
import { keys } from "@/api/keys";
import type { CreateWorkspace, WorkspaceSummary } from "@/api/types";

/** Creates a workspace (with an icon and a colour, if chosen) and opens it. */
export function useCreateWorkspace() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    // Not `api.workspaces.create`, which takes only a name and an icon.
    mutationFn: (v: { name: string; icon?: string | null; color?: string | null }) => {
      const body: CreateWorkspace = { name: v.name, ...(v.icon ? { icon: v.icon } : {}), ...(v.color ? { color: v.color } : {}) };
      return http.post<WorkspaceSummary>("/api/workspaces", body);
    },
    onSuccess: async (ws) => {
      // Seed the list so the new page finds its workspace without a round trip.
      qc.setQueryData<WorkspaceSummary[]>(keys.workspaces, (cur) => (cur && !cur.some((w) => w.id === ws.id) ? [...cur, ws] : cur));
      void qc.invalidateQueries({ queryKey: keys.workspaces });
      await navigate(`/workspace/${ws.id}`);
    },
  });
}
