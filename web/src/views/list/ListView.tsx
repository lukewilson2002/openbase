/**
 * List view: a collapsible outline of the view's records, grouped by the view's groups (up to
 * three levels, from `QueryResponse.groups`), with compact rows and an add button per group.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronsDownUp } from "lucide-react";
import { recordKeys } from "@/api/records";
import type { MenuAnchor } from "@/components/ui/anchored-menu";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import type { ViewRecordsData } from "../common/cache";
import { cardFields, itemsLabel } from "../common/cardFields";
import { DescriptionSelect, setDescriptionField, useDescriptionField } from "../common/description";
import { EmptyRecords } from "../common/EmptyRecords";
import { RecordMenu } from "../common/RecordMenu";
import { SelectionBar } from "../common/SelectionBar";
import { usePersistedSet } from "../common/usePersistedSet";
import { useRecordSelection } from "../common/useRecordSelection";
import { useViewRecords } from "../common/useViewRecords";
import { useViewSetup } from "../common/useViewSetup";
import { ViewFrame } from "../common/ViewFrame";
import { ViewSettings } from "../common/ViewSettings";
import type { ViewProps } from "../types";
import { ListOutline } from "./ListOutline";
import { allPaths, buildOutline, leafNodes, moveBetweenGroups, placeIndexes, planDrop, visibleIds, type DropPlan } from "./outline";

export default function ListView(props: ViewProps) {
  return <ListInner key={props.view.id} {...props} />;
}

function ListInner(props: ViewProps) {
  const setup = useViewSetup(props);
  const { table, view, config, cfg, writes, actions } = setup;
  const qc = useQueryClient();
  const toast = useToast();
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const { candidates: descriptionFields, field: descriptionField } = useDescriptionField(table, config);
  // A group header already says the value of the field it groups by; the description sits under
  // the title.
  const fields = useMemo(() => cardFields(table, config, new Set([...config.groups.map((g) => g.field_id), descriptionField?.id ?? ""])), [table, config, descriptionField?.id]);
  const [collapsed, toggle, replace] = usePersistedSet(`ob-list-collapsed:${view.id}`);

  const records = useViewRecords({ tableId: table.id, viewId: view.id, configKey: setup.configKey, search: setup.debouncedSearch, timeZone: setup.timeZone, transient: setup.transient });
  const data = records.data;
  const grouped = !!data && data.groups.length > 0;
  const roots = useMemo(() => buildOutline(data?.groups ?? []), [data?.groups]);
  const paths = useMemo(() => allPaths(roots), [roots]);
  const recordIds = useMemo(() => data?.records.map((r) => r.id) ?? [], [data?.records]);

  // What can be selected, and what Previous and Next of the record panel step through: the rows on
  // screen, which leaves out the records of folded groups.
  const openId = setup.openRecordId;
  const onScreen = useMemo(() => visibleIds(recordIds, roots, collapsed), [recordIds, roots, collapsed]);
  const sel = useRecordSelection(onScreen);
  // The open record itself always counts: from a folded group, or after it stopped matching the view
  // (edited out of its filter), it keeps its place so Previous and Next still work from it.
  const lastIndex = useRef(-1);
  const panelIds = useMemo(() => {
    const seen = visibleIds(recordIds, roots, collapsed, openId);
    if (!openId || seen.includes(openId)) return seen;
    const at = Math.min(Math.max(lastIndex.current, 0), seen.length);
    return [...seen.slice(0, at), openId, ...seen.slice(at)];
  }, [recordIds, roots, collapsed, openId]);
  useEffect(() => {
    const at = openId ? panelIds.indexOf(openId) : -1;
    if (at >= 0 && recordIds.includes(openId!)) lastIndex.current = at;
  }, [openId, panelIds, recordIds]);

  const [menu, setMenu] = useState<{ id: string; anchor: MenuAnchor } | null>(null);
  // Rows can be put in a new place only where the view keeps them in manual order.
  const reorderable = setup.canEdit && cfg.queryConfig.sorts.length === 0;

  const add = async (defaults: Record<string, unknown>) => {
    await setup.addRecord(defaults);
  };

  const reorder = async (id: string, plan: DropPlan | "blocked") => {
    if (plan === "blocked") {
      toast.toast({ title: "Records cannot be moved into these groups", description: "Their group comes from a field that cannot be edited, such as a formula or a link." });
      return;
    }
    const order = placeIndexes(recordIds, id, plan);
    // The outline's counts are not what the writes patch, so the groups are updated here.
    await qc.cancelQueries({ queryKey: recordKeys.table(table.id) });
    if (order && Object.keys(plan.values).length > 0) {
      qc.setQueryData<ViewRecordsData>(records.queryKey, (old) => old && { ...old, groups: moveBetweenGroups(old.groups, order.a, order.b, plan.from, plan.to) });
    }
    await writes.updateAndMove(id, plan.values, { beforeId: plan.beforeId, afterId: plan.afterId }, { label: "Move record", toast: plan.groupLabel ? `Moved to ${plan.groupLabel}` : undefined });
  };

  const recordsOf = (ids: readonly string[]) => (data?.records ?? []).filter((r) => ids.includes(r.id));
  const duplicateIds = (ids: readonly string[]) => void actions.duplicate(recordsOf(ids), ids.length > 1 ? sel.clear : undefined);
  const menuIds = menu ? (sel.has(menu.id) ? sel.ids : [menu.id]) : [];
  // Where "Move to start" puts a row: first in its group (or in the list).
  const startOf = menu ? (leafNodes(roots).find((n) => recordIds.indexOf(menu.id) >= n.start && recordIds.indexOf(menu.id) < n.start + n.count)?.start ?? 0) : 0;
  const startId = recordIds[startOf];
  const moveToStart = () => {
    if (!menu || !startId) return;
    const plan = planDrop(recordIds, roots, menu.id, { kind: "row", id: startId }, () => true);
    if (plan) void reorder(menu.id, plan);
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
  } else if (data && data.records.length === 0) {
    // One roomy message instead of the outline: its own "No records" row plus a message under it
    // read as the same thing said twice, squeezed against the card's edge.
    body = <EmptyRecords searching={!!setup.debouncedSearch} onAdd={setup.canEdit ? () => void add({}) : undefined} />;
  } else if (data) {
    body = (
      <ListOutline
        records={data.records}
        groups={data.groups}
        primary={primary}
        fields={fields}
        descriptionField={descriptionField}
        tableFields={table.fields}
        format={setup.format}
        emails={setup.emails}
        colors={data.colors}
        collapsed={collapsed}
        canEdit={setup.canEdit}
        onToggle={toggle}
        onOpen={setup.openRecord}
        onAdd={(defaults) => void add(defaults)}
        selection={sel}
        onDelete={(ids) => actions.requestDelete(ids, sel.clear)}
        onRecordMenu={(id, anchor) => setMenu({ id, anchor })}
        onReorder={reorderable ? reorder : undefined}
        reveal={openId}
      />
    );
  }

  return (
    <ViewFrame
      setup={setup}
      recordIds={panelIds}
      layout="hug"
      features={{ rowHeight: false }}
      toolbarSetting={
        <ViewSettings note={cfg.canConfigure ? undefined : "You do not have permission to change this view."}>
          <DescriptionSelect candidates={descriptionFields} field={descriptionField} disabled={!cfg.canConfigure} onChange={(id) => cfg.update((c) => setDescriptionField(c, id))} />
        </ViewSettings>
      }
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
      {sel.count > 0 && <SelectionBar count={sel.count} onDuplicate={() => duplicateIds(sel.ids)} onDelete={() => actions.requestDelete(sel.ids, sel.clear)} onClear={sel.clear} />}
      <RecordMenu
        anchor={menu?.anchor ?? null}
        onClose={() => setMenu(null)}
        count={menuIds.length}
        canEdit={setup.canEdit}
        selected={!!menu && sel.has(menu.id)}
        onOpen={() => menu && setup.openRecord(menu.id)}
        onToggleSelect={() => menu && sel.toggle(menu.id)}
        onDuplicate={() => duplicateIds(menuIds)}
        onDelete={() => actions.requestDelete(menuIds, sel.clear)}
        onMoveToStart={reorderable && menu && startId && startId !== menu.id ? moveToStart : undefined}
      />
    </ViewFrame>
  );
}
