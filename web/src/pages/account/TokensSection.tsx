import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { CreatedToken, TokenInfo } from "@/api/types";
import { errorMessage } from "@/api/client";
import { CopyField } from "@/components/CopyField";
import { Notice, Section } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Field, Input, Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { formatDate } from "@/lib/format";

export function TokensSection() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: keys.tokens, queryFn: api.tokens.list });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [revoking, setRevoking] = useState<TokenInfo | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.tokens });

  return (
    <Section
      title="Personal access tokens"
      description="Use tokens to call the REST API from scripts and tools, or to connect an AI assistant (see AI assistants). A token acts as you, limited by the scope you choose."
    >
      <div className="mb-4">
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus aria-hidden className="size-4" /> New token
        </Button>
      </div>
      {tokens.isPending ? (
        <Spinner />
      ) : tokens.isError ? (
        <Notice tone="error">{errorMessage(tokens.error)}</Notice>
      ) : tokens.data.length === 0 ? (
        <EmptyState icon={<KeyRound />} title="No tokens yet" description="Create a token to use the API." />
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {tokens.data.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <KeyRound aria-hidden className="size-5 shrink-0 text-muted" />
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate text-[0.8125rem] font-medium">
                  {t.name}
                  <span className="ml-2 rounded-full bg-subtle px-2 py-0.5 text-xs font-normal text-muted">{t.write ? "Read and write" : "Read only"}</span>
                  {t.manage && <span className="ml-1 rounded-full bg-subtle px-2 py-0.5 text-xs font-normal text-danger">Can manage workspaces and members</span>}
                </p>
                <p className="text-xs text-muted">
                  Created {formatDate(t.created_at)} - {t.last_used_at ? `last used ${formatDate(t.last_used_at)}` : "never used"}
                  {t.expires_at ? ` - expires ${formatDate(t.expires_at)}` : ""}
                  {t.base_ids ? ` - ${t.base_ids.length} project${t.base_ids.length === 1 ? "" : "s"}` : " - all projects"}
                </p>
              </div>
              <IconButton label={`Revoke ${t.name}`} size="sm" onClick={() => setRevoking(t)}>
                <Trash2 aria-hidden className="size-4" />
              </IconButton>
            </li>
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
        description="Anything using this token will stop working immediately."
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
  const [write, setWrite] = useState(false);
  const [manage, setManage] = useState(false);
  const [expiry, setExpiry] = useState("");
  const [limitBases, setLimitBases] = useState(false);
  const [baseIds, setBaseIds] = useState<string[]>([]);
  // Only needed (and only fetched) when the token is limited to some bases.
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list, enabled: limitBases });
  const create = useMutation({
    mutationFn: () =>
      api.tokens.create({
        name: name.trim(),
        write,
        manage: write && manage,
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
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New personal access token" size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {create.isError && <Notice tone="error">{errorMessage(create.error)}</Notice>}
        <Field label="Name" hint="For example: Zapier, nightly export.">
          {(ctl) => <Input {...ctl} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />}
        </Field>
        <Checkbox
          checked={write}
          onCheckedChange={(v) => {
            setWrite(v);
            if (!v) setManage(false);
          }}
          label="Allow writes (otherwise read only)"
        />
        <div className="flex flex-col gap-1">
          <Checkbox checked={write && manage} onCheckedChange={setManage} disabled={!write} label="Allow managing workspaces, members and settings" />
          <p className="pl-6 text-xs text-muted">
            Lets whoever holds this token do what you can do in the app beyond your data: create, rename and delete workspaces, change who has access, send invites,
            and use the admin pages if you are an administrator. Only turn this on for tools you fully trust, such as an AI agent that should work for you. Passwords, two-factor
            settings, sessions and tokens can never be changed with a token.
          </p>
        </div>
        <Field label="Projects">
          {(ctl) => (
            <Select
              {...ctl}
              value={limitBases ? "some" : "all"}
              onChange={(e) => {
                setLimitBases(e.target.value === "some");
                if (e.target.value !== "some") setBaseIds([]);
              }}
            >
              <option value="all">All projects I can access</option>
              <option value="some">Only the projects I select</option>
            </Select>
          )}
        </Field>
        {limitBases && (
          <div className="flex flex-col gap-1.5" role="group" aria-label="Allowed projects">
            {workspaces.isPending ? (
              <Spinner />
            ) : workspaces.isError ? (
              <Notice tone="error">{errorMessage(workspaces.error)}</Notice>
            ) : (
              workspaces.data.flatMap((w) =>
                w.bases.map((b) => (
                  <Checkbox
                    key={b.id}
                    checked={baseIds.includes(b.id)}
                    onCheckedChange={(on) => setBaseIds((cur) => (on ? [...cur, b.id] : cur.filter((x) => x !== b.id)))}
                    label={`${w.name} / ${b.name}`}
                  />
                )),
              )
            )}
            <p className="text-xs text-muted">A token limited to projects cannot manage workspaces, members or the admin pages.</p>
          </div>
        )}
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
