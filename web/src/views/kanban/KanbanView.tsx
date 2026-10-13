/**
 * Kanban view: cards stacked by a single select, single user or checkbox field. Records come
 * from the view query (filter, sorts, colours, search), so the toolbar behaves as in the grid;
 * drops write the stack field (and the manual order when the view has no sorts) optimistically.
 */
import { useCallback, useMemo } from "react";
import { LayoutGrid } from "lucide-react";
import type { Field, ViewConfig } from "@/api/types";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/checkbox";
import { cardFields } from "../common/cardFields";
import { usePersistedSet } from "../common/usePersistedSet";
import { useViewRecords } from "../common/useViewRecords";
import { useViewSetup } from "../common/useViewSetup";
import { FieldSelect, SetupPrompt, ViewSettings } from "../common/ViewSettings";
import { ViewFrame } from "../common/ViewFrame";
import type { ViewProps } from "../types";
import { KanbanBoard } from "./KanbanBoard";
import { buildStacks, isStackField, moveStackKey, stackValue, type DropPlan } from "./stacks";

export default function KanbanView(props: ViewProps) {
  return <KanbanInner key={props.view.id} {...props} />;
}

function setKanban(c: ViewConfig, patch: Partial<ViewConfig["kanban"]>): ViewConfig {
  return { ...c, kanban: { ...c.kanban, ...patch } };
}

function KanbanInner(props: ViewProps) {
  const setup = useViewSetup(props);
  const { table, view, config, cfg, writes } = setup;
  const kanban = config.kanban;
  const stackFields = useMemo(() => table.fields.filter(isStackField), [table.fields]);
  const stackField: Field | undefined = stackFields.find((f) => f.id === kanban.stack_field_id);
  const attachmentFields = useMemo(() => table.fields.filter((f) => f.type === "attachment"), [table.fields]);
  const coverField = attachmentFields.find((f) => f.id === kanban.cover_field_id);
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const [collapsed, toggleCollapse] = usePersistedSet(`og-kanban-collapsed:${view.id}`);

  const records = useViewRecords({
    tableId: table.id,
    viewId: view.id,
    configKey: setup.configKey,
    search: setup.debouncedSearch,
    timeZone: setup.timeZone,
    enabled: !!stackField,
  });
  const data = records.data;

  const stacks = useMemo(
    () => (stackField && data ? buildStacks(stackField, data.records, { stackOrder: kanban.stack_order, hideEmpty: kanban.hide_empty_stacks, people: setup.people }) : []),
    [stackField, data, kanban.stack_order, kanban.hide_empty_stacks, setup.people],
  );
  // The stack a card sits in already says its stack value, and the cover is drawn as the image.
  const fields = useMemo(() => cardFields(table, config, new Set([coverField?.id ?? "", stackField?.id ?? ""])), [table, config, coverField?.id, stackField?.id]);
  const recordIds = useMemo(() => stacks.flatMap((s) => s.records.map((r) => r.id)), [stacks]);
  const hasSorts = cfg.queryConfig.sorts.length > 0;

  const onDrop = useCallback(
    (plan: DropPlan) => {
      if (!stackField) return;
      void writes.updateAndMove(plan.recordId, plan.changeValue ? { [stackField.id]: stackValue(stackField, plan.toKey) } : {}, plan.anchor);
    },
    [stackField, writes],
  );

  const addCard = useCallback(
    async (key: string) => {
      if (!stackField) return;
      const value = stackValue(stackField, key);
      const rec = await writes.create(value === null ? {} : { [stackField.id]: value });
      if (rec) setup.openRecord(rec.id);
    },
    [stackField, writes, setup],
  );

  const note = cfg.canConfigure ? undefined : "You do not have permission to change this view.";
  const settings = (
    <ViewSettings label="Kanban settings" note={note}>
      <FieldSelect
        label="Stack cards by"
        fields={stackFields}
        value={stackField?.id ?? ""}
        disabled={!cfg.canConfigure}
        onChange={(id) => cfg.update((c) => setKanban(c, { stack_field_id: id, stack_order: [] }))}
        hint="A single select, single user or checkbox field."
      />
      <FieldSelect label="Cover image" fields={attachmentFields} value={coverField?.id ?? ""} noneLabel="No cover" disabled={!cfg.canConfigure} onChange={(id) => cfg.update((c) => setKanban(c, { cover_field_id: id }))} />
      <Switch label="Hide empty stacks" checked={kanban.hide_empty_stacks} disabled={!cfg.canConfigure} onCheckedChange={(on) => cfg.update((c) => setKanban(c, { hide_empty_stacks: on }))} />
    </ViewSettings>
  );

  let body: React.ReactNode;
  if (!stackField) {
    body = (
      <SetupPrompt
        title="Choose how to stack cards"
        description={
          stackFields.length === 0
            ? "This table has no single select, single user or checkbox field to stack cards by. Add one first."
            : cfg.canConfigure
              ? "Pick a field. Each of its values becomes a stack you can drag cards between."
              : "Ask someone who can edit this view to pick the field that cards are stacked by."
        }
      >
        {stackFields.length > 0 && cfg.canConfigure && <FieldSelect label="Stack cards by" fields={stackFields} value="" onChange={(id) => cfg.update((c) => setKanban(c, { stack_field_id: id, stack_order: [] }))} />}
      </SetupPrompt>
    );
  } else if (records.loading) {
    body = (
      <div className="flex h-full items-start justify-center pt-16">
        <Spinner className="size-5" label="Loading cards" />
      </div>
    );
  } else if (records.error && !data) {
    body = (
      <div role="alert" className="flex h-full items-center justify-center p-6 text-[0.8125rem] text-muted">
        Could not load cards: {records.error.message}
      </div>
    );
  } else {
    body = (
      <KanbanBoard
        stacks={stacks}
        primary={primary}
        fields={fields}
        coverField={coverField}
        format={setup.format}
        emails={setup.emails}
        colors={data?.colors ?? {}}
        canEdit={setup.canEdit}
        canConfigure={cfg.canConfigure}
        hasSorts={hasSorts}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        onMoveStack={(key, dir) => cfg.update((c) => setKanban(c, { stack_order: moveStackKey(stacks.map((s) => s.key), key, dir) }))}
        onDrop={onDrop}
        onAddCard={(key) => void addCard(key)}
        onOpen={setup.openRecord}
      />
    );
  }

  const total = data?.total ?? 0;
  return (
    <ViewFrame
      setup={setup}
      recordIds={recordIds}
      features={{ group: false, rowHeight: false }}
      hideFieldsNoun="Card fields"
      toolbarExtra={settings}
      footer={
        stackField && data ? (
          <>
            <span aria-live="polite">
              <LayoutGrid aria-hidden className="mr-1 inline size-3.5" />
              {total.toLocaleString()} card{total === 1 ? "" : "s"}
            </span>
            {data.truncated && (
              <span role="status">
                Showing the first {data.records.length.toLocaleString()} of {total.toLocaleString()} cards. Filter the view to see the rest.
              </span>
            )}
            {hasSorts && setup.canEdit && <span className="hidden sm:inline">Sorted views keep their order: cards move between stacks but cannot be reordered by hand.</span>}
            {cfg.saving && <span className="ml-auto text-xs">Saving view…</span>}
          </>
        ) : undefined
      }
    >
      {body}
    </ViewFrame>
  );
}
