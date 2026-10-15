/**
 * "Share": invite people into the workspace (choosing which of its bases they can open) and, from
 * a base, share one view as a read-only link. Opened from the workspace page (invites only), from
 * a base's top bar, and from a view's menu in the base sidebar (on "Share a view").
 */
import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { Tabs as T } from "radix-ui";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, CreateInviteRequest, CreatedInvite, Table, View, WorkspaceSummary } from "@/api/types";
import { InviteLinkResult, useEmailEnabled } from "@/components/invites/InviteLinkResult";
import { ShareViewTab } from "@/components/share/ShareViewLink";
import { canShareView } from "@/components/share/shareView";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, atLeast, grantableRoles, type Role } from "@/lib/roles";

/** The order roles are offered in: the common choice first. */
const ROLE_CHOICES: readonly Role[] = ["editor", "commenter", "viewer", "creator", "owner"];

export type ShareDialogTarget =
  | { scope: "workspace"; workspace: Pick<WorkspaceSummary, "id" | "name" | "role"> }
  | {
      scope: "base";
      base: Pick<BaseSchema, "id" | "name" | "role" | "workspace_id">;
      workspaceName: string;
      /** The table on screen: its views can be shared. */
      table?: Pick<Table, "views"> | null;
      /** The view on screen, picked by default in "Share a view". */
      view?: Pick<View, "id"> | null;
      /** Open on "Share a view" (a view's own "Share view…" item) instead of "Invite people". */
      initialTab?: "invite" | "view";
    };

export type ShareDialogProps = ShareDialogTarget & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ShareDialog(props: ShareDialogProps) {
  const { open, onOpenChange } = props;
  const name = props.scope === "workspace" ? props.workspace.name : props.base.name;
  const role = props.scope === "workspace" ? props.workspace.role : props.base.role;
  const views = props.scope === "base" ? (props.table?.views ?? []) : [];
  const viewTab = props.scope === "base" && views.some((v) => canShareView(role, v));
  const [tab, setTab] = useState<string>(props.scope === "base" ? (props.initialTab ?? "invite") : "invite");

  // The server refuses base invites below creator; a form that can only fail would waste their time.
  const canInvite = props.scope === "workspace" || atLeast(role, "creator");
  const invite = canInvite ? (
    <InviteForm target={props} onNavigate={() => onOpenChange(false)} />
  ) : (
    <Notice>Only creators and owners can invite people. Ask one of them, or share a view.</Notice>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Share ${name}`} className="max-w-[520px]">
      {open &&
        (viewTab ? (
          <T.Root value={tab} onValueChange={setTab}>
            <T.List aria-label="How to share" className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-subtle p-1">
              {[
                ["invite", "Invite people"],
                ["view", "Share a view"],
              ].map(([value, label]) => (
                <T.Trigger
                  key={value}
                  value={value!}
                  className="h-8 rounded-md text-[0.8125rem] font-medium text-muted transition-colors hover:text-fg data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-pop pointer-coarse:h-10"
                >
                  {label}
                </T.Trigger>
              ))}
            </T.List>
            <T.Content value="invite" className="focus-visible:outline-none">
              {invite}
            </T.Content>
            <T.Content value="view" className="focus-visible:outline-none">
              <ShareViewTab views={views} initialViewId={props.scope === "base" ? props.view?.id : null} />
            </T.Content>
          </T.Root>
        ) : (
          invite
        ))}
    </Dialog>
  );
}

function InviteForm({ target, onNavigate }: { target: ShareDialogTarget; onNavigate: () => void }) {
  const qc = useQueryClient();
  const emailEnabled = useEmailEnabled();
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const fromBase = target.scope === "base";
  const workspaceId = fromBase ? target.base.workspace_id : target.workspace.id;
  const workspaceName = fromBase ? target.workspaceName : target.workspace.name;
  const myRole = fromBase ? target.base.role : target.workspace.role;
  const isOwner = atLeast(myRole, "owner");
  // The bases the inviter can open: nobody can hand out access they do not have.
  const bases = workspaces.data?.find((w) => w.id === workspaceId)?.bases ?? (fromBase ? [{ id: target.base.id, name: target.base.name }] : []);

  const roles = ROLE_CHOICES.filter((r) => grantableRoles(myRole).includes(r));
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>(roles.includes("editor") ? "editor" : (roles[0] ?? "viewer"));
  // From a base, the obvious meaning is "this base"; from the workspace, its owner means everything.
  const [mode, setMode] = useState<"pick" | "all">(!fromBase && isOwner ? "all" : "pick");
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(fromBase ? [target.base.id] : []));
  const [created, setCreated] = useState<CreatedInvite | null>(null);

  const everything = role === "owner" || mode === "all";
  const pickedIds = bases.filter((b) => picked.has(b.id)).map((b) => b.id);

  const send = useMutation({
    mutationFn: () => {
      const body: CreateInviteRequest = { email: email.trim() || null, role, ...(everything ? { all_bases: true } : { all_bases: false, base_ids: pickedIds }) };
      return fromBase ? api.invites.createForBase(target.base.id, body) : api.invites.createForWorkspace(workspaceId, body);
    },
    onSuccess: (res) => {
      setCreated(res);
      setEmail("");
      void qc.invalidateQueries({ queryKey: keys.workspaces });
      void qc.invalidateQueries({ queryKey: keys.workspaceInvites(workspaceId) });
      if (fromBase) void qc.invalidateQueries({ queryKey: keys.base(target.base.id) });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!everything && pickedIds.length === 0) return;
    send.mutate();
  };
  const toggle = (id: string, on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Invite people">
      <p className="text-[0.8125rem] text-muted">
        People you invite join the <strong className="font-semibold text-fg">{workspaceName}</strong> workspace. Choose which of its bases they can open.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <Field label="Email" hint="Leave it empty to get a link anyone can use.">
          {(ctl) => <Input {...ctl} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />}
        </Field>
        <Field label="Role" hint={ROLE_DESCRIPTIONS[role]}>
          {(ctl) => (
            <Select {...ctl} value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <fieldset disabled={role === "owner"} className="flex flex-col gap-2 rounded-md border border-line p-3 disabled:opacity-70">
        <legend className="px-1 text-[0.8125rem] font-medium">Bases they can open</legend>
        {role === "owner" ? (
          <p className="text-[0.8125rem] text-muted">Owners can always open every base in {workspaceName}.</p>
        ) : (
          <>
            <Radio name="share-access" checked={mode === "pick"} onChange={() => setMode("pick")} label="Only the bases I pick" />
            {mode === "pick" && (
              <div className="ml-6 flex flex-col gap-2" role="group" aria-label="Bases">
                {bases.length === 0 ? (
                  <p className="text-[0.8125rem] text-muted">This workspace has no bases yet.</p>
                ) : (
                  bases.map((b) => <Checkbox key={b.id} checked={picked.has(b.id)} onCheckedChange={(on) => toggle(b.id, on)} label={b.name} />)
                )}
                {bases.length > 0 && pickedIds.length === 0 && <p className="text-xs text-danger">Pick at least one base.</p>}
              </div>
            )}
            {isOwner && <Radio name="share-access" checked={mode === "all"} onChange={() => setMode("all")} label={`All bases in ${workspaceName}`} hint="Including bases made later" />}
          </>
        )}
      </fieldset>

      {send.isError && <Notice tone="error">{errorMessage(send.error)}</Notice>}
      {created && <InviteLinkResult created={created} emailEnabled={emailEnabled} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to={`/workspace/${workspaceId}/members`} onClick={onNavigate} className="text-[0.8125rem]">
          Manage all members
        </Link>
        <Button type="submit" variant="primary" loading={send.isPending} disabled={!everything && pickedIds.length === 0}>
          <Send aria-hidden className="size-4" /> Send invite
        </Button>
      </div>
    </form>
  );
}

function Radio({ name, checked, onChange, label, hint }: { name: string; checked: boolean; onChange: () => void; label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2 text-[0.8125rem]">
      <input id={id} type="radio" name={name} checked={checked} onChange={onChange} aria-describedby={hint ? `${id}-hint` : undefined} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" />
      <div>
        <label htmlFor={id} className="cursor-pointer font-medium">
          {label}
        </label>
        {hint && (
          <p id={`${id}-hint`} className="text-xs text-muted">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
