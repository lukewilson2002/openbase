import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { ApiError, errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { PasskeyInfo } from "@/api/types";
import { useSetupStatus } from "@/auth/useAuth";
import { Notice, Section, SettingsRow } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Field, Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { StatusChip } from "@/components/ui/status-chip";
import { useToast } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { atPublicAddress, classifyWebAuthnError, createPasskey, defaultPasskeyName, passkeysSupported } from "@/lib/webauthn";

/** Account -> Security: the passkeys that can sign this account in without a password. */
export function PasskeysSection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: setup } = useSetupStatus();
  const passkeys = useQuery({ queryKey: keys.passkeys, queryFn: api.auth.passkeys });
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<PasskeyInfo | null>(null);
  const [removing, setRemoving] = useState<PasskeyInfo | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.passkeys });

  // Why adding is not possible here, if it is not.
  let blocked: string | null = null;
  if (!passkeysSupported()) {
    blocked = "This browser cannot create passkeys here. Passkeys need a current browser on a secure (https) address.";
  } else if (setup && !setup.passkeys_enabled) {
    blocked = "Passkeys are off on this server: OPENBASE_PUBLIC_URL has to be an address with a domain name, such as https://base.example.com.";
  } else if (setup && !atPublicAddress(setup.public_url)) {
    blocked = `Passkeys belong to ${setup.public_url}. Open OpenBase at that address to add or use one.`;
  }

  return (
    <Section
      title="Passkeys"
      description="Sign in with your fingerprint, face, screen lock or a security key instead of typing a password. A passkey sign-in also replaces the two-factor code."
    >
      {blocked && (
        <div className="mb-4">
          <Notice tone="warning">{blocked}</Notice>
        </div>
      )}
      {passkeys.isPending ? (
        <Spinner />
      ) : passkeys.isError ? (
        <Notice tone="error">{errorMessage(passkeys.error)}</Notice>
      ) : (
        <>
          {passkeys.data.length === 0 ? (
            <p className="text-label text-muted">No passkeys yet. You sign in with your password.</p>
          ) : (
            <ul aria-label="Your passkeys" className="-mx-4 divide-y divide-line border-y border-line">
              {passkeys.data.map((p) => (
                <SettingsRow
                  key={p.id}
                  title={
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate">{p.name}</span>
                      {p.backup_eligible && (
                        <StatusChip hue="gray" title="The authenticator can back this passkey up to your password manager or cloud account.">
                          Synced
                        </StatusChip>
                      )}
                    </span>
                  }
                  description={`Added ${formatDateTime(p.created_at)}, ${p.last_used_at ? `last used ${formatDateTime(p.last_used_at)}` : "never used"}`}
                  action={
                    <span className="flex gap-1">
                      <IconButton label={`Rename ${p.name}`} onClick={() => setRenaming(p)}>
                        <Pencil aria-hidden className="size-4" />
                      </IconButton>
                      <IconButton label={`Remove ${p.name}`} onClick={() => setRemoving(p)}>
                        <Trash2 aria-hidden className="size-4" />
                      </IconButton>
                    </span>
                  }
                />
              ))}
            </ul>
          )}
          <div className="mt-4">
            <Button variant="primary" disabled={!!blocked} onClick={() => setAdding(true)}>
              Add a passkey
            </Button>
          </div>
        </>
      )}

      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onAdded={(p) => {
            setAdding(false);
            void refresh();
            toast({ title: "Passkey added", description: `${p.name} can now sign you in.`, variant: "success" });
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          passkey={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null);
            void refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? "passkey"}?`}
        description="You will no longer be able to sign in with it. Your device may still list it; delete it there too."
        confirmLabel="Remove passkey"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await api.auth.removePasskey(removing.id);
          await refresh();
          toast({ title: "Passkey removed", variant: "success" });
        }}
      />
    </Section>
  );
}

function AddDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (passkey: PasskeyInfo) => void }) {
  const [name, setName] = useState(() => defaultPasskeyName());
  const [password, setPassword] = useState("");
  const [needPassword, setNeedPassword] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  const add = useMutation({
    mutationFn: async () => {
      const challenge = await api.auth.passkeyRegisterStart(password ? { password } : {});
      const credential = await createPasskey(challenge.options);
      if (!credential) return null;
      return api.auth.passkeyRegisterFinish({ challenge_id: challenge.challenge_id, name: name.trim() || null, credential });
    },
    onMutate: () => setMessage(null),
    onSuccess: (passkey) => {
      if (passkey) onAdded(passkey);
      else setMessage({ tone: "info", text: "Nothing was added: the passkey prompt was closed." });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "reauth_required") {
        setNeedPassword(true);
        setMessage({ tone: "info", text: "Confirm your password to add a passkey." });
        return;
      }
      if (e instanceof ApiError) {
        setMessage({ tone: "error", text: e.message });
        return;
      }
      const failure = classifyWebAuthnError(e);
      setMessage(failure.kind === "cancelled" ? { tone: "info", text: "Nothing was added: the passkey prompt was closed." } : { tone: "error", text: failure.message });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !add.isPending && onClose()}
      title="Add a passkey"
      description="Your browser or device will ask you to confirm with your fingerprint, face, PIN or security key."
      size="sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        <Field label="Name" hint="So you can tell your passkeys apart.">
          {(ctl) => <Input {...ctl} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />}
        </Field>
        {needPassword && (
          <Field label="Password">
            {(ctl) => <Input {...ctl} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />}
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={add.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={add.isPending}>
            Add passkey
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RenameDialog({ passkey, onClose, onRenamed }: { passkey: PasskeyInfo; onClose: () => void; onRenamed: () => void }) {
  const [name, setName] = useState(passkey.name);
  const rename = useMutation({ mutationFn: () => api.auth.renamePasskey(passkey.id, name.trim()), onSuccess: onRenamed });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    rename.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Rename passkey" size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {rename.isError && <Notice tone="error">{errorMessage(rename.error)}</Notice>}
        <Field label="Name">{(ctl) => <Input {...ctl} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />}</Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={rename.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
