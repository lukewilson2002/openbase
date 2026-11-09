import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { GrantInfo } from "@/api/types";
import { AccessChoice } from "@/components/AccessChoice";
import { Notice, Section, SettingsRow } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { useToast } from "@/components/ui/toast";
import { formatDate } from "@/lib/format";
import { ACCESS_LABEL, NEEDS_ALL_FOLDERS, accessOf, type OAuthAccess } from "@/lib/oauthAccess";

/**
 * Apps connected through OAuth (Claude, ChatGPT, ...), each with its access, a Change access control and a Revoke
 * button (AGT-2). Shown on the AI assistants tab.
 */
export function ConnectedAppsSection() {
  const qc = useQueryClient();
  const grants = useQuery({ queryKey: keys.oauthGrants, queryFn: api.oauth.grants });
  const [revoking, setRevoking] = useState<GrantInfo | null>(null);
  const [changing, setChanging] = useState<GrantInfo | null>(null);

  return (
    <Section title="Connected apps" description="Apps you approved. Change what one can do, or revoke it to cut it off at once." flush>
      {grants.isPending ? (
        <div aria-hidden className="p-4">
          <Skeleton className="h-10" />
        </div>
      ) : grants.isError ? (
        <div className="p-4">
          <Notice tone="error">{errorMessage(grants.error)}</Notice>
        </div>
      ) : grants.data.length === 0 ? (
        <p className="p-4 text-label text-muted">No connected apps yet.</p>
      ) : (
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
                    Connects from {g.redirect_host} - {g.bases ? `${g.bases.length} folder${g.bases.length === 1 ? "" : "s"}: ${g.bases.map((b) => b.name).join(", ")}` : "all folders"}
                  </p>
                  <p>
                    Connected {formatDate(g.created_at)} - {g.last_used_at ? `last used ${formatDate(g.last_used_at)}` : "never used"}
                  </p>
                </>
              }
              action={
                <span className="flex flex-wrap gap-2">
                  <Button aria-label={`Change access for ${g.client_name}`} onClick={() => setChanging(g)}>
                    Change access
                  </Button>
                  <Button aria-label={`Revoke ${g.client_name}`} onClick={() => setRevoking(g)}>
                    Revoke
                  </Button>
                </span>
              }
            />
          ))}
        </ul>
      )}
      {changing && <ChangeAccessDialog grant={changing} onClose={() => setChanging(null)} />}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke ${revoking?.client_name ?? "this app"}?`}
        description="It stops working immediately and has to be connected and approved again to get access back. This can't be undone."
        confirmLabel="Revoke access"
        destructive
        onConfirm={async () => {
          if (!revoking) return;
          await api.oauth.revokeGrant(revoking.id);
          await qc.invalidateQueries({ queryKey: keys.oauthGrants });
        }}
      />
    </Section>
  );
}

/**
 * Upgrades or downgrades a connected app: the grant and its live tokens take the new level from their next
 * request, with no reconnect. An app limited to some folders cannot be given Full control (SEC-P2-2).
 */
function ChangeAccessDialog({ grant, onClose }: { grant: GrantInfo; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const current = accessOf(grant);
  const [access, setAccess] = useState<OAuthAccess>(current);
  const change = useMutation({
    mutationFn: () => api.oauth.changeGrantAccess(grant.id, { access }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.oauthGrants });
      toast.toast({ title: `${grant.client_name} now has ${ACCESS_LABEL[access].toLowerCase()} access`, variant: "success" });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Change access for ${grant.client_name}`}
      description="The change applies from the app's next request. It does not need to connect again."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={change.isPending} disabled={access === current} onClick={() => change.mutate()}>
            Save access
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {change.isError && <Notice tone="error">{errorMessage(change.error)}</Notice>}
        <AccessChoice
          value={access}
          onChange={setAccess}
          disabled={grant.bases ? { [NEEDS_ALL_FOLDERS]: "Not available for an app limited to some folders." } : undefined}
        />
      </div>
    </Dialog>
  );
}
