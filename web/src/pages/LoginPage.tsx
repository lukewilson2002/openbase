import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { useMe, useSetUser, useSetupStatus } from "@/auth/useAuth";
import { AuthLayout, Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { PageSpinner } from "@/components/ui/spinner";
import { safeNext } from "@/lib/format";

export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const setUser = useSetUser();
  const { data: me } = useMe();
  const { data: setup, isPending: setupPending } = useSetupStatus();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: () => api.auth.login({ email: email.trim(), password }),
    onSuccess: (res) => {
      if (res.two_factor_required) {
        navigate(`/login/2fa?next=${encodeURIComponent(next)}`);
      } else if (res.user) {
        setUser(res.user);
        navigate(next, { replace: true });
      }
    },
  });

  if (me) return <Navigate to={next} replace />;
  if (setupPending) return <PageSpinner />;
  if (setup?.needs_setup) return <Navigate to="/setup" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <AuthLayout
      title="Log in"
      subtitle="Welcome back to OpenGrid."
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
        <Field label="Email">
          {(ctl) => <Input {...ctl} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />}
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
    </AuthLayout>
  );
}
