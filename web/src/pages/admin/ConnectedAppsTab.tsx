import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug, Trash2 } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { GrantInfo } from "@/api/types";
import { Notice } from "@/components/layouts";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { PageSpinner } from "@/components/ui/spinner";
import { formatDate } from "@/lib/format";
import { ACCESS_LABEL, accessOf } from "@/lib/oauthAccess";

/** Every user's connected apps (OAuth grants), with a Revoke button each. */
export function ConnectedAppsTab() {
  const qc = useQueryClient();
  const grants = useQuery({ queryKey: keys.adminOauthGrants, queryFn: api.admin.oauthGrants });
  const [revoking, setRevoking] = useState<GrantInfo | null>(null);

  if (grants.isPending) return <PageSpinner label="Loading connected apps" />;
  if (grants.isError) return <Notice tone="error">{errorMessage(grants.error)}</Notice>;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.8125rem] text-muted">Apps people connected through OAuth (Claude, ChatGPT, ...). Revoking one cuts it off at once; the person can approve it again.</p>
      {grants.data.length === 0 ? (
        <EmptyState icon={<Plug />} title="No connected apps" description="Nobody has connected an app yet." />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface" aria-label="Connected apps">
          {grants.data.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate text-[0.8125rem] font-medium">
                  {g.client_name}
                  <span className="ml-2 rounded-full bg-subtle px-2 py-0.5 text-xs font-normal text-muted">{ACCESS_LABEL[accessOf(g)]}</span>
                </p>
                <p className="text-xs text-muted">
                  {g.user_name ?? "?"} ({g.user_email ?? "?"}) - connects from {g.redirect_host} - {g.bases ? `${g.bases.length} base${g.bases.length === 1 ? "" : "s"}` : "all bases"}
                </p>
                <p className="text-xs text-muted">
                  Connected {formatDate(g.created_at)} - {g.last_used_at ? `last used ${formatDate(g.last_used_at)}` : "never used"}
                </p>
              </div>
              <IconButton label={`Revoke ${g.client_name} for ${g.user_email ?? "this user"}`} size="sm" onClick={() => setRevoking(g)}>
                <Trash2 aria-hidden className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke ${revoking?.client_name ?? "this app"}?`}
        description={`It stops working immediately for ${revoking?.user_email ?? "this user"}.`}
        confirmLabel="Revoke access"
        destructive
        onConfirm={async () => {
          if (!revoking) return;
          await api.admin.revokeOauthGrant(revoking.id);
          await qc.invalidateQueries({ queryKey: keys.adminOauthGrants });
        }}
      />
    </div>
  );
}
