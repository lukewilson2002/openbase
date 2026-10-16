/**
 * "Share": invite people into the workspace (choosing which of its bases they can open) and share
 * one view as a read-only link. Opened from a base's top bar and from a view's menu in the base
 * sidebar ("Share Chores", the base picked, the table's views on offer), and from the workspace
 * page and the Members page ("Share Household", every base picked, the views of every base on
 * offer, named after their base: "Chores › All chores").
 */
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tabs as T } from "radix-ui";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, BaseSummary, CreateInviteRequest, CreatedInvite, Table, View, WorkspaceSummary } from "@/api/types";
import { InviteLinkResult, useEmailEnabled } from "@/components/invites/InviteLinkResult";
import { EntityTile } from "@/components/icons/EntityIcon";
import { ShareViewTab } from "@/components/share/ShareViewLink";
import { canShareView } from "@/components/share/shareView";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, atLeast, grantableRoles, type Role } from "@/lib/roles";

/** The order roles are offered in: the common choice first. */
const ROLE_CHOICES: readonly Role[] = ["editor", "commenter", "viewer", "creator", "owner"];

export type ShareDialogTarget =
  | {
      scope: "workspace";
      workspace: Pick<WorkspaceSummary, "id" | "name" | "role"> & { bases?: readonly Pick<BaseSummary, "id" | "name" | "role">[] };
    }
  | {
      scope: "base";
      base: Pick<BaseSchema, "id" | "name" | "role" | "workspace_id"> & Partial<Pick<BaseSchema, "color" | "icon">>;
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

const TAB_LIST = "mb-5 grid grid-cols-2 gap-1 rounded-xl bg-subtle p-1";
const TAB =
  "h-10 rounded-[9px] text-sm font-semibold text-muted transition-colors hover:text-fg data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-[0_1px_3px_rgb(15_20_30/0.12)]";

export function ShareDialog(props: ShareDialogProps) {
  const { open, onOpenChange } = props;
  const name = props.scope === "workspace" ? props.workspace.name : props.base.name;
  const role = props.scope === "workspace" ? props.workspace.role : props.base.role;
  const baseViews = props.scope === "base" ? (props.table?.views ?? []) : [];
  // From the workspace, any base the person may share views of brings its views along.
  const viewTab = props.scope === "base" ? baseViews.some((v) => canShareView(role, v)) : (props.workspace.bases ?? []).some((b) => atLeast(b.role, "creator"));
  const [tab, setTab] = useState<string>(props.scope === "base" ? (props.initialTab ?? "invite") : "invite");

  // The server refuses workspace invites below owner and base invites below creator; a form that
  // can only fail would waste their time.
  const canInvite = props.scope === "workspace" ? atLeast(role, "owner") : atLeast(role, "creator");
  const invite = canInvite ? (
    <InviteForm target={props} onNavigate={() => onOpenChange(false)} />
  ) : (
    <Notice>
      {props.scope === "workspace" ? "Only owners can invite people to the whole workspace. Open a base to invite people to it, or share a view." : "Only creators and owners can invite people. Ask one of them, or share a view."}
    </Notice>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Share ${name}`} roomy className="max-w-[520px]">
      {open &&
        (viewTab ? (
          <T.Root value={tab} onValueChange={setTab}>
            <T.List aria-label="How to share" className={TAB_LIST}>
              {[
                ["invite", "Invite people"],
                ["view", "Share a view"],
              ].map(([value, label]) => (
                <T.Trigger key={value} value={value!} className={TAB}>
                  {label}
                </T.Trigger>
              ))}
            </T.List>
            <T.Content value="invite" className="focus-visible:outline-none">
              {invite}
            </T.Content>
            <T.Content value="view" className="focus-visible:outline-none">
              {props.scope === "base" ? (
                <ShareViewTab views={baseViews} initialViewId={props.view?.id} />
              ) : (
                <WorkspaceViews bases={(props.workspace.bases ?? []).filter((b) => atLeast(b.role, "creator"))} />
              )}
            </T.Content>
          </T.Root>
        ) : (
          invite
        ))}
    </Dialog>
  );
}

/** "Share a view" from the workspace: the views of every base the person may share, named after their base. */
function WorkspaceViews({ bases }: { bases: readonly Pick<BaseSummary, "id" | "name" | "role">[] }) {
  // The base page's own schema queries: whatever was opened before is already here.
  const schemas = useQueries({ queries: bases.map((b) => ({ queryKey: keys.base(b.id), queryFn: () => api.bases.get(b.id) })) });
  if (schemas.some((s) => s.isPending)) return <Spinner label="Loading the views" />;
  const failed = schemas.find((s) => s.isError);
  if (failed && schemas.every((s) => !s.data)) return <Notice tone="error">{errorMessage(failed.error)}</Notice>;

  const views: View[] = [];
  const labels = new Map<string, string>();
  for (const s of schemas) {
    const schema = s.data;
    if (!schema) continue;
    for (const table of schema.tables) {
      for (const view of table.views) {
        if (!canShareView(schema.role, view)) continue;
        views.push(view);
        // The table is named only when it is not the base's namesake: "Chores › All chores", "Chores › Shopping list › Grid".
        labels.set(view.id, [schema.name, ...(table.name === schema.name ? [] : [table.name]), view.name].join(" › "));
      }
    }
  }
  return <ShareViewTab views={views} label={(v) => labels.get(v.id) ?? v.name} emptyText="None of these bases has a view that can be shared yet. Personal views stay private." />;
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
  const bases: readonly Pick<BaseSummary, "id" | "name" | "color" | "icon">[] =
    workspaces.data?.find((w) => w.id === workspaceId)?.bases ?? (fromBase ? [{ id: target.base.id, name: target.base.name, color: target.base.color ?? "", icon: target.base.icon }] : []);

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
      // The pending face shows on every base the invite gives, not just the one open here.
      void qc.invalidateQueries({ queryKey: keys.allBases });
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
    <form onSubmit={submit} className="flex flex-col gap-[18px]" aria-label="Invite people">
      <p className="text-sm leading-normal text-muted">
        People you invite join the <strong className="font-semibold text-fg">{workspaceName}</strong> workspace. Choose which of its bases they can open.
      </p>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1fr)_150px]">
        <Field label="Email" hint="Leave it empty to get a link anyone can use." className={FIELD}>
          {(ctl) => <Input {...ctl} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" className={CONTROL} />}
        </Field>
        <Field label="Role" hint={ROLE_DESCRIPTIONS[role]} className={FIELD}>
          {(ctl) => (
            <Select {...ctl} value={role} onChange={(e) => setRole(e.target.value as Role)} className={CONTROL}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <fieldset disabled={role === "owner"} className="flex flex-col gap-1.5 disabled:opacity-70">
        <legend className="mb-2 text-sm font-semibold">Bases they can open</legend>
        {role === "owner" ? (
          <p className="text-sm text-muted">Owners can always open every base in {workspaceName}.</p>
        ) : (
          <>
            <Choice type="radio" name="share-access" checked={mode === "pick"} onChange={() => setMode("pick")}>
              Only the bases I pick
            </Choice>
            {mode === "pick" && (
              <div className="ml-[42px] flex flex-col gap-0.5" role="group" aria-label="Bases">
                {bases.length === 0 ? (
                  <p className="px-2.5 py-2 text-sm text-muted">This workspace has no bases yet.</p>
                ) : (
                  bases.map((b) => (
                    <Choice key={b.id} type="checkbox" small checked={picked.has(b.id)} onChange={(on) => toggle(b.id, on)} icon={<EntityTile name={b.name} icon={b.icon} color={b.color} variant="tint" size="sm" className="rounded-md" />}>
                      {b.name}
                    </Choice>
                  ))
                )}
                {bases.length > 0 && pickedIds.length === 0 && <p className="px-2.5 text-xs text-danger">Pick at least one base.</p>}
              </div>
            )}
            {isOwner && (
              <Choice type="radio" name="share-access" checked={mode === "all"} onChange={() => setMode("all")} hint="Including bases made later">
                All bases in {workspaceName}
              </Choice>
            )}
          </>
        )}
      </fieldset>

      {send.isError && <Notice tone="error">{errorMessage(send.error)}</Notice>}
      {created && <InviteLinkResult created={created} emailEnabled={emailEnabled} />}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <Link to={`/workspace/${workspaceId}/members`} onClick={onNavigate} className="text-sm">
          Manage all members
        </Link>
        <Button type="submit" variant="primary" size="lg" className="h-11 rounded-[10px] px-5 font-semibold" loading={send.isPending} disabled={!everything && pickedIds.length === 0}>
          Send invite
        </Button>
      </div>
    </form>
  );
}

const FIELD = "gap-1.5 [&>label]:text-sm [&>label]:font-semibold";
// 16 px text: smaller makes iOS zoom into the field on focus.
const CONTROL = "h-11 rounded-[10px] px-3 text-base";

/**
 * One choice as a whole clickable row (radio or checkbox), with an optional tile and hint. Native
 * inputs: the radios form one group by `name`, and the label covers the row for a bigger target.
 */
function Choice({
  type,
  name,
  checked,
  onChange,
  hint,
  icon,
  small,
  children,
}: {
  type: "radio" | "checkbox";
  name?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  icon?: ReactNode;
  small?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn("flex cursor-pointer items-center gap-3 rounded-[10px] hover:bg-bg has-[:disabled]:cursor-default", small ? "px-2.5 py-2" : "px-3 py-2.5")}>
      <input
        id={id}
        type={type}
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        // Named by the text alone: the hint is its description, not part of its name.
        aria-labelledby={`${id}-text`}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="m-0 size-[18px] shrink-0 accent-[var(--primary)]"
      />
      {icon}
      <span className="flex min-w-0 flex-col">
        <span id={`${id}-text`} className={small ? "truncate text-sm" : "text-[0.9375rem]"}>
          {children}
        </span>
        {hint && (
          <span id={`${id}-hint`} className="text-[0.8125rem] text-muted">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}
