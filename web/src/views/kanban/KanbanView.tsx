/**
 * Kanban view: cards stacked by a single select, single user or checkbox field. Records come
 * from the view query (filter, sorts, colours, search), so the toolbar behaves as in the grid;
 * drops write the stack field (and the manual order when the view has no sorts) optimistically.
 */
import { useCallback, useMemo } from "react";
import { EyeOff } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "@/api/keys";
import type { Field, ViewConfig } from "@/api/types";
import { createChoice } from "@/components/fields/choices";
import { useToast } from "@/components/ui/toast";
import { Spinner } from "@/components/ui/spinner";
import { cardFields } from "../common/cardFields";
import { usePersistedSet } from "../common/usePersistedSet";
import { useViewRecords } from "../common/useViewRecords";
import { useViewSetup } from "../common/useViewSetup";
import { FieldSelect, ViewSettings } from "../common/ViewSettings";
import { ViewSetupState } from "../common/ViewSetupState";
import { ViewFrame } from "../common/ViewFrame";
import type { ViewProps } from "../types";
import { KanbanBoard } from "./KanbanBoard";
import { buildStacks, isStackField, moveStackKey, stackKind, stackValue, type DropPlan } from "./stacks";

export default function KanbanView(props: ViewProps) {
  return <KanbanInner key={props.view.id} {...props} />;
}

function setKanban(c: ViewConfig, patch: Partial<ViewConfig["kanban"]>): ViewConfig {
  return { ...c, kanban: { ...c.kanban, ...patch } };
}

/** The field a new kanban most likely wants: a single select, else a person, else a checkbox. */
export function likelyStackField(fields: readonly Field[]): Field | undefined {
  return fields.find((f) => stackKind(f) === "select") ?? fields.find((f) => stackKind(f) === "user") ?? fields.find((f) => stackKind(f) === "checkbox");
}

function KanbanInner(props: ViewProps) {
  const setup = useViewSetup(props);
  const { schema, table, view, config, cfg, writes } = setup;
  const qc = useQueryClient();
  const toast = useToast();
  const kanban = config.kanban;
  const stackFields = useMemo(() => table.fields.filter(isStackField), [table.fields]);
  const stackField: Field | undefined = stackFields.find((f) => f.id === kanban.stack_field_id);
  const attachmentFields = useMemo(() => table.fields.filter((f) => f.type === "attachment"), [table.fields]);
  const coverField = attachmentFields.find((f) => f.id === kanban.cover_field_id);
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const [collapsed, toggleCollapse] = usePersistedSet(`ob-kanban-collapsed:${view.id}`);

  const records = useViewRecords({
    tableId: table.id,
    viewId: view.id,
    configKey: setup.configKey,
    search: setup.debouncedSearch,
    timeZone: setup.timeZone,
    transient: setup.transient,
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
      const value = stackField ? stackValue(stackField, key) : null;
      const rec = await writes.create(value === null || !stackField ? {} : { [stackField.id]: value });
      if (rec) setup.openRecord(rec.id);
    },
    [stackField, writes, setup],
  );

  // New stacks are new choices of the select, which only people who manage fields may add.
  const onAddStack =
    stackField?.type === "single_select" && setup.canCreateOptions
      ? async (name: string) => {
          try {
            await createChoice(stackField, name);
            await qc.invalidateQueries({ queryKey: keys.base(schema.id) });
          } catch (e) {
            toast.error(e, "Could not add the stack");
          }
        }
      : undefined;

  const note = cfg.canConfigure ? undefined : "You do not have permission to change this view.";
  const chooseStack = (id: string | null) => cfg.update((c) => setKanban(c, { stack_field_id: id, stack_order: [] }));
  const settings = (
    <ViewSettings label={stackField ? `Stacked by ${stackField.name}` : "Stack by"} active={!!stackField} note={note}>
      <FieldSelect label="Stack cards by" fields={stackFields} value={stackField?.id ?? ""} disabled={!cfg.canConfigure} onChange={chooseStack} hint="A single select, single user or checkbox field." />
      <FieldSelect label="Cover image" fields={attachmentFields} value={coverField?.id ?? ""} noneLabel="No cover" disabled={!cfg.canConfigure} onChange={(id) => cfg.update((c) => setKanban(c, { cover_field_id: id }))} />
    </ViewSettings>
  );

  let body: React.ReactNode;
  if (!stackField) {
    const likely = likelyStackField(stackFields);
    body = (
      <ViewSetupState
        setup={setup}
        picture="kanban"
        heading="Choose how to stack cards"
        body="Pick a field. Each of its values becomes a stack you can drag cards between."
        emptyBody="This table has no single select, person or checkbox field to stack cards by yet."
        pickers={[{ label: "Stack cards by", fields: stackFields, initial: likely?.id ?? "" }]}
        button="Make stacks"
        onApply={([id]) => chooseStack(id ?? null)}
        footText="Stacks come from a single select or a person field."
        footLink="Add a field"
        addType="single_select"
        accepts={isStackField}
      />
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
        onAddStack={onAddStack}
        onOpen={setup.openRecord}
      />
    );
  }

  const total = data?.total ?? 0;
  // Each stack counts its own cards, so the board has no total under it; only what needs saying.
  const footer =
    stackField && data && (data.truncated || (hasSorts && setup.canEdit) || cfg.saving) ? (
      <>
        {data.truncated && (
          <span role="status">
            Showing the first {data.records.length.toLocaleString()} of {total.toLocaleString()} cards. Filter the view to see the rest.
          </span>
        )}
        {hasSorts && setup.canEdit && <span className="hidden sm:inline">Sorted views keep their order: cards move between stacks but cannot be reordered by hand.</span>}
        {cfg.saving && <span className="ml-auto text-xs">Saving view…</span>}
      </>
    ) : undefined;

  return (
    <ViewFrame
      setup={setup}
      recordIds={recordIds}
      layout="bare"
      features={{ group: false, rowHeight: false }}
      toolbarSetting={settings}
      moreToggles={[
        {
          id: "hide-empty",
          label: "Hide empty stacks",
          icon: <EyeOff aria-hidden />,
          checked: kanban.hide_empty_stacks,
          disabled: !cfg.canConfigure,
          onToggle: (on) => cfg.update((c) => setKanban(c, { hide_empty_stacks: on })),
        },
      ]}
      onAdd={setup.canEdit ? () => void addCard(stacks[0]?.key ?? "") : undefined}
      footer={footer}
    >
      {body}
    </ViewFrame>
  );
}
