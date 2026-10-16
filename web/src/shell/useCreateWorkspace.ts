import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { WorkspaceSummary } from "@/api/types";

/** Creates a workspace and opens it. */
export function useCreateWorkspace() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (v: { name: string; icon?: string | null }) => api.workspaces.create(v.name, v.icon),
    onSuccess: async (ws) => {
      // Seed the list so the new page finds its workspace without a round trip.
      qc.setQueryData<WorkspaceSummary[]>(keys.workspaces, (cur) => (cur && !cur.some((w) => w.id === ws.id) ? [...cur, ws] : cur));
      void qc.invalidateQueries({ queryKey: keys.workspaces });
      await navigate(`/workspace/${ws.id}`);
    },
  });
}
