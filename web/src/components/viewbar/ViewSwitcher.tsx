/**
 * `[icon] Chores / All chores ⌄` at the start of the view toolbar: which table and view are open,
 * and a picker for both (tables on the left, the pointed-at table's views on the right), with
 * "New table" and "Add view" for those who may.
 */
import { ChevronDown, Lock, Plus, Table2, User as UserIcon } from "lucide-react";
import type { BaseSchema, Table, View } from "@/api/types";
import { useBaseDialog } from "@/base/BaseDialogs";
import { basePermissions } from "@/base/permissions";
import { EntityIcon } from "@/components/icons/EntityIcon";
import { DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { SplitMenu } from "@/components/ui/split-menu";
import { cn } from "@/lib/cn";
import { VIEW_TYPES, VIEW_TYPE_META } from "@/views/meta";
import { DropdownMenu as M } from "radix-ui";

export function ViewSwitcher({ schema, table, view, className }: { schema: BaseSchema; table: Table; view: View; className?: string }) {
  const openDialog = useBaseDialog();
  const Icon = VIEW_TYPE_META[view.type]?.icon ?? Table2;
  const canCreateTable = !!openDialog && basePermissions.manageTables(schema.role);
  const canCreateView = !!openDialog && basePermissions.createView(schema.role);
  const tables = schema.tables.some((t) => t.id === table.id) ? schema.tables : [table, ...schema.tables];

  return (
    <h2 className={cn("-ml-2 min-w-0 text-[0.9375rem]", className)}>
      <SplitMenu
        label="Pick a table, then a view"
        groupsHeading="Tables"
        groups={tables.map((t) => ({ id: t.id, label: t.name, icon: t.icon ? <EntityIcon name={t.icon} /> : <Table2 aria-hidden className="text-muted" /> }))}
        currentGroupId={table.id}
        groupAction={canCreateTable ? { label: "New table", icon: <Plus aria-hidden />, onSelect: () => openDialog({ kind: "create-table" }) } : undefined}
        itemsHeading={(g) => `Views of ${g.label}`}
        itemsFor={(id) =>
          (tables.find((t) => t.id === id)?.views ?? []).map((v) => {
            const ViewIcon = VIEW_TYPE_META[v.type]?.icon ?? Table2;
            return {
              id: v.id,
              label: v.name,
              icon: <ViewIcon aria-hidden />,
              to: `/base/${schema.id}/${id}/${v.id}`,
              current: v.id === view.id,
              after: (
                <>
                  {v.personal && <UserIcon aria-label="Personal view" role="img" className="size-3.5 shrink-0 text-muted" />}
                  {v.locked && <Lock aria-label="Locked view" role="img" className="size-3.5 shrink-0 text-muted" />}
                </>
              ),
            };
          })
        }
        itemAction={(g) => {
          const target = tables.find((t) => t.id === g.id);
          if (!canCreateView || !target || !openDialog) return null;
          return {
            label: "Add view",
            icon: <Plus aria-hidden />,
            sub: (
              <>
                {!basePermissions.createSharedView(schema.role) && <DropdownMenuLabel>Editors can create personal views.</DropdownMenuLabel>}
                {VIEW_TYPES.map((type) => {
                  const meta = VIEW_TYPE_META[type];
                  return (
                    <M.Item
                      key={type}
                      onSelect={() => openDialog({ kind: "create-view", table: target, type })}
                      className="flex cursor-default select-none items-start gap-2.5 rounded-lg px-2.5 py-2 text-[0.8125rem] outline-none data-[highlighted]:bg-hover"
                    >
                      <meta.icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                      <span className="min-w-0">
                        <span className="block font-medium">{meta.label}</span>
                        <span className="block text-xs text-muted">{meta.description}</span>
                      </span>
                    </M.Item>
                  );
                })}
              </>
            ),
          };
        }}
        trigger={
          <button
            type="button"
            aria-label={`Showing the ${table.name} table, ${view.name} view. Switch table or view`}
            className="flex h-9 max-w-full items-center gap-2 rounded-[9px] px-2 text-fg transition-colors hover:bg-hover data-[state=open]:bg-hover pointer-coarse:h-11"
          >
            <Icon aria-hidden className="size-4 shrink-0 text-muted" />
            <span className="min-w-0 truncate">
              <span className="font-medium text-muted">{table.name}</span>
              <span aria-hidden className="mx-1 text-lg font-normal leading-none text-line-strong">
                /
              </span>
              <span className="font-bold">{view.name}</span>
            </span>
            <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted" />
          </button>
        }
      />
    </h2>
  );
}
