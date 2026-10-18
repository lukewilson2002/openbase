/**
 * "Save to…": pick a project, then one of its tables. A dialog in two steps (the list of projects,
 * then the project's tables) rather than a nested menu, so it is as easy with a thumb as with a
 * mouse and fits a 375 px screen. Only projects where the person can add records are offered.
 */
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { BaseSummary, WorkspaceSummary } from "@/api/types";
import { EntityLabel, EntityTile, WorkspaceTile } from "@/components/icons/EntityIcon";
import { Dialog } from "@/components/ui/dialog";
import { captureTargets, type TargetRef } from "./targets";

export interface TargetPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: readonly WorkspaceSummary[];
  onPick: (target: TargetRef) => void;
}

const rowClass = "flex min-h-11 w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[0.9375rem] hover:bg-hover focus-visible:bg-hover";

export function TargetPicker({ open, onOpenChange, workspaces, onPick }: TargetPickerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Save to…" description="Choose a project, then a table. What you wrote becomes a new record there." size="sm">
      {/* Fresh each time the dialog opens: it always starts at the projects. */}
      {open && <Steps workspaces={workspaces} onPick={onPick} />}
    </Dialog>
  );
}

function Steps({ workspaces, onPick }: Pick<TargetPickerProps, "workspaces" | "onPick">) {
  const groups = captureTargets(workspaces);
  const all = groups.flatMap((g) => g.projects);
  // With a single project there is nothing to choose between: go straight to its tables.
  const only = all.length === 1 ? all[0]! : null;
  const [project, setProject] = useState<BaseSummary | null>(only);

  if (all.length === 0) {
    return <p className="py-4 text-center text-[0.875rem] text-muted">You cannot add records to any project yet. Ask for the Editor role on one, or make a project of your own.</p>;
  }

  if (project) {
    return (
      <div className="flex flex-col gap-1">
        {!only && (
          <button type="button" onClick={() => setProject(null)} className="-ml-1 mb-1 flex h-9 items-center gap-1 self-start rounded-[10px] px-1.5 text-[0.875rem] text-muted hover:bg-hover hover:text-fg pointer-coarse:h-11">
            <ChevronLeft aria-hidden className="size-4" /> All projects
          </button>
        )}
        <h3 className="flex items-center gap-2 px-1 pb-1 text-[0.8125rem] font-semibold text-muted">
          <EntityTile name={project.name} icon={project.icon} color={project.color} size="sm" />
          <span className="min-w-0 truncate">{project.name}</span>
        </h3>
        <ul aria-label={`Tables in ${project.name}`} className="flex flex-col">
          {project.tables.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => onPick({ baseId: project.id, tableId: t.id })} className={rowClass}>
                <EntityLabel icon={t.icon} className="flex-1 text-fg" iconClassName="text-muted">
                  {t.name}
                </EntityLabel>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {groups.map(({ workspace, projects }) => (
        <section key={workspace.id} aria-label={workspace.name} className="flex flex-col gap-0.5">
          <h3 className="flex items-center gap-2 px-1 pb-0.5 text-[0.8125rem] font-semibold text-muted">
            <WorkspaceTile ws={workspace} size="sm" className="size-5 rounded-md text-[0.6875rem]" />
            <span className="min-w-0 truncate">{workspace.name}</span>
          </h3>
          <ul aria-label={`Projects in ${workspace.name}`} className="flex flex-col">
            {projects.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => setProject(p)} className={rowClass}>
                  <EntityTile name={p.name} icon={p.icon} color={p.color} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-faint" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
