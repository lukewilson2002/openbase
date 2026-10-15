import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { useSetUser, useSetupStatus } from "@/auth/useAuth";
import { AuthLayout, Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { PageSpinner } from "@/components/ui/spinner";
import { MIN_PASSWORD_LENGTH, validatePasswords } from "@/lib/password";

/** First run: the first account created becomes the instance administrator (the owner). */
export function SetupPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const setUser = useSetUser();
  const { data: setup, isPending } = useSetupStatus();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const create = useMutation({
    // The first signup creates the administrator and signs in; the response is the new user.
    mutationFn: () => api.auth.signup({ name: name.trim(), email: email.trim(), password, invite_token: null }),
    onSuccess: (user) => {
      setUser(user);
      void qc.invalidateQueries({ queryKey: keys.setup });
      // The new account has not seen the intro, so it opens over the home page.
      navigate("/", { replace: true });
    },
  });

  if (isPending) return <PageSpinner />;
  if (setup && !setup.needs_setup) return <Navigate to="/login" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // No confirm field on this page (one less thing for the first person to type), so only the
    // length rule applies: the password is passed as its own confirmation.
    const problem = validatePasswords(password, password);
    setLocalError(problem);
    if (!problem) create.mutate();
  };

  return (
    <AuthLayout title="Welcome to your OpenBase" subtitle="You are the first person here, so this OpenBase is yours. You can invite others once you are in.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {(localError || create.isError) && <Notice tone="error">{localError ?? errorMessage(create.error)}</Notice>}
        <Field label="Your name">
          {(ctl) => <Input {...ctl} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />}
        </Field>
        <Field label="Email">
          {(ctl) => <Input {...ctl} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
        </Field>
        <Field label="Password" hint={`At least ${MIN_PASSWORD_LENGTH} characters. You can add a passkey later.`}>
          {(ctl) => <Input {...ctl} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
        </Field>
        <div className="flex flex-col gap-2">
          <Button type="submit" variant="primary" size="lg" loading={create.isPending}>
            Create my account
          </Button>
          <p className="text-center text-xs text-muted">As the owner you can manage accounts, email and backups in Settings.</p>
        </div>
      </form>
    </AuthLayout>
  );
}
