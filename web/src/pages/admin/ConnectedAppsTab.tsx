import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { GrantInfo } from "@/api/types";
import { Notice, SettingsRow } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageSpinner } from "@/components/ui/spinner";
import { StatusChip } from "@/components/ui/status-chip";
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
      <p className="text-label text-muted">Apps people connected through OAuth (Claude, ChatGPT, ...). Revoking one cuts it off at once; the person can approve it again.</p>
      {grants.data.length === 0 ? (
        <EmptyState title="No connected apps" description="Nobody has connected an app yet." />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line" aria-label="Connected apps">
            {grants.data.map((g) => (
              <SettingsRow
                key={g.id}
                title={
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <bdi className="truncate">{g.client_name}</bdi>
                    <StatusChip hue={accessOf(g) === "manage" ? "orange" : "gray"}>{ACCESS_LABEL[accessOf(g)]}</StatusChip>
                  </span>
                }
                description={
                  <>
                    <p>
                      {g.user_name ?? "?"} ({g.user_email ?? "?"}) - connects from {g.redirect_host} - {g.bases ? `${g.bases.length} folder${g.bases.length === 1 ? "" : "s"}` : "all folders"}
                    </p>
                    <p>
                      Connected {formatDate(g.created_at)} - {g.last_used_at ? `last used ${formatDate(g.last_used_at)}` : "never used"}
                    </p>
                  </>
                }
                action={
                  <Button aria-label={`Revoke ${g.client_name} for ${g.user_email ?? "this user"}`} onClick={() => setRevoking(g)}>
                    Revoke
                  </Button>
                }
              />
            ))}
          </ul>
        </Card>
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
