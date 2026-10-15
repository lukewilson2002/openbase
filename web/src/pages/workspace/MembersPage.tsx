/**
 * The people of a workspace: one role each, and the bases each of them can open (every base,
 * including later ones, or a picked list). Owners change both, remove people and look after the
 * invites that are still waiting; everyone else sees the list as it is and can leave.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Ellipsis, Eye, UserMinus, UserPlus } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { CreatedInvite, InviteInfo, Member, UpdateMember, WorkspaceSummary } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { ShareDialog } from "@/components/ShareDialog";
import { InviteLinkResult, useEmailEnabled } from "@/components/invites/InviteLinkResult";
import { Notice } from "@/components/layouts";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Select } from "@/components/ui/input";
import { PageSpinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { ROLE_LABELS, ROLES, atLeast, isRole } from "@/lib/roles";
import { PendingFace } from "@/shell/BaseAvatars";
import { HomeShell } from "@/shell/HomeShell";
import { accessSummary } from "./access";
import { rememberWorkspace } from "./lastWorkspace";
import { useWorkspace } from "./useWorkspace";

export function MembersPage() {
  const { workspaceId } = useParams();
  const { ws, fallback } = useWorkspace(workspaceId);
  return (
    <HomeShell workspaceId={workspaceId} section="members" topBar={ws && <span className="truncate text-[0.9375rem] font-semibold md:hidden" aria-hidden>{ws.name}</span>}>
      {ws ? <Members key={ws.id} ws={ws} /> : fallback}
    </HomeShell>
  );
}

const roleLabel = (role: string) => (isRole(role) ? ROLE_LABELS[role] : role);

function Members({ ws }: { ws: WorkspaceSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const isOwner = atLeast(ws.role, "owner");
  const members = useQuery({ queryKey: keys.workspaceMembers(ws.id), queryFn: () => api.workspaces.members(ws.id) });
  const invites = useQuery({ queryKey: keys.workspaceInvites(ws.id), queryFn: () => api.invites.forWorkspace(ws.id), enabled: isOwner });
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [resent, setResent] = useState<CreatedInvite | null>(null);
  const emailEnabled = useEmailEnabled();

  // The faces of who can open each base come with the base schemas and the workspace list.
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.workspaceMembers(ws.id) });
    void qc.invalidateQueries({ queryKey: keys.workspaceInvites(ws.id) });
    void qc.invalidateQueries({ queryKey: keys.workspaces });
    void qc.invalidateQueries({ queryKey: keys.allBases });
  };

  const update = useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UpdateMember }) => api.workspaces.updateMember(ws.id, userId, body),
    onSuccess: refresh,
    onError: (e) => toast.error(e, "Could not save the change"),
  });
  // A new invite with the same terms, then the old one goes: the old link can't be shown again
  // (only its hash is stored), so "resend" always means a fresh link.
  // Bases in the trash are left out: the server refuses to list them on a new invite.
  const resend = useMutation({
    mutationFn: async (old: InviteInfo) => {
      const baseIds = liveBaseIds(old, ws);
      const created = await api.invites.createForWorkspace(ws.id, { email: old.email ?? null, role: old.role, all_bases: old.all_bases, ...(old.all_bases ? {} : { base_ids: baseIds }) });
      await api.invites.remove(old.id);
      return created;
    },
    onSuccess: (created) => {
      setResent(created);
      if (created.info.email && emailEnabled) toast.toast({ title: `Invite sent again to ${created.info.email}`, variant: "success" });
      refresh();
    },
    onError: (e) => toast.error(e, "Could not resend the invite"),
  });
  const cancel = useMutation({
    mutationFn: (invite: InviteInfo) => api.invites.remove(invite.id),
    onSuccess: refresh,
    onError: (e) => toast.error(e, "Could not cancel the invite"),
  });

  const pending = (invites.data ?? []).filter((i) => !i.accepted_at);
  const lastOwner = (members.data ?? []).filter((m) => m.role === "owner").length <= 1;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 md:py-8">
      <p className="truncate text-xs font-semibold uppercase tracking-wide text-muted">{ws.name}</p>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <h1 className="text-2xl">Members</h1>
          <p className="mt-1 text-[0.8125rem] text-muted">Everyone here has one role. You choose which bases each person can open.</p>
        </div>
        {isOwner && (
          <Button variant="primary" onClick={() => setInviting(true)}>
            <UserPlus aria-hidden className="size-4" /> Invite people
          </Button>
        )}
      </div>

      {members.isPending ? (
        <PageSpinner label="Loading members" />
      ) : members.isError ? (
        <div className="mt-6">
          <Notice tone="error">{errorMessage(members.error)}</Notice>
        </div>
      ) : (
        <ul aria-label="Members" className="mt-6 divide-y divide-line rounded-lg border border-line bg-surface">
          {members.data.map((m) => (
            <MemberRow
              key={m.user_id}
              m={m}
              ws={ws}
              isMe={m.user_id === me?.id}
              canManage={isOwner}
              lastOwner={lastOwner}
              open={editing === m.user_id}
              onToggle={() => setEditing((cur) => (cur === m.user_id ? null : m.user_id))}
              saving={update.isPending && update.variables?.userId === m.user_id}
              onUpdate={(body) => update.mutateAsync({ userId: m.user_id, body })}
              onRemove={() => setRemoving(m)}
            />
          ))}
          {pending.map((i) => (
            <InviteRow
              key={i.id}
              invite={i}
              ws={ws}
              busy={(resend.isPending && resend.variables?.id === i.id) || (cancel.isPending && cancel.variables?.id === i.id)}
              onResend={() => resend.mutate(i)}
              onCancel={() => cancel.mutate(i)}
              result={resent?.info.id === i.id ? resent : null}
              emailEnabled={emailEnabled}
            />
          ))}
        </ul>
      )}

      <p className="mt-6 flex gap-2 text-[0.8125rem] text-muted">
        <Eye aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>Want someone outside the workspace to see a few records? Share a view instead. They get a read-only link to just that view.</span>
      </p>

      {inviting && <ShareDialog open onOpenChange={setInviting} scope="workspace" workspace={ws} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing?.user_id === me?.id ? `Leave ${ws.name}?` : `Remove ${removing?.name ?? "member"}?`}
        description={removing?.user_id === me?.id ? "You lose access to every base in this workspace." : "They lose access to every base in this workspace. You can invite them again later."}
        confirmLabel={removing?.user_id === me?.id ? "Leave workspace" : "Remove"}
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await api.workspaces.removeMember(ws.id, removing.user_id);
          if (removing.user_id === me?.id) {
            rememberWorkspace(null);
            await qc.invalidateQueries({ queryKey: keys.workspaces });
            void qc.invalidateQueries({ queryKey: keys.allBases });
            await navigate("/", { replace: true });
            return;
          }
          refresh();
        }}
      />
    </div>
  );
}

function MemberRow({
  m,
  ws,
  isMe,
  canManage,
  lastOwner,
  open,
  onToggle,
  saving,
  onUpdate,
  onRemove,
}: {
  m: Member;
  ws: WorkspaceSummary;
  isMe: boolean;
  canManage: boolean;
  lastOwner: boolean;
  open: boolean;
  onToggle: () => void;
  saving: boolean;
  onUpdate: (body: UpdateMember) => Promise<unknown>;
  onRemove: () => void;
}) {
  const owner = m.role === "owner";
  const summary = accessSummary(m, ws.bases, canManage);
  // A workspace must keep an owner; the server refuses, so say why before they try.
  const cannotLeave = isMe && owner && lastOwner;
  const editorId = `access-${m.user_id}`;
  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <Avatar name={m.name} email={m.email} />
        <div className="min-w-0 flex-1 basis-40">
          <p className="truncate text-[0.8125rem] font-medium">
            {m.name}
            {isMe && <span className="font-normal text-muted"> (you)</span>}
          </p>
          <p className="truncate text-xs text-muted">{m.email}</p>
        </div>
        <div className="flex items-center gap-2 max-sm:-ml-2 max-sm:w-[calc(100%+0.5rem)]">
          {canManage && !owner ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={open ? editorId : undefined}
              aria-label={`Bases ${m.name} can open: ${summary}`}
              onClick={onToggle}
              className="inline-flex h-8 min-w-0 items-center gap-1 rounded-md px-2 text-[0.8125rem] text-fg hover:bg-hover max-sm:flex-1 pointer-coarse:h-10"
            >
              <span className="truncate">{summary}</span>
              <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} />
            </button>
          ) : (
            <span className="px-2 text-[0.8125rem] text-muted max-sm:flex-1">{summary}</span>
          )}
          {canManage && !owner ? (
            <div className="w-32 max-sm:w-28">
              <Select aria-label={`Role for ${m.name}`} value={m.role} disabled={saving} onChange={(e) => void onUpdate({ role: e.target.value })}>
                {!isRole(m.role) && <option value={m.role}>{m.role}</option>}
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <span className="w-32 px-2 text-[0.8125rem] text-muted max-sm:w-28">{roleLabel(m.role)}</span>
          )}
          {canManage || isMe ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={`Actions for ${m.name}`} size="sm" noTooltip>
                  <Ellipsis aria-hidden className="size-4" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem danger disabled={cannotLeave} onSelect={onRemove}>
                  <UserMinus aria-hidden className="size-4" /> {isMe ? "Leave workspace" : "Remove from workspace"}
                </DropdownMenuItem>
                {cannotLeave && <DropdownMenuLabel className="max-w-56 font-normal">You are the only owner. Make someone else an owner first.</DropdownMenuLabel>}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            // Keeps the role column lined up with the rows that have an actions button.
            <span aria-hidden className="w-7 pointer-coarse:w-9" />
          )}
        </div>
      </div>
      {open && <AccessEditor id={editorId} m={m} ws={ws} saving={saving} onSave={onUpdate} onDone={onToggle} />}
    </li>
  );
}

function AccessEditor({ id, m, ws, saving, onSave, onDone }: { id: string; m: Member; ws: WorkspaceSummary; saving: boolean; onSave: (body: UpdateMember) => Promise<unknown>; onDone: () => void }) {
  const [all, setAll] = useState(m.all_bases);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(m.base_ids));
  const ids = ws.bases.filter((b) => picked.has(b.id)).map((b) => b.id);
  const toggle = (baseId: string, on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(baseId);
      else next.delete(baseId);
      return next;
    });
  const save = async () => {
    try {
      await onSave(all ? { all_bases: true } : { all_bases: false, base_ids: ids });
      onDone();
    } catch {
      /* the toast says what went wrong; the editor stays open with the choice */
    }
  };

  return (
    <div id={id} role="group" aria-label={`Bases ${m.name} can open`} className="border-t border-line bg-subtle px-4 py-3 sm:pl-15">
      <Checkbox
        checked={all}
        onCheckedChange={setAll}
        label={
          <>
            <strong className="font-semibold">All bases</strong>, including new ones
          </>
        }
      />
      <div className="ml-6 mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {ws.bases.map((b) => (
          <Checkbox key={b.id} checked={all || picked.has(b.id)} disabled={all} onCheckedChange={(on) => toggle(b.id, on)} label={b.name} />
        ))}
      </div>
      {!all && ids.length === 0 && <p className="ml-6 mt-2 text-xs text-muted">Pick at least one base, or remove them from the workspace.</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" loading={saving} disabled={!all && ids.length === 0} onClick={() => void save()}>
          Save access
        </Button>
      </div>
    </div>
  );
}

function InviteRow({
  invite,
  ws,
  busy,
  onResend,
  onCancel,
  result,
  emailEnabled,
}: {
  invite: InviteInfo;
  ws: WorkspaceSummary;
  busy: boolean;
  onResend: () => void;
  onCancel: () => void;
  result: CreatedInvite | null;
  emailEnabled: boolean;
}) {
  const who = invite.email || "Anyone with the link";
  const basesGone = !invite.all_bases && liveBaseIds(invite, ws).length === 0;
  return (
    <li aria-label={`${who}, invited`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <PendingFace size="md" email={invite.email} />
        <div className="min-w-0 flex-1 basis-40">
          <p className="flex min-w-0 items-center gap-2 text-[0.8125rem] font-medium">
            <span className="truncate">{who}</span>
            <span className="shrink-0 rounded-full border border-dashed border-faint px-2 py-px text-[0.6875rem] font-medium text-muted">Invited</span>
          </p>
          <p className="text-xs text-muted">
            Not joined yet ·{" "}
            <button
              type="button"
              disabled={busy || basesGone}
              title={basesGone ? "Its bases are in the trash. Cancel it and invite them again." : undefined}
              onClick={onResend}
              className="text-primary hover:underline disabled:opacity-50"
            >
              Resend
            </button>{" "}
            ·{" "}
            <button type="button" disabled={busy} onClick={onCancel} className="text-primary hover:underline disabled:opacity-50">
              Cancel invite
            </button>
          </p>
        </div>
        <div className="flex items-center gap-2 max-sm:-ml-2 max-sm:w-[calc(100%+0.5rem)]">
          <span className="px-2 text-[0.8125rem] text-muted max-sm:flex-1">{accessSummary(invite, ws.bases)}</span>
          <span className="w-32 px-2 text-[0.8125rem] text-muted max-sm:w-28">{roleLabel(invite.role)}</span>
          {/* Lines the role up with the member rows, whose last column is the actions button. */}
          <span aria-hidden className="w-7 pointer-coarse:w-9" />
        </div>
      </div>
      {result && (
        <div className="px-4 pb-3 sm:pl-15">
          <InviteLinkResult created={result} emailEnabled={emailEnabled} />
        </div>
      )}
    </li>
  );
}

/** The bases a limited invite lists that are still live (the workspace summary has no trashed bases). */
function liveBaseIds(invite: InviteInfo, ws: WorkspaceSummary): string[] {
  return invite.base_ids.filter((id) => ws.bases.some((b) => b.id === id));
}
