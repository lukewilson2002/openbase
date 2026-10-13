import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { useMe, useSetUser, useSetupStatus } from "@/auth/useAuth";
import { usePasskeyLogin } from "@/auth/usePasskeyLogin";
import { AuthLayout, Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { PageSpinner } from "@/components/ui/spinner";
import { ServerRedirect } from "@/components/ServerRedirect";
import { isServerPath, safeNext } from "@/lib/format";
import { followRedirect } from "@/lib/oauthAccess";

export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const setUser = useSetUser();
  const { data: me } = useMe();
  const { data: setup, isPending: setupPending } = useSetupStatus();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Where a finished sign-in goes: a page the server answers (the OAuth authorize endpoint) needs a full page load.
  const proceed = () => {
    if (isServerPath(next)) followRedirect(next);
    else navigate(next, { replace: true });
  };

  const login = useMutation({
    mutationFn: () => api.auth.login({ email: email.trim(), password }),
    onSuccess: (res) => {
      if (res.two_factor_required) {
        navigate(`/login/2fa?next=${encodeURIComponent(next)}`);
      } else if (res.user) {
        setUser(res.user);
        proceed();
      }
    },
  });

  const passkey = usePasskeyLogin(setup, (user) => {
    setUser(user);
    proceed();
  });

  if (me) return isServerPath(next) ? <ServerRedirect to={next} /> : <Navigate to={next} replace />;
  if (setupPending) return <PageSpinner />;
  if (setup?.needs_setup) return <Navigate to="/setup" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <AuthLayout
      title="Log in"
      subtitle="Welcome back to OpenBase."
      footer={
        setup?.open_signup ? (
          <>
            New here?{" "}
            <Link to="/signup" className="font-medium">
              Create an account
            </Link>
          </>
        ) : undefined
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {login.isError && <Notice tone="error">{errorMessage(login.error)}</Notice>}
        {passkey.problem && <Notice tone="error">{passkey.problem}</Notice>}
        <Field label="Email">
          {(ctl) => <Input {...ctl} type="email" autoComplete={passkey.conditional ? "username webauthn" : "username"} value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />}
        </Field>
        <Field label="Password">
          {(ctl) => <Input {...ctl} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={login.isPending}>
          Log in
        </Button>
        <Link to="/forgot-password" className="text-center text-[0.8125rem]">
          Forgot your password?
        </Link>
      </form>
      {passkey.available && (
        <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
          <Button size="lg" loading={passkey.pending} onClick={passkey.signIn}>
            <KeyRound aria-hidden className="size-4" /> Sign in with a passkey
          </Button>
        </div>
      )}
      {passkey.unsupported && (
        <p className="mt-4 border-t border-line pt-4 text-center text-[0.8125rem] text-muted">
          Passkeys are set up on this server, but this browser cannot use them here. Sign in with your password.
        </p>
      )}
    </AuthLayout>
  );
}
