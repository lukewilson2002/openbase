import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Ellipsis, Lock, LockOpen, Pencil, Share2, Trash2, User as UserIcon } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table, View, ViewType } from "@/api/types";
import { NameDialog } from "@/components/NameDialog";
import { EntityIcon } from "@/components/icons/EntityIcon";
import { ShareViewDialog } from "@/components/share/LazyShareViewDialog";
import { canShareView } from "@/components/share/shareView";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { VIEW_TYPES, VIEW_TYPE_META } from "@/views/meta";
import { basePermissions } from "./permissions";

type ViewDialog = { kind: "create"; type: ViewType } | { kind: "rename"; view: View } | { kind: "delete"; view: View };

export interface ViewSidebarProps {
  schema: BaseSchema;
  table: Table;
  activeViewId: string | undefined;
  open: boolean;
  onNavigate?: () => void;
}

export function ViewSidebar({ schema, table, activeViewId, open, onNavigate }: ViewSidebarProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const role = schema.role;
  const [dialog, setDialog] = useState<ViewDialog | null>(null);
  const [personal, setPersonal] = useState(false);
  const [sharingView, setSharingView] = useState<View | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.base(schema.id) });
  const viewHref = (v: View) => `/base/${schema.id}/${table.id}/${v.id}`;

  const create = useMutation({
    mutationFn: (v: { name: string; type: ViewType; personal: boolean }) => api.views.create(table.id, { name: v.name, type: v.type, personal: v.personal, config: null }),
    onSuccess: async (view) => {
      await refresh();
      navigate(viewHref(view));
      onNavigate?.();
    },
  });
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => api.views.update(v.id, { name: v.name }), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: (id: string) => api.views.remove(id),
    onSuccess: async (_r, id) => {
      await refresh();
      if (id === activeViewId) navigate(`/base/${schema.id}/${table.id}`, { replace: true });
    },
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => api.views.duplicate(id),
    onSuccess: async (view) => {
      await refresh();
      if (view?.id) navigate(viewHref(view));
    },
    onError: (e) => toast.error(e, "Could not duplicate view"),
  });
  const toggleLock = useMutation({
    mutationFn: (v: View) => api.views.update(v.id, { locked: !v.locked }),
    onSuccess: refresh,
    onError: (e) => toast.error(e, "Could not change the lock"),
  });

  const shared = table.views.filter((v) => !v.personal);
  const mine = table.views.filter((v) => v.personal);
  const canCreate = basePermissions.createView(role);
  const canCreateShared = basePermissions.createSharedView(role);

  const renderView = (v: View) => {
    const active = v.id === activeViewId;
    const Icon = VIEW_TYPE_META[v.type].icon;
    const canConfigure = basePermissions.configureView(role, v);
    const canLock = basePermissions.lockView(role, v);
    return (
      <li key={v.id} className="group/item relative">
        <Link
          to={viewHref(v)}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex h-8 items-center gap-2 rounded-md px-2 pr-8 text-[0.8125rem] text-fg no-underline",
            active ? "bg-primary-soft font-medium" : "hover:bg-hover",
          )}
        >
          <Icon aria-hidden className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">{v.name}</span>
          {v.personal && <UserIcon aria-label="Personal view" role="img" className="size-3.5 shrink-0 text-muted" />}
          {v.locked && <Lock aria-label="Locked view" role="img" className="size-3.5 shrink-0 text-muted" />}
        </Link>
        {(canConfigure || canLock) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={`Options for ${v.name}`} size="sm" noTooltip className="absolute right-0.5 top-0.5 size-7 opacity-100 md:opacity-0 md:focus-visible:opacity-100 md:group-hover/item:opacity-100 data-[state=open]:opacity-100">
                <Ellipsis aria-hidden className="size-4" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {canConfigure && (
                <>
                  <DropdownMenuItem onSelect={() => setDialog({ kind: "rename", view: v })}>
                    <Pencil aria-hidden className="size-4" /> Rename view
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => duplicate.mutate(v.id)}>
                    <Copy aria-hidden className="size-4" /> Duplicate view
                  </DropdownMenuItem>
                </>
              )}
              {canShareView(role, v) && (
                <DropdownMenuItem onSelect={() => setSharingView(v)}>
                  <Share2 aria-hidden className="size-4" /> Share view…
                </DropdownMenuItem>
              )}
              {canLock && (
                <DropdownMenuItem onSelect={() => toggleLock.mutate(v)}>
                  {v.locked ? <LockOpen aria-hidden className="size-4" /> : <Lock aria-hidden className="size-4" />}
                  {v.locked ? "Unlock view" : "Lock view"}
                </DropdownMenuItem>
              )}
              {canConfigure && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger disabled={table.views.length <= 1} onSelect={() => setDialog({ kind: "delete", view: v })}>
                    <Trash2 aria-hidden className="size-4" /> Delete view
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </li>
    );
  };

  const creating = dialog?.kind === "create" ? dialog.type : null;
  return (
    <aside
      aria-label="Views"
      className={cn(
        "w-64 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface p-2",
        open ? "absolute inset-y-0 left-0 z-40 flex shadow-pop md:static md:shadow-none" : "hidden md:flex",
      )}
    >
      <div className="flex items-center gap-1.5 px-2 pb-1 pt-1 text-xs font-medium uppercase tracking-wide text-muted">
        {table.icon && <EntityIcon name={table.icon} className="size-3.5" />}
        <span className="min-w-0 truncate">{table.name}</span>
      </div>
      <ul className="flex flex-col gap-0.5" aria-label="Shared views">
        {shared.map(renderView)}
      </ul>
      {mine.length > 0 && (
        <>
          <div className="mt-3 px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted">Personal</div>
          <ul className="flex flex-col gap-0.5" aria-label="Personal views">
            {mine.map(renderView)}
          </ul>
        </>
      )}
      {canCreate && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted">Create view</div>
          {!canCreateShared && <p className="px-2 pb-1 text-xs text-muted">Editors can create personal views.</p>}
          <ul className="flex flex-col gap-0.5">
            {VIEW_TYPES.map((type) => {
              const meta = VIEW_TYPE_META[type];
              return (
                <li key={type}>
                  <button
                    type="button"
                    onClick={() => {
                      setPersonal(!canCreateShared);
                      setDialog({ kind: "create", type });
                    }}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[0.8125rem] text-muted hover:bg-hover hover:text-fg"
                  >
                    <meta.icon aria-hidden className="size-4 shrink-0" />
                    <span>{meta.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {sharingView && <ShareViewDialog open onOpenChange={(o) => !o && setSharingView(null)} view={table.views.find((x) => x.id === sharingView.id) ?? sharingView} table={table} />}
      <NameDialog
        open={!!creating}
        onOpenChange={(o) => !o && setDialog(null)}
        title={creating ? `New ${VIEW_TYPE_META[creating].label.toLowerCase()} view` : "New view"}
        initialValue={creating ? VIEW_TYPE_META[creating].defaultName : ""}
        submitLabel="Create view"
        extra={
          canCreateShared ? (
            <Checkbox checked={personal} onCheckedChange={setPersonal} label="Personal view (only visible to me)" />
          ) : (
            <p className="text-[0.8125rem] text-muted">This view will be personal: only you can see it.</p>
          )
        }
        onSubmit={(name) => (creating ? create.mutateAsync({ name, type: creating, personal: canCreateShared ? personal : true }) : undefined)}
      />
      <NameDialog
        open={dialog?.kind === "rename"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Rename view"
        initialValue={dialog?.kind === "rename" ? dialog.view.name : ""}
        onSubmit={(name) => (dialog?.kind === "rename" ? rename.mutateAsync({ id: dialog.view.id, name }) : undefined)}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Delete ${dialog?.kind === "delete" ? dialog.view.name : "view"}?`}
        description="Records are not affected; only this view is removed."
        confirmLabel="Delete view"
        destructive
        onConfirm={() => (dialog?.kind === "delete" ? remove.mutateAsync(dialog.view.id) : undefined)}
      />
    </aside>
  );
}
