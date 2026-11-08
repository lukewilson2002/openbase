/**
 * The TemporaryChangesBar of a view, wired to its draft (COL-5): "Showing 3 of 12 clients. These changes
 * are only for now." with Reset, Update view and Save as view, each for the people who have it, and "This
 * view changed since you started." when the view was saved by someone else meanwhile. It stays mounted
 * and closed without a draft, so the change is announced. Save as view opens the dialog that names it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { BaseSchema, Table, View } from "@/api/types";
import { useToast } from "@/components/ui/toast";
import { useFocusRescue } from "@/hooks/useFocusRescue";
import { TemporaryChangesBar } from "@/components/ui/temporary-changes-bar";
import { recordNounFor } from "@/lib/recordNoun";
import { suggestViewName } from "@/views/drafts/name";
import { useDraftCounts } from "@/views/drafts/useDraftCounts";
import type { ViewConfigApi } from "@/views/grid/useViewConfig";
import { filterInput } from "./filterInput";
import { SaveAsViewDialog } from "./SaveAsViewDialog";

export interface DraftBarProps {
  schema: BaseSchema;
  table: Table;
  view: View;
  cfg: ViewConfigApi;
  /** The search text in use (after the typing pause): it narrows the count the draft shows. */
  search: string;
  timeZone: string;
}

export function DraftBar({ schema, table, view, cfg, search, timeZone }: DraftBarProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const [naming, setNaming] = useState(false);
  const open = cfg.draft !== null;
  const counts = useDraftCounts({ tableId: table.id, view, cfg, search, timeZone });
  const name = useMemo(() => suggestViewName({ config: cfg.config, fields: table.fields, layout: cfg.layout, savedLayout: view.type, viewName: view.is_default ? `All ${table.name.toLowerCase()}` : view.name }), [cfg.config, cfg.layout, table.fields, table.name, view]);

  // Reset and Update view take their buttons with them when the bar closes: focus goes up to the filter bar.
  const root = useRef<HTMLDivElement>(null);
  const rescue = useFocusRescue(root, (host) => filterInput() ?? host.querySelector<HTMLElement>("input, button, [href]"));
  useEffect(() => {
    if (!open) rescue();
  }, [open, rescue]);

  return (
    <>
      <div ref={root} className={open ? "px-3 pt-2 md:px-4" : undefined}>
        <TemporaryChangesBar
          open={open}
          shown={counts?.shown}
          total={counts?.total}
          noun={counts ? recordNounFor(table, counts.total) : undefined}
          note="These changes are only for now."
          alert={cfg.changedOnServer ? "This view changed since you started." : undefined}
          onReset={cfg.reset}
          onUpdateView={cfg.actions.canUpdate ? () => void cfg.updateView() : undefined}
          updating={cfg.saving}
          onSaveAsView={cfg.actions.canSaveAsView ? () => setNaming(true) : undefined}
        />
      </div>
      {cfg.actions.canSaveAsView && (
        <SaveAsViewDialog
          open={naming && open}
          onOpenChange={setNaming}
          initialName={name}
          canShareWithEveryone={cfg.actions.canSaveForEveryone}
          onSave={async (input) => {
            const created = await cfg.saveAsView(input);
            toast.toast({ title: `Saved as “${created.name}”`, variant: "success" });
            void navigate(`/base/${schema.id}/${table.id}/${created.id}`);
          }}
        />
      )}
    </>
  );
}
