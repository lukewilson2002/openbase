import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { useMe, useSetUser, useSetupStatus } from "@/auth/useAuth";
import { AuthLayout, Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { PageSpinner } from "@/components/ui/spinner";
import { ROLE_LABELS, isRole } from "@/lib/roles";
import { MIN_PASSWORD_LENGTH, validatePasswords } from "@/lib/password";

/** Create an account. Open signup, or invite-only with `?invite=<token>`. */
export function SignupPage() {
  const [params] = useSearchParams();
  const inviteToken = params.get("invite");
  const navigate = useNavigate();
  const setUser = useSetUser();
  const { data: me } = useMe();
  const { data: setup, isPending } = useSetupStatus();
  const invite = useQuery({
    queryKey: keys.invitePreview(inviteToken ?? ""),
    queryFn: () => api.invites.preview(inviteToken ?? ""),
    enabled: !!inviteToken,
    retry: false,
  });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const signup = useMutation({
    mutationFn: async () => {
      await api.auth.signup({ name: name.trim(), email: email.trim(), password, invite_token: inviteToken });
      return api.auth.me();
    },
    onSuccess: (user) => {
      setUser(user);
      navigate("/", { replace: true });
    },
  });

  if (me && !signup.isSuccess) return <Navigate to={inviteToken ? `/invite/${encodeURIComponent(inviteToken)}` : "/"} replace />;
  if (isPending) return <PageSpinner />;
  if (setup?.needs_setup) return <Navigate to="/setup" replace />;

  const allowed = setup?.open_signup || !!inviteToken;
  const loginHref = inviteToken ? `/login?next=${encodeURIComponent(`/invite/${inviteToken}`)}` : "/login";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = validatePasswords(password, confirm);
    setLocalError(problem);
    if (!problem) signup.mutate();
  };

  return (
    <AuthLayout
      title="Create your account"
      footer={
        <>
          Already have an account?{" "}
          <Link to={loginHref} className="font-medium">
            Log in
          </Link>
        </>
      }
    >
      {!allowed ? (
        <Notice tone="warning">Sign-up on this instance is by invitation only. Ask an administrator for an invite link.</Notice>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          {invite.data && (
            <Notice>
              You were invited to <strong>{invite.data.target_name}</strong>
              {isRole(invite.data.role) && <> as {ROLE_LABELS[invite.data.role].toLowerCase()}</>}.
            </Notice>
          )}
          {invite.isError && <Notice tone="error">This invitation is invalid or has expired.</Notice>}
          {(localError || signup.isError) && <Notice tone="error">{localError ?? errorMessage(signup.error)}</Notice>}
          <Field label="Your name">
            {(ctl) => <Input {...ctl} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />}
          </Field>
          <Field label="Email">
            {(ctl) => (
              <Input {...ctl} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={invite.data?.email ?? undefined} required />
            )}
          </Field>
          <Field label="Password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
            {(ctl) => <Input {...ctl} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
          </Field>
          <Field label="Confirm password">
            {(ctl) => <Input {...ctl} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={signup.isPending}>
            Create account
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
