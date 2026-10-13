import { EntityLabel } from "@/components/icons/EntityIcon";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Trash2, UserMinus } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { CreatedInvite, InviteInfo, Member } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { absoluteUrl, formatDate } from "@/lib/format";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, atLeast, grantableRoles, isRole, type Role, ROLES } from "@/lib/roles";
import { CopyField } from "./CopyField";
import { Notice } from "./layouts";
import { Avatar } from "./ui/avatar";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { Dialog } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { Field, Input, Select } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { useToast } from "./ui/toast";

export interface SharingScope {
  kind: "workspace" | "base";
  id: string;
  name: string;
  /** Lucide icon name of the workspace or base, shown beside the name in the title. */
  icon?: string | null;
}

/** Minimum role needed to change members and create invites. */
export function canManageSharing(kind: SharingScope["kind"], role: string | null | undefined): boolean {
  return atLeast(role, kind === "workspace" ? "owner" : "creator");
}

function scopeOps(scope: SharingScope) {
  const { id } = scope;
  if (scope.kind === "workspace") {
    return {
      membersKey: keys.workspaceMembers(id),
      invitesKey: keys.workspaceInvites(id),
      members: () => api.workspaces.members(id),
      invites: () => api.invites.forWorkspace(id),
      createInvite: (body: { role: string; email?: string | null }) => api.invites.createForWorkspace(id, body),
      updateMember: (userId: string, role: string) => api.workspaces.updateMember(id, userId, { role }),
      removeMember: (userId: string) => api.workspaces.removeMember(id, userId),
    };
  }
  return {
    membersKey: keys.baseMembers(id),
    invitesKey: keys.baseInvites(id),
    members: () => api.bases.members(id),
    invites: () => api.invites.forBase(id),
    createInvite: (body: { role: string; email?: string | null }) => api.invites.createForBase(id, body),
    updateMember: (userId: string, role: string) => api.bases.updateMember(id, userId, { role }),
    removeMember: (userId: string) => api.bases.removeMember(id, userId),
  };
}

export interface SharingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: SharingScope;
  /** Caller's role in the scope (workspace role or effective base role). */
  myRole: string | null | undefined;
}

export function SharingDialog({ open, onOpenChange, scope, myRole }: SharingDialogProps) {
  const manage = canManageSharing(scope.kind, myRole);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex min-w-0 items-center gap-2">
          Share <EntityLabel icon={scope.icon}>{scope.name}</EntityLabel>
        </span>
      }
      description={scope.kind === "workspace" ? "People in a workspace can open every base in it." : "Base members add to the access they already have through the workspace."}
    >
      <div className="flex flex-col gap-6">
        <MembersList scope={scope} myRole={myRole} canManage={manage} />
        {manage ? <InvitesPanel scope={scope} myRole={myRole} /> : <Notice>Only {scope.kind === "workspace" ? "owners" : "creators and owners"} can change members or invite people.</Notice>}
      </div>
    </Dialog>
  );
}

function MembersList({ scope, myRole, canManage }: { scope: SharingScope; myRole: string | null | undefined; canManage: boolean }) {
  const ops = scopeOps(scope);
  const qc = useQueryClient();
  const toast = useToast();
  const { data: me } = useMe();
  const members = useQuery({ queryKey: ops.membersKey, queryFn: ops.members });
  const [removing, setRemoving] = useState<Member | null>(null);
  const roles = grantableRoles(myRole);

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) => ops.updateMember(userId, role),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ops.membersKey }),
    onError: (e) => toast.error(e, "Could not change role"),
  });

  return (
    <section aria-labelledby="members-heading">
      <h3 id="members-heading" className="mb-2 text-[0.9375rem]">
        Members
      </h3>
      {members.isPending ? (
        <Spinner />
      ) : members.isError ? (
        <Notice tone="error">{errorMessage(members.error)}</Notice>
      ) : members.data.length === 0 ? (
        <p className="text-[0.8125rem] text-muted">No members yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {members.data.map((m) => {
            const isMe = m.user_id === me?.id;
            const editable = canManage && roles.length > 0 && (!isRole(m.role) || roles.includes(m.role));
            return (
              <li key={m.user_id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <Avatar name={m.name} email={m.email} />
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate text-[0.8125rem] font-medium">
                    {m.name}
                    {isMe && <span className="ml-1 font-normal text-muted">(you)</span>}
                  </p>
                  <p className="truncate text-xs text-muted">{m.email}</p>
                </div>
                {editable ? (
                  <div className="w-36">
                    <Select
                      aria-label={`Role for ${m.name}`}
                      value={m.role}
                      disabled={changeRole.isPending}
                      onChange={(e) => changeRole.mutate({ userId: m.user_id, role: e.target.value })}
                    >
                      {!isRole(m.role) && <option value={m.role}>{m.role}</option>}
                      {roles.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : (
                  <span className="text-[0.8125rem] text-muted">{isRole(m.role) ? ROLE_LABELS[m.role] : m.role}</span>
                )}
                {canManage && (
                  <IconButton label={isMe ? "Leave" : `Remove ${m.name}`} size="sm" onClick={() => setRemoving(m)}>
                    <UserMinus aria-hidden className="size-4" />
                  </IconButton>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing?.user_id === me?.id ? `Leave ${scope.name}?` : `Remove ${removing?.name ?? "member"}?`}
        description={`They will lose the access they have through this ${scope.kind}.`}
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await ops.removeMember(removing.user_id);
          void qc.invalidateQueries({ queryKey: ops.membersKey });
        }}
      />
    </section>
  );
}

function InvitesPanel({ scope, myRole }: { scope: SharingScope; myRole: string | null | undefined }) {
  const ops = scopeOps(scope);
  const qc = useQueryClient();
  const toast = useToast();
  const roles = grantableRoles(myRole);
  const [role, setRole] = useState<Role>(roles.includes("editor") ? "editor" : (roles[roles.length - 1] ?? "viewer"));
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const invites = useQuery({ queryKey: ops.invitesKey, queryFn: ops.invites });

  const create = useMutation({
    mutationFn: () => ops.createInvite({ role, email: email.trim() || null }),
    onSuccess: (res) => {
      setCreated(res);
      setEmail("");
      void qc.invalidateQueries({ queryKey: ops.invitesKey });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.invites.remove(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ops.invitesKey }),
    onError: (e) => toast.error(e, "Could not revoke invite"),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const pending: InviteInfo[] = (invites.data ?? []).filter((i) => !i.accepted_at);

  return (
    <section aria-labelledby="invite-heading">
      <h3 id="invite-heading" className="mb-2 text-[0.9375rem]">
        Invite people
      </h3>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label="Role" className="w-40" hint={ROLE_DESCRIPTIONS[role]}>
          {(ctl) => (
            <Select {...ctl} value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.filter((r) => roles.includes(r)).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Email (optional)" className="min-w-48 flex-1">
          {(ctl) => <Input {...ctl} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Restrict to this address" />}
        </Field>
        <Button type="submit" variant="primary" loading={create.isPending}>
          <Link2 aria-hidden className="size-4" /> Create invite link
        </Button>
      </form>
      {create.isError && (
        <div className="mt-3">
          <Notice tone="error">{errorMessage(create.error)}</Notice>
        </div>
      )}
      {created && (
        <div className="mt-3 flex flex-col gap-1.5 rounded-md border border-line bg-subtle p-3">
          <p className="text-[0.8125rem] font-medium">Invite link (shown once)</p>
          <CopyField label="Invite link" value={absoluteUrl(created.url)} />
        </div>
      )}
      {pending.length > 0 && (
        <ul className="mt-4 divide-y divide-line rounded-md border border-line">
          {pending.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-3 py-2 text-[0.8125rem]">
              <div className="min-w-0 flex-1">
                <p className="truncate">{i.email ?? "Anyone with the link"}</p>
                <p className="text-xs text-muted">
                  {isRole(i.role) ? ROLE_LABELS[i.role] : i.role} - expires {formatDate(i.expires_at)}
                </p>
              </div>
              <IconButton label="Revoke invite" size="sm" onClick={() => revoke.mutate(i.id)}>
                <Trash2 aria-hidden className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
