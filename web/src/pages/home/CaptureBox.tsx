/**
 * Home's capture box (HOME-3, HOME-4): one raised card to put something down. The first line is the title and any further
 * lines become the page; a "Goes to" chip says which collection it lands in (the last one used, else the first there is, else
 * the Inbox as a draft to file later); a date phrase in the title becomes a chip on the collection's Home date; a dashed chip
 * sets any other property. Files pasted or dropped on the card go to the collection's first attachment property.
 *
 * The words of a date phrase stay in the box while the person types (taking them out under the caret would move it) and leave
 * it when the box loses focus, so the chip and the title agree. Taking the chip off puts the words back.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { attachmentsApi, recordsApi, schemaApi } from "@/api/records";
import type { BaseSchema, JsonValue, WorkspaceSummary } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { Icon } from "@/components/ui/icon";
import { toCreateField } from "@/components/fields/fieldKinds";
import { Button } from "@/components/ui/button";
import { CaptureChip } from "@/components/ui/capture-chip";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { toWire } from "@/lib/cells/wire";
import { restorePhrase, type DateGuess } from "@/lib/dateGuess";
import { recordPath } from "@/lib/recordPath";
import { atLeast } from "@/lib/roles";
import { valueFor } from "@/record/newProperty";
import { AttachmentChips } from "./AttachmentChips";
import { CollectionPicker } from "./CollectionPicker";
import { PropertyChip, type PropertyEntry } from "./PropertyChip";
import { browserTimeZone, dateChip, firstLineOf, guessLine, homeDateField, lastCaptured, pickTarget, rememberCaptured, splitCapture, type TargetChoice } from "./capture";
import { attachmentFields, primaryField } from "./targets";
import { useCollections } from "./useCollections";
import { useUploads } from "./useUploads";

/** What the box knows about a date phrase: the one whose words have left the box, and the words the person kept. */
interface DateState {
  committed: DateGuess | null;
  dismissed: string | null;
}
const NO_DATE: DateState = { committed: null, dismissed: null };

export function CaptureBox({ workspace }: { workspace: WorkspaceSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const me = useMe();
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<TargetChoice | null>(null);
  const [date, setDate] = useState<DateState>(NO_DATE);
  const [extras, setExtras] = useState<PropertyEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [listed, setListed] = useState(false);
  // Read again as the text changes, which is when a phrase can start to mean "today" or "Friday".
  const [now, setNow] = useState(() => Date.now());

  const timeZone = me.data?.timezone || browserTimeZone();
  const weekStart: 0 | 1 = me.data?.week_start === 1 ? 1 : 0;

  // ---- where it goes ------------------------------------------------------------------------------------------------
  const remembered = useMemo(() => lastCaptured(workspace.id), [workspace.id]);
  // A collection's title type lives in its folder's schema. Only the folder in use is fetched until the person opens the list
  // (or has no favourite yet, so the first collection must be found).
  const wantAll = listed || !remembered;
  const needed = chosen?.kind === "collection" ? chosen.baseId : remembered?.baseId;
  const { schemas, found, loading: loadingFolders } = useCollections(workspace, needed, wantAll);
  const target = pickTarget(chosen, remembered, found, workspace);
  const inbox = target.kind === "inbox";
  const schema: BaseSchema | undefined = target.kind === "collection" ? schemas.get(target.baseId) : undefined;
  const table = target.kind === "collection" ? schema?.tables.find((t) => t.id === target.tableId) : undefined;
  const primary = table && primaryField(table);
  const targetKey = target.kind === "inbox" ? "inbox" : `${target.baseId}.${target.tableId}`;

  // ---- the date chip ------------------------------------------------------------------------------------------------
  const dateField = homeDateField(table);
  const { line, tail } = firstLineOf(text);
  const clock = { now, timeZone, weekStart };
  const live = !dateField || date.committed ? null : guessLine(line, clock, date.dismissed);
  const chip = dateField ? dateChip(date.committed ?? live, dateField, clock) : null;
  // A phrase the chip cannot hold (a time on a date-only property) stays in the title: `live` is dropped with its chip.
  const pending = chip && !date.committed ? chip.guess : null;

  // The collection changed to one with no Home date: the words come back.
  useEffect(() => {
    if (date.committed && !dateField && table) {
      setText((cur) => {
        const { line: l, tail: t } = firstLineOf(cur);
        return restorePhrase(date.committed!, l) + t;
      });
      setDate(NO_DATE);
    }
  }, [date.committed, dateField, table]);
  useEffect(() => setExtras([]), [targetKey]);

  // ---- files --------------------------------------------------------------------------------------------------------
  const uploads = useUploads(targetKey, (file) => (target.kind === "inbox" ? api.inbox.upload(file) : attachmentsApi.upload(target.baseId, file)));
  const fileField = table && attachmentFields(table)[0];
  const takeFiles = (files: File[]) => {
    if (files.length === 0) return;
    if (table && !fileField) {
      uploads.refuse(`${table.name} has no attachment property, so a file can't be added to it. Send the capture to Inbox, or add an attachment property.`);
      return;
    }
    void uploads.upload(files);
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;
    e.preventDefault();
    takeFiles(files);
  };
  const onDragOver = (e: DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
  };
  const onDrop = (e: DragEvent) => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    e.preventDefault();
    takeFiles(files);
  };

  // The box grows with its lines.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // ---- adding -------------------------------------------------------------------------------------------------------
  const { title, page } = splitCapture(pending ? pending.rest + tail : text);
  const canAdd = (title !== "" || uploads.files.length > 0) && uploads.uploading.length === 0 && !busy && (inbox || !!table);

  const reset = () => {
    setText("");
    setDate(NO_DATE);
    setExtras([]);
    setProblem(null);
    uploads.clear();
  };

  const add = async () => {
    if (!canAdd) return;
    setBusy(true);
    setProblem(null);
    try {
      if (target.kind === "inbox" || !table || !schema || !primary) {
        const draft = await api.inbox.create({ title, body: page, attachments: uploads.files });
        void qc.invalidateQueries({ queryKey: keys.inbox });
        void qc.invalidateQueries({ queryKey: keys.home(workspace.id) });
        toast.toast({
          title: "Added to Inbox",
          variant: "success",
          action: {
            label: "Undo",
            onClick: () => {
              void api.inbox.remove(draft.id).then(
                () => {
                  void qc.invalidateQueries({ queryKey: keys.inbox });
                  void qc.invalidateQueries({ queryKey: keys.home(workspace.id) });
                },
                (e) => toast.error(e, "Couldn't undo"),
              );
            },
          },
        });
      } else {
        const values: Record<string, JsonValue> = { [primary.id]: toWire(primary, title) as JsonValue };
        if (chip && dateField) values[dateField.id] = chip.value;
        if (uploads.files.length > 0 && fileField) values[fileField.id] = uploads.files.map((f) => ({ id: f.id }));
        if (page && table.body_field_id) values[table.body_field_id] = page;
        const valueCtx = { timeZone, now: Date.now(), weekStart };
        let schemaChanged = false;
        for (const entry of extras) {
          if (entry.kind === "field") {
            values[entry.field.id] = toWire(entry.field, entry.value) as JsonValue;
            continue;
          }
          // A new property is made first; if its value then does not read, the record is still added without it.
          const created = await schemaApi.createField(table.id, toCreateField({ name: entry.name, description: "", kind: entry.plan.kind, inverseName: "" }));
          schemaChanged = true;
          const cell = valueFor(created, entry.text, { ...valueCtx, users: [] });
          if (cell.ok && cell.value !== null) values[created.id] = toWire(created, cell.value) as JsonValue;
        }
        const { records } = await recordsApi.create(table.id, { records: [{ values }] });
        const record = records[0]!;
        if (page && !table.body_field_id) {
          const saved = await recordsApi.setPage(table.id, record.id, page);
          schemaChanged ||= saved.created;
        }
        if (schemaChanged) void qc.invalidateQueries({ queryKey: keys.base(schema.id) });
        void qc.invalidateQueries({ queryKey: keys.home(workspace.id) });
        rememberCaptured(workspace.id, { baseId: schema.id, tableId: table.id });
        toast.toast({
          title: `Added to ${table.name}`,
          variant: "success",
          actions: [
            { label: "Open", onClick: () => navigate(recordPath(schema.id, table.id, record.id)) },
            { label: "Undo", onClick: () => void undoRecord(table.id, record.id) },
          ],
        });
      }
      reset();
      area.current?.focus();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const undoRecord = async (tableId: string, recordId: string) => {
    try {
      // A record nobody has touched since leaves no trace; one that has been is moved to the trash instead.
      const { discarded } = await recordsApi.discard(tableId, recordId);
      if (!discarded) await recordsApi.remove(tableId, [recordId]);
      void qc.invalidateQueries({ queryKey: keys.home(workspace.id) });
      void qc.invalidateQueries({ queryKey: keys.records(tableId) });
    } catch (e) {
      toast.error(e, "Couldn't undo");
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void add();
  };

  const onChange = (next: string) => {
    setText(next);
    setNow(Date.now());
    if (next.trim() === "") setDate(NO_DATE);
    setProblem(null);
  };

  /** The box lost focus: a settled phrase leaves the box and stays as the chip. */
  const settle = () => {
    if (!pending || pending.rest.trim() === "") return;
    setText(pending.rest + tail);
    setDate({ committed: pending, dismissed: null });
  };

  const removeDate = () => {
    const guess = date.committed ?? live;
    if (!guess) return;
    if (date.committed) setText(restorePhrase(date.committed, line) + tail);
    setDate({ committed: null, dismissed: guess.phrase });
  };

  const taken = new Set<string>([primary?.id, table?.body_field_id, dateField && chip ? dateField.id : undefined, ...extras.flatMap((x) => (x.kind === "field" ? [x.field.id] : []))].filter((x): x is string => !!x));

  return (
    <Card
      onDragOver={onDragOver}
      onDrop={onDrop}
      className="border-primary-soft-line p-4 shadow-pop focus-within:border-ring max-md:p-3.5"
      role="group"
      aria-label="Capture"
    >
      <label htmlFor={id} className="sr-only">
        Add a task, a note, a meal, anything
      </label>
      <textarea
        ref={area}
        id={id}
        rows={1}
        value={text}
        placeholder="Add a task, a note, a meal, anything"
        aria-describedby={`${id}-hint`}
        autoComplete="off"
        maxLength={20_000}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={settle}
        className="block max-h-60 w-full resize-none bg-transparent text-capture text-fg outline-none placeholder:text-faint max-md:text-capture-phone"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <CollectionPicker
          options={found.options}
          loading={loadingFolders && wantAll}
          value={target}
          onPick={(c) => {
            setChosen(c);
            area.current?.focus();
          }}
          onOpenChange={(open) => open && setListed(true)}
        />
        {chip && (
          <CaptureChip static>
            <span>{chip.label}</span>
            <button type="button" aria-label={`Remove ${chip.label}`} onClick={removeDate} className="-mr-1.5 inline-flex size-6 items-center justify-center rounded-pill text-muted hover:bg-hover hover:text-fg pointer-coarse:size-9">
              <Icon icon={X} size="sm" />
            </button>
          </CaptureChip>
        )}
        {extras.map((x) => (
          <CaptureChip key={x.kind === "field" ? x.field.id : x.name} static>
            <span>{x.label}</span>
            <button
              type="button"
              aria-label={`Remove ${x.label}`}
              onClick={() => setExtras((cur) => cur.filter((c) => c !== x))}
              className="-mr-1.5 inline-flex size-6 items-center justify-center rounded-pill text-muted hover:bg-hover hover:text-fg pointer-coarse:size-9"
            >
              <Icon icon={X} size="sm" />
            </button>
          </CaptureChip>
        ))}
        {schema && table && (
          <PropertyChip
            schema={schema}
            table={table}
            taken={taken}
            ctx={{ timeZone, now, weekStart }}
            canCreate={atLeast(schema.role, "creator")}
            onAdd={(entry) => setExtras((cur) => [...cur, entry])}
          />
        )}
      </div>
      <AttachmentChips files={uploads.files} uploading={uploads.uploading} onRemove={uploads.remove} />
      {uploads.errors.length > 0 && (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-label text-danger">
          <ul className="min-w-0 flex-1">
            {uploads.errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <button type="button" aria-label="Dismiss" onClick={uploads.dismissErrors} className="-my-1 inline-flex size-7 shrink-0 items-center justify-center rounded hover:bg-hover pointer-coarse:size-9">
            <X aria-hidden className="size-4" />
          </button>
        </div>
      )}
      {problem && (
        <p role="alert" className="mt-3 text-label text-danger">
          {problem}
        </p>
      )}
      <div className="mt-3 flex items-center justify-end gap-3">
        <span id={`${id}-hint`} className="text-meta text-faint max-md:hidden">
          Enter to add
        </span>
        <Button variant="primary" size="md" disabled={!canAdd} loading={busy} onClick={() => void add()}>
          Add
        </Button>
      </div>
    </Card>
  );
}
