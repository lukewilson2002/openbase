/**
 * "Share view" for Creators and owners: the share links of one view.
 *
 * A form view is shared as a *form* link (anyone with it can submit a record, nothing else);
 * every other view is shared as a read-only *view* link (anyone with it can look at the view's
 * records, but only through the fields the view shows). Each link can be switched off without
 * deleting it, protected with a password (checked by the server; visitors enter it on the public
 * page) and deleted. A view can have up to 20 links; personal views cannot be shared.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Link2, Lock, Plus, Trash2 } from "lucide-react";
import { errorMessage } from "@/api/client";
import { keys } from "@/api/keys";
import { sharesApi } from "@/api/sharing";
import type { ShareKind, ShareLink, Table, View } from "@/api/types";
import { CopyField } from "@/components/CopyField";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Field, Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { publicLink, sharePasswordProblem } from "@/lib/shareLinks";
import { liveEntries, publicStatus } from "@/lib/forms/formConfig";
import { MAX_SHARES_PER_VIEW, canShareView, shareKindOf } from "./shareView";

export { MAX_SHARES_PER_VIEW, canShareView, shareKindOf };

export interface ShareViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: View;
  table: Pick<Table, "fields" | "primary_field_id">;
}

export function ShareViewDialog({ open, onOpenChange, view, table }: ShareViewDialogProps) {
  const kind = shareKindOf(view);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`Share ${view.name}`}
      description={kind === "form" ? "Let anyone fill in this form, without an account." : "Let anyone look at this view, without an account."}
    >
      {open && <ShareLinks view={view} table={table} kind={kind} />}
    </Dialog>
  );
}

function WhatIsPublic({ view, table, kind }: { view: View; table: ShareViewDialogProps["table"]; kind: ShareKind }) {
  if (kind === "form") {
    const entries = liveEntries(view.config.form, table);
    const shown = entries.filter((e) => publicStatus(e.field, view.config.hidden_fields).public);
    const left = entries.length - shown.length;
    const notified = view.config.form.notify_user_ids.length;
    return (
      <div className="flex flex-col gap-1 rounded-md bg-subtle px-3 py-2 text-[0.8125rem]">
        <p>
          <strong>What visitors can do:</strong> fill in and submit this form, once per submission. They never see any record, existing or new.
        </p>
        <p>
          <strong>What the form asks:</strong> {shown.length} field{shown.length === 1 ? "" : "s"}
          {shown.length > 0 && <>: {shown.map((e) => e.entry.label?.trim() || e.field.name).join(", ")}</>}.
          {left > 0 && ` ${left} more (links and users) are not collected publicly.`}
        </p>
        {shown.length === 0 && <p className="text-danger">The form has no fields visitors can fill in. Add some in the builder first.</p>}
        <p>
          <strong>Responses:</strong>{" "}
          {notified === 0
            ? "nobody is told when one comes in. Turn on “Notify me of new responses” in the form builder."
            : `${notified} ${notified === 1 ? "person is" : "people are"} notified of each one (in the app, and by email if this server can send mail).`}
        </p>
        <p>
          <strong>Prefill:</strong> add <code>?prefill_Field name=value</code> to a link to start a field with that value, and <code>&amp;hide_Field name=true</code> to take it off the page.
        </p>
      </div>
    );
  }
  const hiddenCount = view.config.hidden_fields.filter((id) => id !== table.primary_field_id && table.fields.some((f) => f.id === id)).length;
  const shownCount = table.fields.length - hiddenCount;
  return (
    <div className="flex flex-col gap-1 rounded-md bg-subtle px-3 py-2 text-[0.8125rem]">
      <p>
        <strong>What is public:</strong> the records this view shows (its filter and sort apply), read-only, with the {shownCount} visible field{shownCount === 1 ? "" : "s"}.
        {hiddenCount > 0 ? ` The ${hiddenCount} hidden field${hiddenCount === 1 ? "" : "s"} never leave${hiddenCount === 1 ? "s" : ""} the server.` : " Hide a field in this view to keep it private."}
      </p>
      <p>
        <strong>What is not:</strong> e-mail addresses and user ids, who edited a record, comments and history. People are shown by name only. Changes you make to the view or the records show up for visitors straight away.
      </p>
    </div>
  );
}

function ShareLinks({ view, table, kind }: { view: View; table: ShareViewDialogProps["table"]; kind: ShareKind }) {
  const qc = useQueryClient();
  const toast = useToast();
  const links = useQuery({ queryKey: keys.shares(view.id), queryFn: () => sharesApi.list(view.id) });
  const refresh = () => qc.invalidateQueries({ queryKey: keys.shares(view.id) });
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [usePassword, setUsePassword] = useState(false);
  const [removing, setRemoving] = useState<ShareLink | null>(null);

  const create = useMutation({
    mutationFn: () => sharesApi.create(view.id, { kind, ...(usePassword ? { password } : {}) }),
    onSuccess: () => {
      setPassword("");
      setUsePassword(false);
      void refresh();
    },
    onError: (e) => toast.error(e, "Could not create the link"),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof sharesApi.update>[1] }) => sharesApi.update(id, body),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(e, "Could not change the link"),
  });
  const remove = useMutation({ mutationFn: (id: string) => sharesApi.remove(id), onSuccess: () => void refresh() });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (usePassword) {
      const problem = sharePasswordProblem(password);
      setPasswordError(problem);
      if (problem) return;
    }
    create.mutate();
  };

  const full = (links.data?.length ?? 0) >= MAX_SHARES_PER_VIEW;
  const noun = kind === "form" ? "form link" : "link";

  return (
    <div className="flex flex-col gap-5">
      <WhatIsPublic view={view} table={table} kind={kind} />

      <section aria-labelledby="share-links-heading">
        <h3 id="share-links-heading" className="mb-2 text-[0.9375rem]">
          {kind === "form" ? "Form links" : "Links"}
        </h3>
        {links.isPending ? (
          <Spinner label="Loading links" />
        ) : links.isError ? (
          <Notice tone="error">{errorMessage(links.error)}</Notice>
        ) : links.data.length === 0 ? (
          <p className="text-[0.8125rem] text-muted">No {noun}s yet. Create one below to share this {kind === "form" ? "form" : "view"}.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {links.data.map((link) => (
              <ShareRow key={link.id} link={link} busy={update.isPending && update.variables?.id === link.id} onUpdate={(body) => update.mutateAsync({ id: link.id, body })} onDelete={() => setRemoving(link)} />
            ))}
          </ul>
        )}
      </section>

      <form onSubmit={submit} className="flex flex-col gap-3 border-t border-line pt-4" aria-label={`Create a ${noun}`}>
        <h3 className="text-[0.9375rem]">New {noun}</h3>
        <Switch checked={usePassword} onCheckedChange={(on) => { setUsePassword(on); setPasswordError(null); }} label="Protect with a password" />
        {usePassword && (
          <Field label="Password" hint="Visitors enter it once per visit. Keep it out of the link itself." error={passwordError}>
            {(ctl) => <Input {...ctl} type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={256} />}
          </Field>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" loading={create.isPending} disabled={full}>
            <Plus aria-hidden className="size-4" /> Create {noun}
          </Button>
          {full && <span className="text-[0.8125rem] text-muted">A view can have at most {MAX_SHARES_PER_VIEW} links. Delete one to make room.</span>}
        </div>
      </form>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Delete this link?"
        description="Anyone using it will see a “not found” page from now on. This cannot be undone; create a new link to share again."
        confirmLabel="Delete link"
        destructive
        onConfirm={() => (removing ? remove.mutateAsync(removing.id) : undefined)}
      />
    </div>
  );
}

function ShareRow({ link, busy, onUpdate, onDelete }: { link: ShareLink; busy: boolean; onUpdate: (body: Parameters<typeof sharesApi.update>[1]) => Promise<unknown>; onDelete: () => void }) {
  const [editingPassword, setEditingPassword] = useState(false);
  const url = publicLink(link, window.location.origin);
  return (
    <li className="rounded-md border border-line p-3" aria-label={`${link.kind === "form" ? "Form link" : "Link"} created ${formatDateTime(link.created_at)}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Link2 aria-hidden className="size-4 text-muted" />
        <span className="text-[0.8125rem] font-medium">Created {formatDateTime(link.created_at)}</span>
        {link.has_password ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-subtle px-2 py-0.5 text-xs">
            <Lock aria-hidden className="size-3" /> Password protected
          </span>
        ) : (
          <span className="rounded-full bg-subtle px-2 py-0.5 text-xs text-muted">No password</span>
        )}
        {!link.enabled && <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs">Off</span>}
        <div className="ml-auto flex items-center gap-1">
          <Switch checked={link.enabled} disabled={busy} onCheckedChange={(enabled) => void onUpdate({ enabled })} label="Link enabled" />
          <IconButton label="Delete link" size="sm" onClick={onDelete}>
            <Trash2 aria-hidden className="size-4" />
          </IconButton>
        </div>
      </div>
      <CopyField value={url} label={link.kind === "form" ? "Form link" : "View link"} />
      {!link.enabled && <p className="mt-1.5 text-xs text-muted">This link is switched off: visitors see “not found” until you switch it on again.</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {editingPassword ? (
          <PasswordForm
            hasPassword={link.has_password}
            onCancel={() => setEditingPassword(false)}
            onSave={async (password) => {
              await onUpdate({ password });
              setEditingPassword(false);
            }}
          />
        ) : (
          <>
            <Button size="sm" onClick={() => setEditingPassword(true)}>
              <KeyRound aria-hidden className="size-3.5" /> {link.has_password ? "Change password" : "Set password"}
            </Button>
            {link.has_password && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onUpdate({ password: null })}>
                Remove password
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function PasswordForm({ hasPassword, onSave, onCancel }: { hasPassword: boolean; onSave: (password: string) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = sharePasswordProblem(value);
    setError(problem);
    if (problem) return;
    setPending(true);
    try {
      await onSave(value);
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex w-full flex-wrap items-start gap-2">
      <div className="min-w-48 flex-1">
        <Field label={hasPassword ? "New password" : "Password"} error={error}>
          {(ctl) => <Input {...ctl} type="text" autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} maxLength={256} />}
        </Field>
      </div>
      <div className="flex gap-2 pt-[1.45rem]">
        <Button type="submit" variant="primary" size="sm" loading={pending}>
          Save password
        </Button>
        <Button size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
