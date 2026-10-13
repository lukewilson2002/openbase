import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { useSetUser } from "@/auth/useAuth";
import { AuthLayout, Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { safeNext } from "@/lib/format";
import type { User } from "@/api/types";

/** Second step of login when the account has TOTP enabled. */
export function TwoFactorLoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const setUser = useSetUser();
  const [code, setCode] = useState("");

  const verify = useMutation({
    mutationFn: async () => {
      const res = await api.auth.login2fa(code.trim());
      // The endpoint may answer with { user } or the user itself; fall back to /me.
      const user = ("user" in res ? res.user : res) as User | null | undefined;
      return user ?? (await api.auth.me());
    },
    onSuccess: (user) => {
      setUser(user);
      navigate(next, { replace: true });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    verify.mutate();
  };

  return (
    <AuthLayout
      title="Two-factor authentication"
      subtitle="Enter the 6-digit code from your authenticator app."
      footer={
        <Link to="/login" className="font-medium">
          Back to log in
        </Link>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {verify.isError && <Notice tone="error">{errorMessage(verify.error)}</Notice>}
        <Field label="Authentication code">
          {(ctl) => (
            <Input
              {...ctl}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={10}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="text-center font-mono text-lg tracking-widest"
              required
              autoFocus
            />
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={verify.isPending} disabled={code.trim().length < 6}>
          Verify
        </Button>
      </form>
    </AuthLayout>
  );
}
