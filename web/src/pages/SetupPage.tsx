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

/** First run: the first account created becomes the instance administrator. */
export function SetupPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const setUser = useSetUser();
  const { data: setup, isPending } = useSetupStatus();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      await api.auth.signup({ name: name.trim(), email: email.trim(), password, invite_token: null });
      return api.auth.me();
    },
    onSuccess: (user) => {
      setUser(user);
      void qc.invalidateQueries({ queryKey: keys.setup });
      navigate("/", { replace: true });
    },
  });

  if (isPending) return <PageSpinner />;
  if (setup && !setup.needs_setup) return <Navigate to="/login" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = validatePasswords(password, confirm);
    setLocalError(problem);
    if (!problem) create.mutate();
  };

  return (
    <AuthLayout title="Set up OpenGrid" subtitle="Create the administrator account for this instance.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {(localError || create.isError) && <Notice tone="error">{localError ?? errorMessage(create.error)}</Notice>}
        <Field label="Your name">
          {(ctl) => <Input {...ctl} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />}
        </Field>
        <Field label="Email">
          {(ctl) => <Input {...ctl} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
        </Field>
        <Field label="Password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
          {(ctl) => <Input {...ctl} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
        </Field>
        <Field label="Confirm password">
          {(ctl) => <Input {...ctl} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={create.isPending}>
          Create administrator
        </Button>
      </form>
    </AuthLayout>
  );
}
