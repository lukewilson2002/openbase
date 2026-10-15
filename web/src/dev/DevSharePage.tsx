/**
 * Dev-only harness (VITE_MOCK=1): opens the base-scope Share dialog over the mock base, so its
 * layout can be checked before the base screen wires it into its top bar. Not in production builds.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { ShareDialog } from "@/components/ShareDialog";

export default function DevSharePage() {
  const base = useQuery({ queryKey: keys.base("app1"), queryFn: () => api.bases.get("app1") });
  if (!base.data) return null;
  const table = base.data.tables[0]!;
  return <ShareDialog open onOpenChange={() => undefined} scope="base" base={base.data} workspaceName={base.data.workspace_name} table={table} view={table.views[0]} />;
}
