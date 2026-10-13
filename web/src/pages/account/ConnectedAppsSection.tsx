import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug, Trash2 } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { GrantInfo } from "@/api/types";
import { Notice, Section } from "@/components/layouts";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { formatDate } from "@/lib/format";
import { ACCESS_LABEL, accessOf } from "@/lib/oauthAccess";

/** Apps connected through OAuth (Claude, ChatGPT, ...), each with its access and a Revoke button. */
export function ConnectedAppsSection() {
  const qc = useQueryClient();
  const grants = useQuery({ queryKey: keys.oauthGrants, queryFn: api.oauth.grants });
  const [revoking, setRevoking] = useState<GrantInfo | null>(null);

  return (
    <Section
      title="Connected apps"
      description="Apps you signed in to OpenBase from, such as Claude or ChatGPT. Each acts as you with the access you approved. Revoke one to cut it off at once."
    >
      {grants.isPending ? (
        <Spinner />
      ) : grants.isError ? (
        <Notice tone="error">{errorMessage(grants.error)}</Notice>
      ) : grants.data.length === 0 ? (
        <EmptyState icon={<Plug />} title="No connected apps" description="When you add OpenBase as a connector in an AI assistant and approve it, it shows up here." />
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line" aria-label="Connected apps">
          {grants.data.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <Plug aria-hidden className="size-5 shrink-0 text-muted" />
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate text-[0.8125rem] font-medium">
                  {g.client_name}
                  <span className="ml-2 rounded-full bg-subtle px-2 py-0.5 text-xs font-normal text-muted">{ACCESS_LABEL[accessOf(g)]}</span>
                </p>
                <p className="text-xs text-muted">
                  Connects from {g.redirect_host} - {g.bases ? `${g.bases.length} base${g.bases.length === 1 ? "" : "s"}: ${g.bases.map((b) => b.name).join(", ")}` : "all bases"}
                </p>
                <p className="text-xs text-muted">
                  Connected {formatDate(g.created_at)} - {g.last_used_at ? `last used ${formatDate(g.last_used_at)}` : "never used"}
                </p>
              </div>
              <IconButton label={`Revoke ${g.client_name}`} size="sm" onClick={() => setRevoking(g)}>
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
        description="It stops working immediately and has to be connected and approved again to get access back."
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
