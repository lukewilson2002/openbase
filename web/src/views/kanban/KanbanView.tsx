/**
 * Kanban view: cards stacked by a single select, single user or checkbox field. Records come
 * from the view query (filter, sorts, colours, search), so the toolbar behaves as in the grid;
 * drops write the stack field (and the manual order when the view has no sorts) optimistically.
 */
import { useCallback, useMemo, useRef } from "react";
import { EyeOff } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "@/api/keys";
import { schemaApi } from "@/api/records";
import type { Field, SelectChoice, ViewConfig } from "@/api/types";
import { createChoice } from "@/components/fields/choices";
import { Checkbox } from "@/components/ui/checkbox";
import { Field as FormField, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { Spinner } from "@/components/ui/spinner";
import { CARD_FIELD_LIMIT, cardFields } from "../common/cardFields";
import { DescriptionSelect, setDescriptionField, useDescriptionField } from "../common/description";
import { usePersistedSet } from "../common/usePersistedSet";
import { useViewRecords } from "../common/useViewRecords";
import { useViewSetup } from "../common/useViewSetup";
import { FieldSelect, ViewSettings } from "../common/ViewSettings";
import { ViewSetupState } from "../common/ViewSetupState";
import { ViewFrame } from "../common/ViewFrame";
import type { ViewProps } from "../types";
import { KanbanBoard } from "./KanbanBoard";
import { applyShownOrder, buildAllStacks, clearStack as clearStackFor, isStackField, moveStackKey, stackKind, stackValue, type DropPlan } from "./stacks";

/** Choices for "Fields on a card"; "All" is a number no table reaches. */
const CARD_LIMITS = [3, 4, 5, 6, 8, 10, 12, 20] as const;
const ALL_FIELDS_LIMIT = 100;

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
  const { candidates: descriptionFields, field: descriptionField } = useDescriptionField(table, config);
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

  // A base always has someone in it, so no collaborators means they have not arrived yet.
  const peopleLoading = setup.people.length === 0;
  const allStacks = useMemo(
    () =>
      stackField && data
        ? buildAllStacks(stackField, data.records, { stackOrder: kanban.stack_order, hideEmpty: kanban.hide_empty_stacks, people: setup.people, hiddenStacks: kanban.hidden_stacks, showAllPeople: kanban.show_all_people, peopleLoading })
        : [],
    [stackField, data, kanban.stack_order, kanban.hide_empty_stacks, kanban.hidden_stacks, kanban.show_all_people, setup.people, peopleLoading],
  );
  const stacks = useMemo(() => allStacks.filter((s) => !s.hidden), [allStacks]);
  const hiddenStacks = useMemo(() => allStacks.filter((s) => s.hidden), [allStacks]);
  // While a card is dragged: an empty Uncategorized stack to drop on when the board has none.
  const clearStack = useMemo(() => (stackField ? clearStackFor(stackField, stacks) : null), [stackField, stacks]);
  const stackLabel = useCallback((key: string) => [...allStacks, ...(clearStack ? [clearStack] : [])].find((s) => s.key === key)?.label ?? "that stack", [allStacks, clearStack]);
  // The stack a card sits in already says its stack value, the cover is drawn as the image and
  // the description sits under the title, so none of them repeats as a row.
  const fields = useMemo(
    () => cardFields(table, config, new Set([coverField?.id ?? "", stackField?.id ?? "", descriptionField?.id ?? ""])),
    [table, config, coverField?.id, stackField?.id, descriptionField?.id],
  );
  const recordIds = useMemo(() => stacks.flatMap((s) => s.records.map((r) => r.id)), [stacks]);
  const recordsById = useMemo(() => new Map((data?.records ?? []).map((r) => [r.id, r] as const)), [data]);
  const hasSorts = cfg.queryConfig.sorts.length > 0;

  const onDrop = useCallback(
    (plan: DropPlan) => {
      if (!stackField) return;
      void writes.updateAndMove(plan.recordId, plan.changeValue ? { [stackField.id]: stackValue(stackField, plan.toKey) } : {}, plan.anchor, {
        label: "Move card",
        toast: plan.changeValue ? `Moved to ${stackLabel(plan.toKey)}` : undefined,
      });
    },
    [stackField, writes, stackLabel],
  );

  const addTarget = useRef<(() => string | null) | null>(null);
  const addCard = useCallback(
    async (key: string) => {
      // null clears what the view's filter would have filled in: a card added to Uncategorized has no value.
      if (stackField) await setup.addRecord({ [stackField.id]: stackValue(stackField, key) });
    },
    [stackField, setup],
  );

  // Delete, copy and move act on cards by id: from the selection bar, the Delete key and a card's menu.
  const { actions } = setup;
  const deleteCards = useCallback((ids: string[], done?: () => void) => actions.requestDelete(ids, done), [actions]);
  const duplicateCards = useCallback(
    (ids: string[], done?: () => void) => {
      const list = ids.map((id) => recordsById.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
      void actions.duplicate(list, done);
    },
    [actions, recordsById],
  );
  const moveCards = useCallback(
    async (ids: string[], key: string, done?: () => void) => {
      if (!stackField) return;
      const values = { [stackField.id]: stackValue(stackField, key) };
      const label = stackLabel(key);
      if (ids.length === 1) {
        if (await writes.update(ids[0]!, values, { label: "Move card", toast: `Moved to ${label}` })) done?.();
        return;
      }
      // One request each, so every card keeps its own undo step; a failure stops and says so.
      let moved = 0;
      for (const id of ids) {
        if (!(await writes.update(id, values, { label: "Move card" }))) break;
        moved++;
      }
      if (moved > 0) toast.toast({ title: `${moved.toLocaleString()} cards moved to ${label}`, variant: "success" });
      if (moved === ids.length) done?.();
    },
    [stackField, writes, stackLabel, toast],
  );

  // Stacks that are options of a single select can be renamed, recoloured and deleted from the board
  // (changing a field's options takes the Creator role, like adding a stack).
  const choiceField = stackField?.type === "single_select" && setup.canCreateOptions ? stackField : undefined;
  const editChoices = useCallback(
    async (change: (choices: SelectChoice[]) => SelectChoice[]) => {
      if (!choiceField || choiceField.type !== "single_select") return;
      // A failure throws to the dialog that asked, which says so itself.
      await schemaApi.updateField(choiceField.id, { type: choiceField.type, options: { choices: change(choiceField.options.choices) } });
      await qc.invalidateQueries({ queryKey: keys.base(schema.id) });
      await qc.invalidateQueries({ queryKey: ["records", table.id] });
    },
    [choiceField, qc, schema.id, table.id],
  );
  const renameStack = choiceField ? (key: string, name: string) => editChoices((cs) => cs.map((c) => (c.id === key ? { ...c, name } : c))) : undefined;
  const colorStack = choiceField ? (key: string, color: string) => editChoices((cs) => cs.map((c) => (c.id === key ? { ...c, color } : c))) : undefined;
  const deleteStack = choiceField ? (key: string) => editChoices((cs) => cs.filter((c) => c.id !== key)) : undefined;

  const shownKeys = stacks.map((s) => s.key);
  const allKeys = allStacks.map((s) => s.key);
  /** Saves the shown stacks in a new order; hidden ones keep their place among them. */
  const saveOrder = (next: readonly string[]) => cfg.update((c) => setKanban(c, { stack_order: applyShownOrder(allKeys, shownKeys, next) }));
  const hideStack = (key: string) => cfg.update((c) => setKanban(c, { hidden_stacks: [...new Set([...(c.kanban.hidden_stacks ?? []), key])] }));
  const showStack = (key: string) => cfg.update((c) => setKanban(c, { hidden_stacks: (c.kanban.hidden_stacks ?? []).filter((k) => k !== key) }));

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

  const kind = stackKind(stackField);
  // Where the "Add a stack" button would be, when there is none: say why.
  const addStackNote = onAddStack
    ? undefined
    : kind === "select"
      ? "Adding a stack adds an option to the field, which takes the Creator role."
      : kind === "user"
        ? kanban.show_all_people
        ? "Every collaborator has a stack. Add people to the base to give them one."
        : cfg.canConfigure
          ? "Stacks follow the people with cards. Turn on Show everyone in View to add the rest."
          : "Stacks follow the people with cards."
        : kind === "checkbox"
          ? "A checkbox always has two stacks: checked and unchecked."
          : undefined;
  const cardLimit = kanban.card_field_limit ?? CARD_FIELD_LIMIT;
  const limitOptions = [...new Set([...CARD_LIMITS, ALL_FIELDS_LIMIT, cardLimit])].sort((a, b) => a - b);
  const note = cfg.canConfigure ? undefined : "You do not have permission to change this view.";
  const chooseStack = (id: string | null) => cfg.update((c) => setKanban(c, { stack_field_id: id, stack_order: [], hidden_stacks: [] }));
  const settings = (
    <ViewSettings note={note}>
      <FieldSelect label="Stack cards by" fields={stackFields} value={stackField?.id ?? ""} disabled={!cfg.canConfigure} onChange={chooseStack} hint="A single select, single user or checkbox field." />
      {kind === "user" && (
        <Checkbox
          label="Show everyone, even people with no cards"
          checked={kanban.show_all_people}
          disabled={!cfg.canConfigure}
          onCheckedChange={(on) => cfg.update((c) => setKanban(c, { show_all_people: on }))}
        />
      )}
      <FieldSelect label="Cover image" fields={attachmentFields} value={coverField?.id ?? ""} noneLabel="No cover" disabled={!cfg.canConfigure} onChange={(id) => cfg.update((c) => setKanban(c, { cover_field_id: id }))} />
      <FormField label="Cover image fit" hint={coverField ? "Crop fills the picture area; fit shows the whole image." : "Choose a cover image first."}>
        {(ctl) => (
          <Select {...ctl} value={kanban.cover_fit ? "fit" : "crop"} disabled={!cfg.canConfigure || !coverField} onChange={(e) => cfg.update((c) => setKanban(c, { cover_fit: e.target.value === "fit" }))}>
            <option value="crop">Crop to fill</option>
            <option value="fit">Fit inside</option>
          </Select>
        )}
      </FormField>
      <FormField label="Fields on a card" hint="Cards show only fields that have a value. Hide fields in the toolbar to choose which.">
        {(ctl) => (
          <Select {...ctl} value={String(cardLimit)} disabled={!cfg.canConfigure} onChange={(e) => cfg.update((c) => setKanban(c, { card_field_limit: Number(e.target.value) }))}>
            {limitOptions.map((n) => (
              <option key={n} value={n}>
                {n >= ALL_FIELDS_LIMIT ? "All" : n}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <DescriptionSelect candidates={descriptionFields} field={descriptionField} disabled={!cfg.canConfigure} onChange={(id) => cfg.update((c) => setDescriptionField(c, id))} />
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
        descriptionField={descriptionField}
        cardLimit={cardLimit}
        coverFit={kanban.cover_fit ? "contain" : "cover"}
        format={setup.format}
        emails={setup.emails}
        colors={data?.colors ?? {}}
        canEdit={setup.canEdit}
        canConfigure={cfg.canConfigure}
        hasSorts={hasSorts}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        onMoveStack={(key, dir) => saveOrder(moveStackKey(shownKeys, key, dir))}
        onReorderStacks={cfg.canConfigure ? saveOrder : undefined}
        onHideStack={cfg.canConfigure ? hideStack : undefined}
        hiddenStacks={hiddenStacks}
        onShowStack={cfg.canConfigure ? showStack : undefined}
        onRenameStack={renameStack}
        onColorStack={colorStack}
        onDeleteStack={deleteStack}
        fieldName={stackField.name}
        clearStack={clearStack}
        onDrop={onDrop}
        onAddCard={(key) => void addCard(key)}
        addTargetRef={addTarget}
        onAddStack={onAddStack}
        addStackNote={addStackNote}
        onOpen={setup.openRecord}
        onDeleteRecords={deleteCards}
        onDuplicateRecords={duplicateCards}
        onMoveRecords={(ids, key, done) => void moveCards(ids, key, done)}
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
      onAdd={setup.canEdit ? () => void addCard(addTarget.current?.() ?? stacks[0]?.key ?? "") : undefined}
      footer={footer}
    >
      {body}
    </ViewFrame>
  );
}
