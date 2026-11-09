import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { errorMessage } from "@/api/client";
import { Notice, Section, SettingsRow } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { useToast } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";

export function SessionsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const sessions = useQuery({ queryKey: keys.sessions, queryFn: api.auth.sessions });
  const refresh = () => qc.invalidateQueries({ queryKey: keys.sessions });

  const revoke = useMutation({ mutationFn: (id: string) => api.auth.revokeSession(id), onSuccess: refresh, onError: (e) => toast.error(e, "Could not sign out session") });
  const revokeOthers = useMutation({
    mutationFn: api.auth.revokeOtherSessions,
    onSuccess: () => {
      void refresh();
      toast.toast({ title: "Signed out of all other sessions", variant: "success" });
    },
    onError: (e) => toast.error(e, "Could not sign out other sessions"),
  });

  const others = (sessions.data ?? []).filter((s) => !s.current);

  return (
    <Section
      title="Active sessions"
      description="Browsers and devices currently signed in to your account."
      flush
      actions={
        others.length > 0 ? (
          <Button variant="danger" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
            Sign out all other sessions
          </Button>
        ) : undefined
      }
    >
      {sessions.isPending ? (
        <div aria-hidden className="p-4">
          <Skeleton className="h-10" />
        </div>
      ) : sessions.isError ? (
        <div className="p-4">
          <Notice tone="error">{errorMessage(sessions.error)}</Notice>
        </div>
      ) : (
        <ul className="divide-y divide-line" aria-label="Active sessions">
          {sessions.data.map((s) => (
            <SettingsRow
              key={s.id}
              title={
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate">{s.user_agent || "Unknown device"}</span>
                  {s.current && <StatusChip hue="green">This session</StatusChip>}
                </span>
              }
              description={`${s.ip ? `${s.ip} - ` : ""}signed in ${formatDateTime(s.created_at)}, last active ${formatDateTime(s.last_seen_at)}`}
              action={
                s.current ? undefined : (
                  <Button onClick={() => revoke.mutate(s.id)} disabled={revoke.isPending}>
                    Sign out
                  </Button>
                )
              }
            />
          ))}
        </ul>
      )}
    </Section>
  );
}
