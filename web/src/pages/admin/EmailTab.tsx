import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Send } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { errorMessage } from "@/api/client";
import type { EmailSettings, EmailTestResult, UpdateEmailSettings } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { Notice, Section } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { PageSpinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";

const ENV_VARS = {
  host: "OPENBASE_SMTP_HOST",
  port: "OPENBASE_SMTP_PORT",
  security: "OPENBASE_SMTP_SECURITY",
  username: "OPENBASE_SMTP_USER",
  password: "OPENBASE_SMTP_PASSWORD",
  from: "OPENBASE_SMTP_FROM",
} as const;

type FieldName = keyof typeof ENV_VARS;

const SECURITY_LABELS: Record<string, string> = {
  starttls: "STARTTLS (usually port 587)",
  tls: "TLS (implicit, usually port 465)",
  none: "None (a relay on this machine or network only)",
};

/** Ports where mail providers (Resend, and most others) expect TLS from the first byte. */
const IMPLICIT_TLS_PORTS = [465, 2465];
/** Ports where they expect a plain greeting and an upgrade with STARTTLS. */
const STARTTLS_PORTS = [25, 587, 2587];

/** The likeliest fix when port and security do not go together: STARTTLS on 465 never gets a greeting, TLS on 587 fails the handshake. */
export function securityHint(portText: string, security: string): string | null {
  const port = Number(portText);
  if (security === "starttls" && IMPLICIT_TLS_PORTS.includes(port)) return `Port ${port} expects TLS from the first byte: set Connection security to TLS, or use port 587 with STARTTLS.`;
  if (security === "tls" && STARTTLS_PORTS.includes(port)) return `Port ${port} expects STARTTLS: set Connection security to STARTTLS, or use port 465 with TLS.`;
  return null;
}

interface FormState {
  host: string;
  port: string;
  security: string;
  username: string;
  from: string;
  password: string;
}

function initialForm(s: EmailSettings): FormState {
  return { host: s.host ?? "", port: String(s.port), security: s.security, username: s.username ?? "", from: s.from, password: "" };
}

export function EmailTab() {
  const settings = useQuery({ queryKey: keys.adminEmail, queryFn: api.admin.email });
  if (settings.isPending) return <PageSpinner label="Loading email settings" />;
  if (settings.isError) return <Notice tone="error">{errorMessage(settings.error)}</Notice>;
  // A new key remounts the panel, so its form always starts from what the server reports.
  return <EmailPanel key={JSON.stringify(settings.data)} settings={settings.data} />;
}

function Badge({ tone, children }: { tone: "good" | "neutral"; children: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone === "good" ? "bg-success-soft text-success" : "bg-subtle text-muted"}`}>{children}</span>;
}

function EmailPanel({ settings }: { settings: EmailSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => initialForm(settings));
  const [replacingPassword, setReplacingPassword] = useState(false);
  const [removingPassword, setRemovingPassword] = useState(false);

  const locked = (f: FieldName) => settings.sources[f] === "environment";
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  // Port and security go together (465 is TLS, 587 is STARTTLS), and getting them apart is the
  // commonest reason a test email never gets anywhere: changing one moves the other when it
  // sits on a standard value.
  const changePort = (port: string) => {
    const n = Number(port);
    const next: Partial<FormState> = { port };
    if (!locked("security") && port.trim() !== "") {
      if (IMPLICIT_TLS_PORTS.includes(n) && form.security === "starttls") next.security = "tls";
      else if (STARTTLS_PORTS.includes(n) && form.security === "tls") next.security = "starttls";
    }
    set(next);
  };
  const changeSecurity = (security: string) => {
    const n = Number(form.port);
    const next: Partial<FormState> = { security };
    if (!locked("port")) {
      if (security === "tls" && STARTTLS_PORTS.includes(n)) next.port = n === 2587 ? "2465" : "465";
      else if (security === "starttls" && IMPLICIT_TLS_PORTS.includes(n)) next.port = n === 2465 ? "2587" : "587";
    }
    set(next);
  };
  const hint = securityHint(form.port, form.security);

  /** Only what changed, and nothing the environment fixes. */
  const buildPatch = (): UpdateEmailSettings => {
    const initial = initialForm(settings);
    const patch: UpdateEmailSettings = {};
    if (!locked("host") && form.host.trim() !== initial.host) patch.host = form.host.trim() || null;
    if (!locked("port") && form.port.trim() !== initial.port) patch.port = Number(form.port);
    if (!locked("security") && form.security !== initial.security) patch.security = form.security;
    if (!locked("username") && form.username.trim() !== initial.username) patch.username = form.username.trim() || null;
    if (!locked("from") && form.from.trim() !== initial.from) patch.from = form.from.trim();
    if (!locked("password")) {
      if (removingPassword) patch.password = null;
      else if (form.password !== "") patch.password = form.password;
    }
    return patch;
  };
  const patch = buildPatch();
  const dirty = Object.keys(patch).length > 0;
  const portInvalid = form.port.trim() !== "" && !(Number.isInteger(Number(form.port)) && Number(form.port) >= 1 && Number(form.port) <= 65535);

  const save = useMutation({
    mutationFn: () => api.admin.updateEmail(patch),
    onSuccess: (next) => {
      qc.setQueryData(keys.adminEmail, next);
      toast.toast({ title: next.enabled ? "Email settings saved" : "Email settings saved (email is off)", variant: "success" });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || portInvalid) return;
    save.mutate();
  };

  return (
    <div className="flex flex-col gap-5">
      <Status settings={settings} />
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <Section title="Mail server (SMTP)" description="Used for invitations, password-reset emails and the Send email automation action. Changes apply immediately; no restart is needed.">
          <div className="flex flex-col gap-4">
            {save.isError && <Notice tone="error">{errorMessage(save.error)}</Notice>}
            <div className="grid gap-4 md:grid-cols-[1fr_8rem]">
              <Field label="Host" hint={locked("host") ? <Locked field="host" /> : "For example smtp.example.com. Leave empty to turn email off."}>
                {(ctl) => <Input {...ctl} value={form.host} onChange={(e) => set({ host: e.target.value })} disabled={locked("host")} autoComplete="off" spellCheck={false} placeholder="smtp.example.com" />}
              </Field>
              <Field label="Port" error={portInvalid ? "1 to 65535" : undefined} hint={locked("port") ? <Locked field="port" /> : undefined}>
                {(ctl) => <Input {...ctl} inputMode="numeric" value={form.port} onChange={(e) => changePort(e.target.value)} disabled={locked("port")} />}
              </Field>
            </div>
            <Field label="Connection security" hint={locked("security") ? <Locked field="security" /> : undefined}>
              {(ctl) => (
                <Select {...ctl} value={form.security} onChange={(e) => changeSecurity(e.target.value)} disabled={locked("security")}>
                  {Object.entries(SECURITY_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {hint && <Notice tone="warning">{hint}</Notice>}
            {form.security === "none" && (form.username.trim() !== "" || settings.password_set) && <Notice tone="warning">With security set to None, the username and password are sent unencrypted. Use this only for a relay on the same machine or a private network.</Notice>}
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Username" hint={locked("username") ? <Locked field="username" /> : "Leave empty if the server needs no sign-in."}>
                {(ctl) => <Input {...ctl} value={form.username} onChange={(e) => set({ username: e.target.value })} disabled={locked("username")} autoComplete="off" spellCheck={false} />}
              </Field>
              <PasswordField
                settings={settings}
                locked={locked("password")}
                value={form.password}
                onChange={(password) => set({ password })}
                replacing={replacingPassword}
                setReplacing={(v) => {
                  setReplacingPassword(v);
                  if (!v) set({ password: "" });
                }}
                removing={removingPassword}
                setRemoving={setRemovingPassword}
              />
            </div>
            <Field label="From address" hint={locked("from") ? <Locked field="from" /> : "Shown to recipients, for example OpenBase <base@example.com>."}>
              {(ctl) => <Input {...ctl} value={form.from} onChange={(e) => set({ from: e.target.value })} disabled={locked("from")} spellCheck={false} />}
            </Field>
            <div className="flex items-center justify-end gap-3">
              {dirty && <span className="text-xs text-muted">Unsaved changes</span>}
              <Button type="submit" variant="primary" disabled={!dirty || portInvalid} loading={save.isPending}>
                Save changes
              </Button>
            </div>
          </div>
        </Section>
      </form>

      <TestEmail settings={settings} dirty={dirty} />

      <Section title="Sending limits" description="These are set in the server's environment, not here.">
        <dl className="grid gap-3 text-[0.8125rem] sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Per user, per hour</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{settings.budgets.per_user_hour}</dd>
            <dd className="text-xs text-muted">
              <code>OPENBASE_EMAIL_PER_USER_HOUR</code>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Whole server, per hour</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{settings.budgets.per_hour}</dd>
            <dd className="text-xs text-muted">
              <code>OPENBASE_EMAIL_PER_HOUR</code>
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted">Invitation and automation emails count against these limits; each recipient counts once.</p>
      </Section>
    </div>
  );
}

function Locked({ field }: { field: FieldName }) {
  return (
    <>
      Set by environment (<code>{ENV_VARS[field]}</code>); remove the variable to change it here.
    </>
  );
}

function Status({ settings }: { settings: EmailSettings }) {
  if (!settings.enabled) {
    return (
      <Notice tone="warning">
        <strong>Email is off.</strong> Invitations and password-reset emails are not sent, and the Send email automation action is unavailable. Enter a mail server below to turn it on. Until then, create password reset links under Users.
      </Notice>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-[0.8125rem]">
      <Badge tone="good">Email is on</Badge>
      <span>
        Sending through <span className="font-medium">{settings.host}</span>:{settings.port}
      </span>
      <Badge tone="neutral">{settings.source === "environment" ? "Host set by environment" : "Host saved here"}</Badge>
    </div>
  );
}

interface PasswordFieldProps {
  settings: EmailSettings;
  locked: boolean;
  value: string;
  onChange: (v: string) => void;
  replacing: boolean;
  setReplacing: (v: boolean) => void;
  removing: boolean;
  setRemoving: (v: boolean) => void;
}

/** Write-only: the server never sends the password back, only whether one is stored. */
function PasswordField({ settings, locked, value, onChange, replacing, setReplacing, removing, setRemoving }: PasswordFieldProps) {
  const label = "Password";
  if (locked) {
    return (
      <Field label={label} hint={<Locked field="password" />}>
        {(ctl) => <Input {...ctl} value="" placeholder="Set by environment" disabled readOnly />}
      </Field>
    );
  }
  if (settings.password_set && !replacing) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[0.8125rem] font-medium text-fg" id="smtp-password-label">
          {label}
        </span>
        <div className="flex min-h-8 flex-wrap items-center gap-2" role="group" aria-labelledby="smtp-password-label">
          {removing ? (
            <>
              <span className="text-[0.8125rem] text-danger">Will be removed when you save</span>
              <Button size="sm" onClick={() => setRemoving(false)}>
                Undo
              </Button>
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5 text-[0.8125rem]">
                <KeyRound aria-hidden className="size-4 text-muted" /> Saved
              </span>
              <Button size="sm" onClick={() => setReplacing(true)}>
                Replace
              </Button>
              <Button size="sm" onClick={() => setRemoving(true)}>
                Remove
              </Button>
            </>
          )}
        </div>
        <p className="text-xs text-muted">For security the saved password is never shown.</p>
      </div>
    );
  }
  const hint: ReactNode = settings.password_set ? "Type a new password, or leave it empty to keep the saved one." : "Leave empty if the server needs no sign-in.";
  return (
    <Field label={label} hint={hint}>
      {(ctl) => (
        <div className="flex gap-2">
          <Input {...ctl} type="password" autoComplete="new-password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={settings.password_set ? "New password" : undefined} />
          {replacing && (
            <Button onClick={() => setReplacing(false)} aria-label="Keep the saved password">
              Cancel
            </Button>
          )}
        </div>
      )}
    </Field>
  );
}

function TestEmail({ settings, dirty }: { settings: EmailSettings; dirty: boolean }) {
  const { data: me } = useMe();
  const [to, setTo] = useState("");
  const [result, setResult] = useState<EmailTestResult | null>(null);
  const send = useMutation({
    mutationFn: () => api.admin.sendTestEmail(to.trim() || undefined),
    onMutate: () => setResult(null),
    onSuccess: setResult,
  });
  const blocked = !settings.enabled ? "Enter a mail server and save before sending a test." : dirty ? "Save your changes first: the test uses the saved settings." : null;
  return (
    <Section title="Send a test email" description="Sends a real message through the saved settings and shows the mail server's answer, so you can find out what is wrong before an invitation fails.">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Send to" className="min-w-64 flex-1" hint={me ? `Leave empty to send to your own address, ${me.email}.` : undefined}>
            {(ctl) => <Input {...ctl} type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder={me?.email} autoComplete="off" />}
          </Field>
          <Button variant="primary" onClick={() => send.mutate()} loading={send.isPending} disabled={blocked !== null}>
            <Send aria-hidden className="size-4" /> Send test email
          </Button>
        </div>
        {blocked && <p className="text-xs text-muted">{blocked}</p>}
        {send.isError && <Notice tone="error">{errorMessage(send.error)}</Notice>}
        {result?.ok && <Notice tone="success">Test email sent to {result.to}. The mail server accepted it; check that it arrives (and look in the spam folder).</Notice>}
        {result && !result.ok && (
          <Notice tone="error">
            <p className="font-medium">The test email to {result.to} was not sent.</p>
            <p className="mt-1 break-words font-mono text-xs">{result.error}</p>
          </Notice>
        )}
      </div>
    </Section>
  );
}
