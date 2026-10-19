/**
 * The pickers the global pages (Trash, History) filter by: workspace, and project (the projects of
 * the chosen workspace, or all of them under their workspace's name). Both sit in the page's URL.
 */
import { useMemo } from "react";
import { ChevronDown } from "lucide-react";
import type { WorkspaceSummary } from "@/api/types";
import { EntityTile, WorkspaceTile } from "@/components/icons/EntityIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";

export const FILTER_BUTTON = "inline-flex h-9 min-w-0 max-w-full items-center gap-1.5 rounded-[9px] border border-line-strong px-3 text-sm text-fg transition-colors hover:bg-hover pointer-coarse:h-10";

export function FilterButton({ label, active, value }: { label: string; active: boolean; value: string }) {
  return (
    <DropdownMenuTrigger aria-label={`${label}: ${value}`} className={cn(FILTER_BUTTON, active ? "bg-primary-soft" : "bg-surface")}>
      <span className="truncate">{value}</span>
      <ChevronDown aria-hidden className="size-3.5 shrink-0" />
    </DropdownMenuTrigger>
  );
}

export function WorkspaceFilter({ workspaces, value, onChange }: { workspaces: WorkspaceSummary[]; value: string | null; onChange: (id: string | null) => void }) {
  const current = workspaces.find((w) => w.id === value);
  return (
    <DropdownMenu>
      <FilterButton label="Workspace" active={!!value} value={current?.name ?? (value ? "This workspace" : "All workspaces")} />
      <DropdownMenuContent align="start" className="max-h-[min(24rem,var(--ob-avail))] overflow-y-auto">
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(v) => onChange(v || null)}>
          <DropdownMenuRadioItem value="">All workspaces</DropdownMenuRadioItem>
          {workspaces.map((w) => (
            <DropdownMenuRadioItem key={w.id} value={w.id}>
              <WorkspaceTile ws={w} size="xs" />
              <span className="truncate">{w.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The bases of the chosen workspace; with every workspace, all bases under their workspace's name. */
export function BaseFilter({
  workspaces,
  workspaceId,
  value,
  fallbackName,
  onChange,
}: {
  workspaces: WorkspaceSummary[];
  workspaceId: string | null;
  value: string | null;
  fallbackName?: string | null;
  onChange: (baseId: string | null, workspaceId: string | null) => void;
}) {
  const shown = workspaceId ? workspaces.filter((w) => w.id === workspaceId) : workspaces;
  const all = useMemo(() => workspaces.flatMap((w) => w.bases), [workspaces]);
  const current = all.find((b) => b.id === value);
  return (
    <DropdownMenu>
      <FilterButton label="Project" active={!!value} value={current?.name ?? (value ? (fallbackName ?? "This project") : "All projects")} />
      <DropdownMenuContent align="start" className="max-h-[min(24rem,var(--ob-avail))] overflow-y-auto">
        <DropdownMenuRadioGroup
          value={value ?? ""}
          onValueChange={(v) => onChange(v || null, all.find((b) => b.id === v)?.workspace_id ?? null)}
        >
          <DropdownMenuRadioItem value="">All projects</DropdownMenuRadioItem>
          {shown.map((w) => (
            <div key={w.id} role="none">
              {!workspaceId && w.bases.length > 0 && <DropdownMenuLabel>{w.name}</DropdownMenuLabel>}
              {w.bases.map((b) => (
                <DropdownMenuRadioItem key={b.id} value={b.id}>
                  <EntityTile name={b.name} icon={b.icon} color={b.color} size="xs" />
                  <span className="truncate">{b.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </div>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
