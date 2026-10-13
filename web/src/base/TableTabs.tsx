import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Copy, PanelLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table } from "@/api/types";
import { NameDialog } from "@/components/NameDialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { basePermissions } from "./permissions";

export interface TableTabsProps {
  schema: BaseSchema;
  activeTableId: string | undefined;
  /** Omitted on pages without a view sidebar (automations). */
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
}

type TableDialog = { kind: "create" } | { kind: "rename"; table: Table } | { kind: "delete"; table: Table };

export function TableTabs({ schema, activeTableId, onToggleSidebar, sidebarOpen = false }: TableTabsProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [dialog, setDialog] = useState<TableDialog | null>(null);
  const canManage = basePermissions.manageTables(schema.role);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.base(schema.id) });

  const create = useMutation({
    mutationFn: (name: string) => api.tables.create(schema.id, name),
    onSuccess: async (table) => {
      await refresh();
      const view = table.views?.[0];
      navigate(`/base/${schema.id}/${table.id}${view ? `/${view.id}` : ""}`);
    },
  });
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => api.tables.update(v.id, { name: v.name }), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: (id: string) => api.tables.remove(id),
    onSuccess: async (_res, id) => {
      await refresh();
      if (id === activeTableId) navigate(`/base/${schema.id}`, { replace: true });
    },
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => api.tables.duplicate(id),
    onSuccess: async (table) => {
      await refresh();
      if (table?.id) navigate(`/base/${schema.id}/${table.id}`);
    },
    onError: (e) => toast.error(e, "Could not duplicate table"),
  });

  return (
    <nav aria-label="Tables" className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-subtle px-2">
      {onToggleSidebar && (
        <IconButton label={sidebarOpen ? "Hide views" : "Show views"} size="sm" onClick={onToggleSidebar} className="md:hidden" aria-expanded={sidebarOpen}>
          <PanelLeft aria-hidden className="size-4" />
        </IconButton>
      )}
      <ul className="flex min-w-0 flex-1 items-end gap-0.5 self-end overflow-x-auto [scrollbar-width:none]">
        {schema.tables.map((t) => {
          const active = t.id === activeTableId;
          return (
            <li key={t.id} className="shrink-0">
              <div
                className={cn(
                  "flex h-8 items-center rounded-t-md border border-b-0 text-[0.8125rem]",
                  active ? "border-line bg-surface font-medium" : "border-transparent text-muted hover:bg-hover hover:text-fg",
                )}
              >
                <Link to={`/base/${schema.id}/${t.id}`} aria-current={active ? "page" : undefined} className="flex h-full max-w-48 items-center truncate px-3 text-inherit no-underline">
                  {t.name}
                </Link>
                {active && canManage && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconButton label={`Table options for ${t.name}`} size="sm" noTooltip className="-ml-1.5 mr-0.5 size-6">
                        <ChevronDown aria-hidden className="size-3.5" />
                      </IconButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onSelect={() => setDialog({ kind: "rename", table: t })}>
                        <Pencil aria-hidden className="size-4" /> Rename table
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => duplicate.mutate(t.id)}>
                        <Copy aria-hidden className="size-4" /> Duplicate table
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem danger disabled={schema.tables.length <= 1} onSelect={() => setDialog({ kind: "delete", table: t })}>
                        <Trash2 aria-hidden className="size-4" /> Delete table
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {canManage && (
        <IconButton label="Add table" size="sm" onClick={() => setDialog({ kind: "create" })}>
          <Plus aria-hidden className="size-4" />
        </IconButton>
      )}

      <NameDialog
        open={dialog?.kind === "create"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="New table"
        submitLabel="Create table"
        onSubmit={(name) => create.mutateAsync(name)}
      />
      <NameDialog
        open={dialog?.kind === "rename"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Rename table"
        initialValue={dialog?.kind === "rename" ? dialog.table.name : ""}
        onSubmit={(name) => (dialog?.kind === "rename" ? rename.mutateAsync({ id: dialog.table.id, name }) : undefined)}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Delete ${dialog?.kind === "delete" ? dialog.table.name : "table"}?`}
        description="The table and its records move to the trash and can be restored for 30 days."
        confirmLabel="Delete table"
        destructive
        onConfirm={() => (dialog?.kind === "delete" ? remove.mutateAsync(dialog.table.id) : undefined)}
      />
    </nav>
  );
}
