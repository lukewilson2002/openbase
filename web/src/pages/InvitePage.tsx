import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { useMe } from "@/auth/useAuth";
import { AUTH_BUTTON, AuthLayout, Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { ColorMark } from "@/components/ui/color-mark";
import { PageSpinner } from "@/components/ui/spinner";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, isRole } from "@/lib/roles";

/** Public invite page: preview, then accept (when signed in) or sign up / log in first. */
export function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: me, isPending: mePending } = useMe();
  const preview = useQuery({
    queryKey: keys.invitePreview(token),
    queryFn: () => api.invites.preview(token),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () => api.invites.accept(token),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: keys.workspaces });
      const only = res && !res.all_bases && res.base_ids.length === 1 ? res.base_ids[0] : null;
      if (only) navigate(`/base/${only}`, { replace: true });
      else navigate("/", { replace: true });
    },
  });

  if (preview.isPending || mePending) return <PageSpinner label="Loading invitation" />;

  if (preview.isError) {
    return (
      <AuthLayout title="Invitation unavailable">
        <Notice tone="error">This invitation is invalid, has expired, or was already used. Ask the person who invited you for a new link.</Notice>
        <Button asChild variant="secondary" size="lg" className={`mt-4 ${AUTH_BUTTON}`}>
          <Link to="/">Go to OpenBase</Link>
        </Button>
      </AuthLayout>
    );
  }

  const inv = preview.data;
  const role = isRole(inv.role) ? inv.role : null;
  const nextHref = `/invite/${encodeURIComponent(token)}`;

  return (
    <AuthLayout
      mark={<ColorMark hue={inv.target_color} size={28} name={inv.target_name} />}
      title={`Join ${inv.target_name}`}
      subtitle={
        <>
          {inv.invited_by ? <>{inv.invited_by} invited you to </> : "You are invited to "}
          the {inv.target_kind} <strong>{inv.target_name}</strong>
          {role && <> as {ROLE_LABELS[role].toLowerCase()}</>}.
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {role && <p className="text-label text-muted">{ROLE_DESCRIPTIONS[role]}.</p>}
        {inv.email && (
          <Notice>
            This invitation is for <strong>{inv.email}</strong>.
          </Notice>
        )}
        {accept.isError && <Notice tone="error">{errorMessage(accept.error)}</Notice>}
        {me ? (
          <>
            <p className="text-label text-muted">
              Signed in as <strong>{me.email}</strong>.
            </p>
            <Button variant="primary" size="lg" className={AUTH_BUTTON} loading={accept.isPending} onClick={() => accept.mutate()}>
              Accept invitation
            </Button>
          </>
        ) : (
          <>
            <Button asChild variant="primary" size="lg" className={AUTH_BUTTON}>
              <Link to={`/signup?invite=${encodeURIComponent(token)}`}>Create an account</Link>
            </Button>
            <Button asChild variant="secondary" size="lg" className={AUTH_BUTTON}>
              <Link to={`/login?next=${encodeURIComponent(nextHref)}`}>I already have an account</Link>
            </Button>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
