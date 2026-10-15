/**
 * List view: a collapsible outline of the view's records, grouped by the view's groups (up to
 * three levels, from `QueryResponse.groups`), with compact rows and an add button per group.
 */
import { useMemo } from "react";
import { ChevronsDownUp } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cardFields, itemsLabel } from "../common/cardFields";
import { usePersistedSet } from "../common/usePersistedSet";
import { useViewRecords } from "../common/useViewRecords";
import { useViewSetup } from "../common/useViewSetup";
import { ViewFrame } from "../common/ViewFrame";
import type { ViewProps } from "../types";
import { ListOutline } from "./ListOutline";
import { allPaths, buildOutline } from "./outline";

export default function ListView(props: ViewProps) {
  return <ListInner key={props.view.id} {...props} />;
}

function ListInner(props: ViewProps) {
  const setup = useViewSetup(props);
  const { table, view, config, cfg, writes } = setup;
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  // A group header already says the value of the field it groups by.
  const fields = useMemo(() => cardFields(table, config, new Set(config.groups.map((g) => g.field_id))), [table, config]);
  const [collapsed, toggle, replace] = usePersistedSet(`ob-list-collapsed:${view.id}`);

  const records = useViewRecords({ tableId: table.id, viewId: view.id, configKey: setup.configKey, search: setup.debouncedSearch, timeZone: setup.timeZone, transient: setup.transient });
  const data = records.data;
  const grouped = !!data && data.groups.length > 0;
  const paths = useMemo(() => (data ? allPaths(buildOutline(data.groups)) : []), [data]);

  const add = async (defaults: Record<string, unknown>) => {
    const rec = await writes.create(defaults);
    if (rec) setup.openRecord(rec.id);
  };

  const total = data?.total ?? 0;
  const allFolded = paths.length > 0 && paths.every((path) => collapsed.has(path));

  let body: React.ReactNode;
  if (records.loading) {
    body = (
      <div className="flex justify-center pt-16">
        <Spinner className="size-5" label="Loading records" />
      </div>
    );
  } else if (records.error && !data) {
    body = (
      <p role="alert" className="pt-16 text-center text-[0.8125rem] text-muted">
        Could not load records: {records.error.message}
      </p>
    );
  } else if (data) {
    body = (
      <>
        <ListOutline
          records={data.records}
          groups={data.groups}
          primary={primary}
          fields={fields}
          tableFields={table.fields}
          format={setup.format}
          emails={setup.emails}
          colors={data.colors}
          collapsed={collapsed}
          canEdit={setup.canEdit}
          onToggle={toggle}
          onOpen={setup.openRecord}
          onAdd={(defaults) => void add(defaults)}
        />
        {data.records.length === 0 && <p className="pt-10 text-center text-[0.8125rem] text-muted">{setup.debouncedSearch ? "No records match your search." : "No records yet."}</p>}
      </>
    );
  }

  return (
    <ViewFrame
      setup={setup}
      recordIds={data?.records.map((r) => r.id)}
      layout="hug"
      features={{ rowHeight: false }}
      moreToggles={
        grouped
          ? [{ id: "fold-all", label: "Fold all groups", icon: <ChevronsDownUp aria-hidden />, checked: allFolded, onToggle: (on) => replace(on ? paths : []) }]
          : undefined
      }
      onAdd={setup.canEdit ? () => void add({}) : undefined}
      footer={
        <>
          <span aria-live="polite">
            {itemsLabel(total)}
            {setup.debouncedSearch ? " found" : ""}
          </span>
          {data?.truncated && <span role="status">Showing the first {data.records.length.toLocaleString()} of {total.toLocaleString()} records. Filter the view to see the rest.</span>}
          {cfg.saving && <span className="ml-auto text-xs">Saving view…</span>}
        </>
      }
    >
      <div className="min-h-0 overflow-y-auto max-md:flex-1">{body}</div>
    </ViewFrame>
  );
}
