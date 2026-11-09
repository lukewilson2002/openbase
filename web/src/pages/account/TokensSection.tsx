import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { CreatedToken, TokenInfo } from "@/api/types";
import { errorMessage } from "@/api/client";
import { AccessChoice } from "@/components/AccessChoice";
import { CopyField } from "@/components/CopyField";
import { FolderLimit } from "@/components/FolderLimit";
import { Notice, Section, SettingsRow } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { formatDate } from "@/lib/format";
import { TOKEN_ACCESS_LABEL, accessOf, type OAuthAccess } from "@/lib/oauthAccess";

export function TokensSection() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: keys.tokens, queryFn: api.tokens.list });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [revoking, setRevoking] = useState<TokenInfo | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.tokens });

  return (
    <Section
      title="API tokens"
      description="Use tokens to call the REST API from scripts and tools, or to connect an AI assistant (see AI assistants). A token acts as you, limited by the access you choose."
      flush
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          New token
        </Button>
      }
    >
      {tokens.isPending ? (
        <div aria-hidden className="p-4">
          <Skeleton className="h-10" />
        </div>
      ) : tokens.isError ? (
        <div className="p-4">
          <Notice tone="error">{errorMessage(tokens.error)}</Notice>
        </div>
      ) : tokens.data.length === 0 ? (
        <EmptyState title="No tokens yet" description="Create a token to use the API." />
      ) : (
        <ul className="divide-y divide-line" aria-label="API tokens">
          {tokens.data.map((t) => (
            <SettingsRow
              key={t.id}
              title={
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate">{t.name}</span>
                  <StatusChip hue={accessOf(t) === "manage" ? "orange" : "gray"}>{TOKEN_ACCESS_LABEL[accessOf(t)]}</StatusChip>
                </span>
              }
              description={
                <>
                  Created {formatDate(t.created_at)} - {t.last_used_at ? `last used ${formatDate(t.last_used_at)}` : "never used"}
                  {t.expires_at ? ` - expires ${formatDate(t.expires_at)}` : ""}
                  {t.base_ids ? ` - ${t.base_ids.length} folder${t.base_ids.length === 1 ? "" : "s"}` : " - all folders"}
                </>
              }
              action={
                <Button aria-label={`Revoke ${t.name}`} onClick={() => setRevoking(t)}>
                  Revoke
                </Button>
              }
            />
          ))}
        </ul>
      )}

      {creating && (
        <CreateTokenDialog
          onClose={() => setCreating(false)}
          onCreated={(res) => {
            setCreating(false);
            setCreated(res);
            void refresh();
          }}
        />
      )}
      {created && (
        <Dialog
          open
          onOpenChange={(o) => !o && setCreated(null)}
          title="Copy your new token"
          description="This is the only time the token is shown. Store it somewhere safe."
          footer={
            <Button variant="primary" onClick={() => setCreated(null)}>
              Done
            </Button>
          }
        >
          <CopyField label="API token" value={created.token} />
        </Dialog>
      )}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? "token"}?`}
        description="Anything using this token stops working immediately. This can't be undone; make a new token to get access back."
        confirmLabel="Revoke token"
        destructive
        onConfirm={async () => {
          if (!revoking) return;
          await api.tokens.revoke(revoking.id);
          void refresh();
        }}
      />
    </Section>
  );
}

function CreateTokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (t: CreatedToken) => void }) {
  const [name, setName] = useState("");
  const [access, setAccess] = useState<OAuthAccess>("read");
  const [expiry, setExpiry] = useState("");
  const [limitBases, setLimitBases] = useState(false);
  const [baseIds, setBaseIds] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: () =>
      api.tokens.create({
        name: name.trim(),
        write: access !== "read",
        manage: access === "manage",
        base_ids: limitBases ? baseIds : null,
        expires_in_days: expiry ? Number(expiry) : null,
      }),
    onSuccess: onCreated,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New API token" size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {create.isError && <Notice tone="error">{errorMessage(create.error)}</Notice>}
        <Field label="Name" hint="For example: Zapier, nightly export.">
          {(ctl) => <Input {...ctl} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />}
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-label font-medium">What can it do?</legend>
          {/* The server takes any level with any folder limit for a token (only an app's grant has the rule that Full access reaches every folder). */}
          <AccessChoice value={access} onChange={setAccess} labels={TOKEN_ACCESS_LABEL} />
          <p className="text-meta text-muted">Passwords, two-factor settings, sessions and tokens can never be changed with a token. Only give Full access to tools you fully trust, such as an AI agent that should work for you.</p>
        </fieldset>
        <FolderLimit
          limited={limitBases}
          onLimitedChange={setLimitBases}
          baseIds={baseIds}
          onBaseIdsChange={setBaseIds}
        />
        <Field label="Expires">
          {(ctl) => (
            <Select {...ctl} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              <option value="">Never</option>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In 1 year</option>
            </Select>
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim() || (limitBases && baseIds.length === 0)}>
            Create token
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
