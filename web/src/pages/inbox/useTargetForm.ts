/**
 * The state of the capture box once a table is picked: the table's schema, what the person has typed
 * into its fields, and which fields take the note and the files. Values stay while the target stays
 * the same and are forgotten when it changes (or is removed).
 */
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Field, Table } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import type { EditValue, EditorEnv } from "@/components/record/editors/env";
import { personColors } from "@/lib/colors";
import { jsonEqual, parseText } from "@/lib/cells/parse";
import { atLeast } from "@/lib/roles";
import { NOTE_AS_COMMENT, attachmentFields, defaultNoteField, type TargetRef } from "./targets";

/** The browser's own zone, for people who have not set one. */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export interface TargetForm {
  /** The table being filled in, null for a plain note. */
  target: TargetRef | null;
  schema: BaseSchema | undefined;
  table: Table | undefined;
  loading: boolean;
  /** The table could not be loaded (it was deleted, or access was lost). */
  failed: boolean;
  env: EditorEnv | null;
  /** Values by field id, in the form editors use (links as `[{id, name}]`). */
  values: Readonly<Record<string, unknown>>;
  errors: Readonly<Record<string, string>>;
  /** The title, or a text field being typed in. */
  setText(field: Field, text: string): void;
  /** An editor reports its value so far (`final` false) or accepts it (`final` true, which also reports problems). */
  edit(field: Field, edit: EditValue, final: boolean): void;
  /** The field the note goes into, or null for none. */
  noteFieldId: string | null;
  setNoteField(id: string | null): void;
  /** The field the files go into, or null for none. */
  fileFieldId: string | null;
  setFileField(id: string | null): void;
  /** Forgets what was typed (after filing, or when another draft opens). */
  clear(): void;
  /** Changes with every `clear`, so the editors are rebuilt empty. */
  generation: number;
}

interface Typed {
  tableId: string;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  gen: number;
}

/** `target` is null while no table is picked: nothing is fetched and the form is empty. */
export function useTargetForm(target: TargetRef | null): TargetForm {
  const baseId = target?.baseId ?? "";
  const tableId = target?.tableId ?? "";
  const me = useMe();
  const schemaQuery = useQuery({ queryKey: keys.base(baseId), queryFn: () => api.bases.get(baseId), enabled: !!target });
  const collaborators = useQuery({ queryKey: keys.baseCollaborators(baseId), queryFn: () => api.bases.collaborators(baseId), staleTime: 60_000, enabled: !!target });
  const schema = schemaQuery.data;
  const table = schema?.tables.find((t) => t.id === tableId);

  // Everything typed belongs to one table: another table starts empty.
  const [typed, setTyped] = useState<Typed>({ tableId: tableId, values: {}, errors: {}, gen: 0 });
  const mine = typed.tableId === tableId ? typed : { tableId: tableId, values: {}, errors: {}, gen: typed.gen };
  const [choice, setChoice] = useState<{ tableId: string; note?: string | null; file?: string | null }>({ tableId: tableId });
  const picked = choice.tableId === tableId ? choice : { tableId: tableId };

  const people = collaborators.data;
  const timeZone = me.data?.timezone || browserTimeZone();
  const env = useMemo<EditorEnv | null>(() => {
    if (!schema || !table) return null;
    const list = people ?? [];
    const names = new Map(list.map((c) => [c.id, c.name] as const));
    const emails = new Map(list.map((c) => [c.id, c.email] as const));
    const colors = personColors(list);
    return {
      baseId: schema.id,
      tableId: table.id,
      collaborators: list,
      timeZone,
      canCreateOptions: atLeast(schema.role, "creator"),
      format: { timeZone, userName: (id) => names.get(id), userEmail: (id) => emails.get(id), userColor: (id) => colors.get(id) },
      currentUserId: me.data?.id ?? null,
    };
  }, [schema, table, people, timeZone, me.data?.id]);

  const patch = useCallback(
    (fieldId: string, value: unknown, error: string | null) =>
      setTyped((cur) => {
        const base = cur.tableId === tableId ? cur : { tableId: tableId, values: {}, errors: {}, gen: cur.gen };
        const { [fieldId]: _gone, ...errors } = base.errors;
        return { ...base, values: { ...base.values, [fieldId]: value }, errors: error ? { ...errors, [fieldId]: error } : errors };
      }),
    [tableId],
  );

  const setText = useCallback((field: Field, text: string) => patch(field.id, text, null), [patch]);

  const edit = useCallback(
    (field: Field, e: EditValue, final: boolean) => {
      let value: unknown = e.json ?? null;
      if (e.text !== undefined) {
        const res = parseText(field, e.text, { timeZone, users: people ?? [] });
        if (!res.ok) {
          // Half-typed text is not an error yet; it is one when the editor lets go of it.
          if (final) patch(field.id, e.text === "" ? null : mine.values[field.id] ?? null, res.error);
          return;
        }
        // A link typed as text is resolved by its own editor, which reports the records picked.
        if (field.type === "link") return;
        value = res.value;
      }
      if (jsonEqual(mine.values[field.id] ?? null, value)) return;
      patch(field.id, value, null);
    },
    [mine.values, patch, people, timeZone],
  );

  const clear = useCallback(() => setTyped((cur) => ({ tableId: tableId, values: {}, errors: {}, gen: cur.gen + 1 })), [tableId]);

  const noteFieldId = table ? (picked.note !== undefined ? picked.note : (defaultNoteField(table)?.id ?? NOTE_AS_COMMENT)) : null;
  const fileFieldId = table ? (picked.file !== undefined ? picked.file : (attachmentFields(table)[0]?.id ?? null)) : null;

  return {
    target,
    schema,
    table,
    loading: !!target && schemaQuery.isPending,
    failed: !!target && schemaQuery.isError || (!!schema && !table),
    env,
    values: mine.values,
    errors: mine.errors,
    setText,
    edit,
    noteFieldId,
    setNoteField: (id) => setChoice({ ...picked, note: id }),
    fileFieldId,
    setFileField: (id) => setChoice({ ...picked, file: id }),
    clear,
    generation: mine.gen,
  };
}
