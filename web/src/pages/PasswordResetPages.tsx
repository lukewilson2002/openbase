import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { useSetupStatus } from "@/auth/useAuth";
import { AuthLayout, Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { MIN_PASSWORD_LENGTH, validatePasswords } from "@/lib/password";

export function ForgotPasswordPage() {
  const { data: setup } = useSetupStatus();
  const [email, setEmail] = useState("");
  const request = useMutation({ mutationFn: () => api.auth.requestPasswordReset(email.trim()) });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    request.mutate();
  };

  return (
    <AuthLayout
      title="Reset your password"
      footer={
        <Link to="/login" className="font-medium">
          Back to log in
        </Link>
      }
    >
      {request.isSuccess ? (
        <Notice tone="success">If an account exists for that address, a reset link is on its way. Check your inbox.</Notice>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          {setup && !setup.email_enabled && (
            <Notice tone="warning">Email is not configured on this server. Ask an administrator to generate a reset link for you.</Notice>
          )}
          {request.isError && <Notice tone="error">{errorMessage(request.error)}</Notice>}
          <Field label="Email">
            {(ctl) => <Input {...ctl} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />}
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={request.isPending}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const confirmReset = useMutation({
    mutationFn: () => api.auth.confirmPasswordReset({ token, new_password: password }),
    onSuccess: () => {
      toast({ title: "Password updated", description: "Log in with your new password.", variant: "success" });
      navigate("/login", { replace: true });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = validatePasswords(password, confirm);
    setLocalError(problem);
    if (!problem) confirmReset.mutate();
  };

  if (!token) {
    return (
      <AuthLayout title="Reset link missing">
        <Notice tone="error">This page needs a reset link. Request a new one.</Notice>
        <Button asChild variant="secondary" className="mt-4 w-full">
          <Link to="/forgot-password">Request a reset link</Link>
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {(localError || confirmReset.isError) && <Notice tone="error">{localError ?? errorMessage(confirmReset.error)}</Notice>}
        <Field label="New password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
          {(ctl) => <Input {...ctl} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />}
        </Field>
        <Field label="Confirm new password">
          {(ctl) => <Input {...ctl} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={confirmReset.isPending}>
          Update password
        </Button>
      </form>
    </AuthLayout>
  );
}
