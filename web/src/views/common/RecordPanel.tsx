/**
 * The record panel of a view, with linked records opened in it: a card of a link field opens that
 * record in the panel (from any table of the project, laid out by its table's grid), and Back returns
 * to the record it was opened from, step by step.
 *
 * The trail lives in the address (`?record=recA&linked=tblB.recB,tblC.recC`), so each step is a
 * history entry: the browser's back (or a phone's back swipe) returns too, and a link to a linked
 * record works. Closing the panel closes all of it; the views drop `linked` whenever `record` changes.
 */
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { recordKeys, recordsApi } from "@/api/records";
import type { BaseSchema, Table } from "@/api/types";
import { ExpandedRecord, type ExpandedRecordProps } from "@/components/record/ExpandedRecord";
import { displayText } from "@/lib/cells/format";
import { defaultViewPath } from "@/lib/views";
import { gridRecordLayout } from "@/views/grid/useViewConfig";

/** The search parameter that holds the linked records opened on top of `record`. */
export const LINKED_PARAM = "linked";

export interface TrailStep {
  table: Table;
  recordId: string;
}

/** The steps of a `linked` value whose tables still exist. */
export function parseTrail(raw: string | null, schema: Pick<BaseSchema, "tables">): TrailStep[] {
  if (!raw) return [];
  const out: TrailStep[] = [];
  for (const part of raw.split(",")) {
    const [tableId, recordId] = part.split(".");
    const table = schema.tables.find((t) => t.id === tableId);
    if (table && recordId) out.push({ table, recordId });
  }
  return out;
}

export function formatTrail(steps: readonly { tableId: string; recordId: string }[]): string {
  return steps.map((s) => `${s.tableId}.${s.recordId}`).join(",");
}

/** Whether the current history entry is a step into a linked record (so going back is a history step). */
interface StepState {
  obLinkedStep?: boolean;
}

/** The title of a record whose data is cached (or fetched), for "Back to …". */
function useRecordTitle(table: Table, recordId: string, timeZone: string): string | undefined {
  const record = useQuery({ queryKey: recordKeys.record(table.id, recordId), queryFn: () => recordsApi.get(table.id, recordId) });
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  if (!record.data || !primary) return undefined;
  return displayText(primary, record.data.values[primary.id], { timeZone, userName: () => undefined }) || "Untitled record";
}

export function RecordPanel(props: ExpandedRecordProps) {
  const { schema, table, recordId, role, timeZone } = props;
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const trail = parseTrail(params.get(LINKED_PARAM), schema);
  const steps = trail.map((s) => ({ tableId: s.table.id, recordId: s.recordId }));
  const trailKey = formatTrail(steps);

  const openLinked = useCallback(
    (tableId: string, linkedId: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const current = parseTrail(prev.get(LINKED_PARAM), schema).map((s) => ({ tableId: s.table.id, recordId: s.recordId }));
          next.set(LINKED_PARAM, formatTrail([...current, { tableId, recordId: linkedId }]));
          return next;
        },
        { state: { obLinkedStep: true } satisfies StepState },
      );
    },
    [setParams, schema],
  );

  const back = useCallback(() => {
    if ((location.state as StepState | null)?.obLinkedStep) {
      navigate(-1);
      return;
    }
    // Opened straight at a linked record (a shared link): there is no step to go back to, so make one.
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const rest = trailKey.split(",").slice(0, -1).join(",");
        if (rest) next.set(LINKED_PARAM, rest);
        else next.delete(LINKED_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [location.state, navigate, setParams, trailKey]);

  const top = trail[trail.length - 1];
  const parent = trail.length > 1 ? trail[trail.length - 2]! : { table, recordId };
  const backLabel = useRecordTitle(parent.table, parent.recordId, timeZone);
  // "Edit schema": the default grid of the table of the record on screen (the panel closes on the way).
  const shownTable = top?.table ?? table;
  const editSchema = useCallback(() => navigate(defaultViewPath(schema.id, shownTable)), [navigate, schema.id, shownTable]);

  if (!top) return <ExpandedRecord {...props} onOpenLinked={openLinked} onEditSchema={editSchema} />;
  return (
    <ExpandedRecord
      {...props}
      key={`${top.table.id}.${top.recordId}`}
      table={top.table}
      recordId={top.recordId}
      view={undefined}
      config={gridRecordLayout(top.table, role) ?? undefined}
      prevId={null}
      nextId={null}
      onNavigate={() => {}}
      // The view's undo history is for its own table; a linked record is deleted or copied directly.
      onDeleteRecord={undefined}
      onDuplicateRecord={undefined}
      justCreated={false}
      onOpenLinked={openLinked}
      onBack={back}
      backLabel={backLabel}
      onEditSchema={editSchema}
    />
  );
}
