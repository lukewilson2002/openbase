import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { WorkspaceSummary } from "@/api/types";

/** Creates a workspace (with an icon and a colour, if chosen) and opens it. */
export function useCreateWorkspace() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    // Without a colour the server picks the next unused one.
    mutationFn: (v: { name: string; icon?: string | null; color?: string | null }) => api.workspaces.create(v.name, v.icon, v.color),
    onSuccess: async (ws) => {
      // Seed the list so the new page finds its workspace without a round trip.
      qc.setQueryData<WorkspaceSummary[]>(keys.workspaces, (cur) => (cur && !cur.some((w) => w.id === ws.id) ? [...cur, ws] : cur));
      void qc.invalidateQueries({ queryKey: keys.workspaces });
      await navigate(`/workspace/${ws.id}`);
    },
  });
}
