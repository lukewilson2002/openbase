import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { errorMessage } from "@/api/client";
import { Notice, Section } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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
    >
      {sessions.isPending ? (
        <Spinner />
      ) : sessions.isError ? (
        <Notice tone="error">{errorMessage(sessions.error)}</Notice>
      ) : (
        <>
          <ul className="divide-y divide-line rounded-md border border-line">
            {sessions.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <Laptop aria-hidden className="size-5 shrink-0 text-muted" />
                <div className="min-w-0 flex-1 basis-56">
                  <p className="truncate text-[0.8125rem] font-medium">
                    {s.user_agent || "Unknown device"}
                    {s.current && <span className="ml-2 rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">This session</span>}
                  </p>
                  <p className="text-xs text-muted">
                    {s.ip ? `${s.ip} - ` : ""}signed in {formatDateTime(s.created_at)}, last active {formatDateTime(s.last_seen_at)}
                  </p>
                </div>
                {!s.current && (
                  <Button size="sm" onClick={() => revoke.mutate(s.id)} disabled={revoke.isPending}>
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {others.length > 0 && (
            <div className="mt-4">
              <Button variant="danger" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
                Sign out all other sessions
              </Button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
