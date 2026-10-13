import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { TwoFactorSetup, User } from "@/api/types";
import { errorMessage } from "@/api/client";
import { CopyField } from "@/components/CopyField";
import { QrCode } from "@/components/QrCode";
import { Notice, Section } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { MIN_PASSWORD_LENGTH, validatePasswords } from "@/lib/password";

export function SecuritySection({ user }: { user: User }) {
  return (
    <>
      <PasswordForm />
      <TwoFactor user={user} />
    </>
  );
}

function PasswordForm() {
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () => api.auth.changePassword({ current_password: current, new_password: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      toast({ title: "Password changed", description: "Your other sessions may have been signed out.", variant: "success" });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = validatePasswords(next, confirm);
    setLocalError(problem);
    if (!problem) change.mutate();
  };

  return (
    <Section title="Password">
      <form onSubmit={submit} className="flex max-w-md flex-col gap-4">
        {(localError || change.isError) && <Notice tone="error">{localError ?? errorMessage(change.error)}</Notice>}
        <Field label="Current password">
          {(ctl) => <Input {...ctl} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />}
        </Field>
        <Field label="New password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
          {(ctl) => <Input {...ctl} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />}
        </Field>
        <Field label="Confirm new password">
          {(ctl) => <Input {...ctl} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}
        </Field>
        <div>
          <Button type="submit" variant="primary" loading={change.isPending}>
            Change password
          </Button>
        </div>
      </form>
    </Section>
  );
}

function TwoFactor({ user }: { user: User }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [enabling, setEnabling] = useState<TwoFactorSetup | null>(null);
  const [disabling, setDisabling] = useState(false);

  const start = useMutation({
    mutationFn: api.auth.twoFactorSetup,
    onSuccess: setEnabling,
    onError: (e) => toast({ title: "Could not start setup", description: errorMessage(e), variant: "error" }),
  });
  // Enable/disable answer with the updated user: put it straight into the cache.
  const setMe = (updated: User) => qc.setQueryData(keys.me, updated);

  return (
    <Section title="Two-factor authentication" description="Require a code from an authenticator app (TOTP) in addition to your password.">
      <div className="flex flex-wrap items-center gap-3">
        {user.totp_enabled ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-[0.8125rem] font-medium text-success">
              <ShieldCheck aria-hidden className="size-4" /> Enabled
            </span>
            <Button onClick={() => setDisabling(true)}>
              <ShieldOff aria-hidden className="size-4" /> Disable
            </Button>
          </>
        ) : (
          <>
            <span className="text-[0.8125rem] text-muted">Not enabled</span>
            <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>
              <ShieldCheck aria-hidden className="size-4" /> Enable two-factor
            </Button>
          </>
        )}
      </div>
      {enabling && (
        <EnableDialog
          setup={enabling}
          onClose={() => setEnabling(null)}
          onEnabled={(updated) => {
            setEnabling(null);
            setMe(updated);
            toast({ title: "Two-factor authentication enabled", variant: "success" });
          }}
        />
      )}
      {disabling && (
        <DisableDialog
          onClose={() => setDisabling(false)}
          onDisabled={(updated) => {
            setDisabling(false);
            setMe(updated);
            toast({ title: "Two-factor authentication disabled", variant: "success" });
          }}
        />
      )}
    </Section>
  );
}

function EnableDialog({ setup, onClose, onEnabled }: { setup: TwoFactorSetup; onClose: () => void; onEnabled: (user: User) => void }) {
  const [code, setCode] = useState("");
  const enable = useMutation({ mutationFn: () => api.auth.twoFactorEnable(code.trim()), onSuccess: onEnabled });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    enable.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Set up two-factor authentication" description="Scan the QR code with an authenticator app, then enter the 6-digit code it shows.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex justify-center">
          <QrCode value={setup.otpauth_url} label="QR code for your authenticator app" />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">Or enter this key manually</span>
          <CopyField label="Secret key" value={setup.secret} />
        </div>
        {enable.isError && <Notice tone="error">{errorMessage(enable.error)}</Notice>}
        <Field label="Code from your app">
          {(ctl) => <Input {...ctl} inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code} onChange={(e) => setCode(e.target.value)} className="font-mono tracking-widest" required />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={enable.isPending} disabled={code.trim().length < 6}>
            Turn on
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DisableDialog({ onClose, onDisabled }: { onClose: () => void; onDisabled: (user: User) => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const disable = useMutation({ mutationFn: () => api.auth.twoFactorDisable({ password, code: code.trim() }), onSuccess: onDisabled });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    disable.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Disable two-factor authentication" description="Confirm with your password and a current code." size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {disable.isError && <Notice tone="error">{errorMessage(disable.error)}</Notice>}
        <Field label="Password">
          {(ctl) => <Input {...ctl} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />}
        </Field>
        <Field label="Authentication code">
          {(ctl) => <Input {...ctl} inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code} onChange={(e) => setCode(e.target.value)} className="font-mono tracking-widest" required />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={disable.isPending}>
            Disable
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
