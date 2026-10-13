import { EntityLabel, EntityTile } from "@/components/icons/EntityIcon";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { useMe } from "@/auth/useAuth";
import { AuthLayout, Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
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
      if (res?.base_id) navigate(`/base/${res.base_id}`, { replace: true });
      else navigate("/", { replace: true });
    },
  });

  if (preview.isPending || mePending) return <PageSpinner label="Loading invitation" />;

  if (preview.isError) {
    return (
      <AuthLayout title="Invitation unavailable">
        <Notice tone="error">This invitation is invalid, has expired, or was already used.</Notice>
        <Button asChild variant="secondary" className="mt-4 w-full">
          <Link to="/">Go to OpenGrid</Link>
        </Button>
      </AuthLayout>
    );
  }

  const inv = preview.data;
  const role = isRole(inv.role) ? inv.role : null;
  const nextHref = `/invite/${encodeURIComponent(token)}`;

  return (
    <AuthLayout
      title={`Join ${inv.target_name}`}
      subtitle={
        <>
          {inv.invited_by ? <>{inv.invited_by} invited you to </> : "You are invited to "}
          the {inv.target_kind}{" "}
          <strong>
            <EntityLabel icon={inv.target_icon}>{inv.target_name}</EntityLabel>
          </strong>
          {role && <> as {ROLE_LABELS[role].toLowerCase()}</>}.
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <EntityTile name={inv.target_name} icon={inv.target_icon} size="lg" className="self-center" />
        {role && <p className="text-[0.8125rem] text-muted">{ROLE_DESCRIPTIONS[role]}.</p>}
        {inv.email && (
          <Notice>
            This invitation is for <strong>{inv.email}</strong>.
          </Notice>
        )}
        {accept.isError && <Notice tone="error">{errorMessage(accept.error)}</Notice>}
        {me ? (
          <>
            <p className="text-[0.8125rem] text-muted">
              Signed in as <strong>{me.email}</strong>.
            </p>
            <Button variant="primary" size="lg" loading={accept.isPending} onClick={() => accept.mutate()}>
              Accept invitation
            </Button>
          </>
        ) : (
          <>
            <Button asChild variant="primary" size="lg">
              <Link to={`/signup?invite=${encodeURIComponent(token)}`}>Create an account</Link>
            </Button>
            <Button asChild variant="secondary" size="lg">
              <Link to={`/login?next=${encodeURIComponent(nextHref)}`}>I already have an account</Link>
            </Button>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
