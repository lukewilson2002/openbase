/**
 * Expanded record: a modal (full screen on a phone) with every field of one record (hidden fields
 * in a collapsible section), editors shared with the grid, previous/next navigation, a shareable
 * URL (`?record=recXXX`, owned by the host view) behind a Share button, comments and revision
 * history in a side panel, and delete/duplicate actions. Fields save by themselves; the header
 * says whether that is going on ("Saving…", "Saved", "Couldn't save"). Reusable by every view type.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { hashKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronLeft, ChevronRight, CopyPlus, MoreHorizontal, Share2, Trash2, X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { errorMessage } from "@/api/client";
import { recordKeys, recordsApi } from "@/api/records";
import type { BaseSchema, Collaborator, Field, TableRecord, Table, View, ViewConfig } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FieldTypeIcon } from "@/components/ui/field-type-icon";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { resolveFieldOrder } from "@/components/viewbar/config";
import { cn } from "@/lib/cn";
import { atLeast } from "@/lib/roles";
import { personColors } from "@/lib/colors";
import { copyToClipboard } from "@/lib/format";
import { displayText, type FormatCtx } from "@/lib/cells/format";
import { isComputed } from "@/lib/cells/kinds";
import { jsonEqual, parseText } from "@/lib/cells/parse";
import { toWire, writableValues } from "@/lib/cells/wire";
import { CellValue } from "./CellValue";
import { CommentsPanel } from "./CommentsPanel";
import { HistoryPanel } from "./HistoryPanel";
import { EditorEnvProvider, type EditValue, type EditorEnv } from "./editors/env";
import { FieldEditor } from "./editors/FieldEditor";

export interface ExpandedRecordProps {
  schema: BaseSchema;
  table: Table;
  view?: View;
  role: string;
  recordId: string;
  /** View config deciding field order and which fields are hidden. */
  config?: ViewConfig;
  prevId?: string | null;
  nextId?: string | null;
  onNavigate: (recordId: string) => void;
  onClose: () => void;
  emails: ReadonlyMap<string, string>;
  timeZone: string;
  currentUserId: string | null;
  collaborators: readonly Collaborator[];
  /** Hosts with an undo history route deletes and copies through it; otherwise the API is called directly. */
  onDeleteRecord?: (recordId: string) => Promise<boolean>;
  onDuplicateRecord?: (record: TableRecord) => Promise<TableRecord | undefined>;
}

function useFormat(timeZone: string, collaborators: readonly Collaborator[]): FormatCtx {
  return useMemo(() => {
    const names = new Map(collaborators.map((c) => [c.id, c.name] as const));
    const emails = new Map(collaborators.map((c) => [c.id, c.email] as const));
    const colors = personColors(collaborators);
    return { timeZone, userName: (id: string) => names.get(id), userEmail: (id: string) => emails.get(id), userColor: (id: string) => colors.get(id) };
  }, [timeZone, collaborators]);
}

/** How long "Saved" stays in the header. */
const SAVED_VISIBLE_MS = 3000;

type SaveState = "idle" | "saving" | "saved" | "error";

/** The record's save status. A polite live region, present from the start so changes are announced. */
function SaveStatus({ state }: { state: SaveState }) {
  return (
    <span role="status" aria-label="Save status" aria-live="polite" className={cn("flex shrink-0 items-center gap-1 whitespace-nowrap px-1 text-xs", state === "error" ? "text-danger" : "text-muted")}>
      {state === "saving" && "Saving…"}
      {state === "saved" && (
        <span className="ob-fade-in flex items-center gap-1">
          <Check aria-hidden className="size-3.5 text-success" /> Saved
        </span>
      )}
      {state === "error" && "Couldn't save"}
    </span>
  );
}

/**
 * The long text of this record that has not reached the server: typed (waiting for typing to pause) or
 * sent (waiting for the answer), by `recordId:fieldId`.
 */
class Unsent {
  private typing = new Set<string>();
  private sent = new Map<string, number>();
  /** The text in a field is (or is no longer) different from what was last saved. */
  typed(key: string, dirty: boolean) {
    if (dirty) this.typing.add(key);
    else this.typing.delete(key);
  }
  /** A save of the field is made: its typed text is the save's now. */
  send(key: string) {
    this.typing.delete(key);
    this.sent.set(key, (this.sent.get(key) ?? 0) + 1);
  }
  /** A save of the field is answered (or refused). */
  answered(key: string) {
    const n = (this.sent.get(key) ?? 0) - 1;
    if (n > 0) this.sent.set(key, n);
    else this.sent.delete(key);
  }
  isWaiting(key: string) {
    return this.typing.has(key) || this.sent.has(key);
  }
}

function FieldRow({
  field,
  record,
  readOnly,
  error,
  env,
  emails,
  lastSaved,
  unsent,
  onSave,
}: {
  field: Field;
  record: TableRecord;
  readOnly: boolean;
  error?: string;
  env: EditorEnv;
  emails: ReadonlyMap<string, string>;
  /** What this record's fields were last saved as, by field id. */
  lastSaved: RefObject<Map<string, unknown>>;
  /** Which long text fields have text of ours that is typed but not sent yet, or sent and not answered yet. */
  unsent: RefObject<Unsent>;
  onSave: (field: Field, edit: EditValue) => void;
}) {
  const value = record.values[field.id] ?? null;
  const computed = isComputed(field);
  const labelId = `field-${field.id}`;
  // An editor is rebuilt when its value changes under it (someone else edited it, a save was refused). Long
  // text saves while it is typed in, so a value that is only our own save coming back must not rebuild the
  // editor, or the caret would jump out from under the typing. Nor is it rebuilt while text of ours is typed
  // but not sent, or sent but not answered: a refetch in that time answers with what the server held before
  // (the text being typed would be replaced by it, and the next keystroke would save the stale text).
  const textKey = `${record.id}:${field.id}`;
  const rebuilds = useRef({ json: JSON.stringify(value), n: 0 });
  if (field.type === "long_text") {
    const json = JSON.stringify(value);
    if (json !== rebuilds.current.json) {
      rebuilds.current.json = json;
      if (!jsonEqual(value, lastSaved.current.get(textKey) ?? null) && !unsent.current.isWaiting(textKey)) rebuilds.current.n++;
    }
  }
  const editorKey = field.type === "long_text" ? `${record.id}:${field.id}:${rebuilds.current.n}` : `${record.id}:${field.id}:${JSON.stringify(value)}`;
  return (
    <div className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3" role="group" aria-labelledby={labelId}>
      <div className="flex min-w-0 items-start gap-1.5 pt-1.5">
        <FieldTypeIcon type={field.type} className="mt-0.5" />
        <div className="min-w-0">
          <h3 id={labelId} className="truncate text-[0.8125rem] font-medium" title={field.description ?? undefined}>
            {field.name}
          </h3>
          {field.description && <p className="line-clamp-2 text-xs text-muted">{field.description}</p>}
        </div>
      </div>
      <div className="min-w-0">
        {readOnly || computed ? (
          <div className={cn("rounded-md px-2 py-1.5", computed ? "bg-subtle/60" : "")}>
            <CellValue field={field} value={value} format={env.format} emails={emails} />
            {computed && <span className="sr-only"> (computed, read-only)</span>}
          </div>
        ) : (
          <FieldEditor
            key={editorKey}
            field={field}
            value={value}
            variant="form"
            labelledBy={labelId}
            onChange={field.type === "long_text" ? (edit) => unsent.current.typed(textKey, edit.text !== undefined && edit.text !== (typeof value === "string" ? value : "")) : undefined}
            onCommit={(edit) => onSave(field, edit)}
            onCancel={() => {}}
          />
        )}
        {error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function ExpandedRecord({ schema, table, role, recordId, config, prevId, nextId, onNavigate, onClose, emails, timeZone, currentUserId, collaborators, onDeleteRecord, onDuplicateRecord }: ExpandedRecordProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const canEdit = atLeast(role, "editor");
  const canComment = atLeast(role, "commenter");
  const format = useFormat(timeZone, collaborators);
  const env = useMemo<EditorEnv>(() => ({ baseId: schema.id, tableId: table.id, collaborators, timeZone, canCreateOptions: atLeast(role, "creator"), format, currentUserId }), [schema.id, table.id, collaborators, timeZone, role, format, currentUserId]);
  const recordKey = recordKeys.record(table.id, recordId);
  const record = useQuery({ queryKey: recordKey, queryFn: () => recordsApi.get(table.id, recordId) });
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Saves of this record in flight, and whether the last one finished a moment ago ("Saved").
  const [pending, setPending] = useState(0);
  const [justSaved, setJustSaved] = useState(false);
  const inflight = useRef(0);
  const lastSaved = useRef(new Map<string, unknown>());
  const unsent = useRef(new Unsent());
  const currentId = useRef(recordId);
  currentId.current = recordId;
  const [showHidden, setShowHidden] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { visible, hidden } = useMemo(() => resolveFieldOrder(table, config ?? { field_order: [], hidden_fields: [] }), [table, config]);
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const title = record.data && primary ? displayText(primary, record.data.values[primary.id], format) || "Untitled record" : "Record";

  useEffect(() => setErrors({}), [recordId]);

  // Alt+Up / Alt+Down move through the records of the view.
  useEffect(() => {
    // What is being typed is committed (the editor commits when it loses focus) before the next record is
    // shown: it belongs to the record it was typed in.
    const go = (id: string) => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && el.closest("[role=dialog]") && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) el.blur();
      onNavigate(id);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === "ArrowUp" && prevId) {
        e.preventDefault();
        go(prevId);
      } else if (e.key === "ArrowDown" && nextId) {
        e.preventDefault();
        go(nextId);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [prevId, nextId, onNavigate]);

  // Everything a save needs travels in its variables: long text saves when the editor goes away (the
  // record is closed or navigated), which is after `recordId` has already moved on.
  const save = useMutation({
    // One save at a time per table, in the order they were made, so a slow earlier save of a text
    // being typed cannot land after a later one.
    scope: { id: `record-saves:${table.id}` },
    mutationFn: async ({ recordId: id, field, value }: { recordId: string; field: Field; value: unknown }) => recordsApi.update(table.id, { typecast: true, records: [{ id, values: { [field.id]: toWire(field, value) as never } }] }),
    onMutate: async ({ recordId: id, field, value }) => {
      inflight.current++;
      setPending((n) => n + 1);
      setJustSaved(false);
      const key = recordKeys.record(table.id, id);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<TableRecord>(key);
      if (prev) {
        const values = { ...prev.values } as Record<string, unknown>;
        if (value === null || value === undefined || value === "" || value === false || (Array.isArray(value) && value.length === 0)) delete values[field.id];
        else values[field.id] = value;
        qc.setQueryData<TableRecord>(key, { ...prev, values: values as TableRecord["values"] });
      }
      return { prev, key };
    },
    onError: (e, { recordId: id, field }, ctx) => {
      if (ctx?.prev) {
        // The text the person typed stays in its editor (so it can be corrected and saved again): the
        // rolled-back value must not look like someone else's edit.
        lastSaved.current.set(`${id}:${field.id}`, ctx.prev.values[field.id] ?? null);
        qc.setQueryData(ctx.key, ctx.prev);
      }
      if (id === currentId.current) setErrors((cur) => ({ ...cur, [field.id]: errorMessage(e) }));
    },
    onSuccess: (res, { recordId: id, field }, ctx) => {
      if (id === currentId.current) {
        setErrors((cur) => {
          const { [field.id]: _gone, ...rest } = cur;
          return rest;
        });
      }
      // With another save of this table still on its way, its own answer is the newer one.
      const updated = res?.records?.[0];
      const key = ctx?.key ?? recordKeys.record(table.id, id);
      const answered = !!updated && inflight.current <= 1;
      if (updated && answered) qc.setQueryData(key, updated);
      // The grid refreshes its pages from this invalidation (events from this tab are not echoed back). The
      // record itself is left out: a refetch of it would answer with what this save wrote while a later save
      // of the same text is on its way, which the editor takes for someone else's edit. It is refetched
      // only when its own save did not bring it up to date.
      const own = hashKey(key);
      void qc.invalidateQueries({ queryKey: recordKeys.table(table.id), predicate: (q) => q.queryHash !== own || (!updated && inflight.current <= 1) });
    },
    onSettled: (_res, _err, { recordId: id, field }) => {
      unsent.current.answered(`${id}:${field.id}`);
      inflight.current = Math.max(0, inflight.current - 1);
      setPending((n) => Math.max(0, n - 1));
      setJustSaved(true);
    },
  });

  // "Saved" fades after a few seconds.
  useEffect(() => {
    if (!justSaved || pending > 0) return;
    const t = setTimeout(() => setJustSaved(false), SAVED_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [justSaved, pending]);
  const saveState: SaveState = pending > 0 ? "saving" : Object.keys(errors).length > 0 ? "error" : justSaved ? "saved" : "idle";

  const onSave = (field: Field, edit: EditValue) => {
    const textKey = `${recordId}:${field.id}`;
    const before = record.data?.values[field.id] ?? null;
    let after: unknown = edit.json ?? null;
    if (edit.text !== undefined) {
      const res = parseText(field, edit.text, { timeZone, users: collaborators });
      if (!res.ok) {
        setErrors((cur) => ({ ...cur, [field.id]: res.error }));
        return;
      }
      if (field.type === "link") return;
      after = res.value;
    }
    if (jsonEqual(before, after)) {
      unsent.current.typed(textKey, false);
      return;
    }
    lastSaved.current.set(textKey, after);
    unsent.current.send(textKey);
    save.mutate({ recordId, field, value: after });
  };

  const copyLink = async () => {
    const ok = await copyToClipboard(window.location.href);
    toast.toast({ title: ok ? "Link copied" : "Could not copy the link", description: ok ? "Anyone with access to this project can open this record." : window.location.href, variant: ok ? "success" : "error" });
  };

  // The share sheet where the browser has one (phones), else the link is copied.
  const share = async () => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ url: window.location.href, title });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return; // the person closed the sheet
      }
    }
    await copyLink();
  };

  const duplicate = async () => {
    const rec = record.data;
    if (!rec) return;
    try {
      if (onDuplicateRecord) {
        const copy = await onDuplicateRecord(rec);
        if (copy) onNavigate(copy.id);
      } else {
        const res = await recordsApi.create(table.id, { records: [{ values: writableValues(table.fields, rec.values as Record<string, unknown>) as never }], typecast: true, after_record_id: rec.id });
        void qc.invalidateQueries({ queryKey: recordKeys.table(table.id) });
        const copy = res.records[0];
        if (copy) onNavigate(copy.id);
      }
    } catch (e) {
      toast.error(e, "Could not duplicate the record");
    }
  };

  const remove = async () => {
    if (onDeleteRecord) {
      if (await onDeleteRecord(recordId)) onClose();
      return;
    }
    await recordsApi.remove(table.id, [recordId]);
    void qc.invalidateQueries({ queryKey: ["records"] });
    onClose();
  };

  const body = record.isPending ? (
    <div className="flex flex-1 items-center justify-center">
      <Spinner className="size-6" label="Loading record" />
    </div>
  ) : record.isError || !record.data ? (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-[0.8125rem]">
      <p className="font-medium">This record could not be loaded.</p>
      <p className="text-muted">{record.isError ? errorMessage(record.error) : "It may have been deleted."}</p>
      <Button onClick={onClose}>Close</Button>
    </div>
  ) : (
    // Below md the fields and the comments stack in one scrolling column: two scroll areas on a phone
    // left the fields about half the screen and the comments pane fighting it for every swipe.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain md:flex-row md:overflow-hidden">
      <div className="p-4 md:min-h-0 md:flex-1 md:overflow-y-auto">
        <div className="flex flex-col gap-4">
          {visible.map((f) => (
            <FieldRow key={f.id} field={f} record={record.data} readOnly={!canEdit} error={errors[f.id]} env={env} emails={emails} lastSaved={lastSaved} unsent={unsent} onSave={onSave} />
          ))}
          {hidden.length > 0 && (
            <div className="border-t border-line pt-3">
              <button type="button" aria-expanded={showHidden} aria-controls="hidden-fields" onClick={() => setShowHidden((s) => !s)} className="flex items-center gap-1 text-[0.8125rem] font-medium text-muted hover:text-fg">
                <ChevronDown aria-hidden className={cn("size-4 transition-transform", !showHidden && "-rotate-90")} />
                {showHidden ? "Hide" : "Show"} {hidden.length} hidden field{hidden.length === 1 ? "" : "s"}
              </button>
              {showHidden && (
                <div id="hidden-fields" className="mt-3 flex flex-col gap-4">
                  {hidden.map((f) => (
                    <FieldRow key={f.id} field={f} record={record.data} readOnly={!canEdit} error={errors[f.id]} env={env} emails={emails} lastSaved={lastSaved} unsent={unsent} onSave={onSave} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <aside aria-label="Comments and history" className="flex min-h-[18rem] w-full shrink-0 flex-col border-t border-line md:min-h-0 md:w-80 md:border-l md:border-t-0">
        <Tabs defaultValue="comments" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="shrink-0 px-2">
            <TabsTrigger value="comments">Comments</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent value="comments" className="min-h-0 flex-1 pt-0">
            <CommentsPanel recordId={recordId} collaborators={collaborators} currentUserId={currentUserId} canComment={canComment} timeZone={timeZone} />
          </TabsContent>
          <TabsContent value="history" className="min-h-0 flex-1 pt-0 md:overflow-y-auto">
            <HistoryPanel tableId={table.id} recordId={recordId} fields={table.fields} format={format} />
          </TabsContent>
        </Tabs>
      </aside>
    </div>
  );

  return (
    <EditorEnvProvider value={env}>
      <D.Root open onOpenChange={(o) => !o && onClose()}>
        <D.Portal>
          <D.Overlay className="ob-fade-in fixed inset-0 z-50 bg-overlay" />
          <D.Content
            aria-describedby={undefined}
            onOpenAutoFocus={(e) => {
              // Radix would focus the first button ("Previous record"), which pops its tooltip open and makes the
              // first Escape close the tooltip instead of the record. Focus the dialog itself; Tab still
              // reaches the first control.
              e.preventDefault();
              (e.currentTarget as HTMLElement).focus();
            }}
            // A phone (below sm) gets the whole screen: no margin, no radius, the dynamic viewport's height (so
            // the browser's collapsing toolbar does not cut it off), and padding that keeps clear of the notch and the home indicator.
            className={cn(
              "ob-pop-in fixed inset-0 z-50 flex h-dvh flex-col overflow-hidden bg-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]",
              "sm:inset-6 sm:mx-auto sm:h-auto sm:max-w-5xl sm:rounded-lg sm:border sm:border-line sm:p-0 sm:shadow-pop",
            )}
            onInteractOutside={(e) => {
              // Pop-over editors render outside the dialog; clicking them must not dismiss it.
              if ((e.target as HTMLElement | null)?.closest("[data-radix-popper-content-wrapper]")) e.preventDefault();
            }}
          >
            <header className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-2">
              <IconButton label="Previous record (Alt+Up)" disabled={!prevId} onClick={() => prevId && onNavigate(prevId)}>
                <ChevronLeft aria-hidden className="size-4 rotate-90" />
              </IconButton>
              <IconButton label="Next record (Alt+Down)" disabled={!nextId} onClick={() => nextId && onNavigate(nextId)}>
                <ChevronRight aria-hidden className="size-4 rotate-90" />
              </IconButton>
              <D.Title className="ml-1 min-w-0 flex-1 truncate text-base font-semibold">{title}</D.Title>
              <SaveStatus state={saveState} />
              <IconButton label="Share record" onClick={() => void share()}>
                <Share2 aria-hidden className="size-4" />
              </IconButton>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="Record actions" className="inline-flex size-8 pointer-coarse:size-10 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg">
                    <MoreHorizontal aria-hidden className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem disabled={!canEdit || !record.data} onSelect={() => void duplicate()}>
                    <CopyPlus aria-hidden className="size-4" /> Duplicate record
                  </DropdownMenuItem>
                  <DropdownMenuItem danger disabled={!canEdit} onSelect={() => setConfirmDelete(true)}>
                    <Trash2 aria-hidden className="size-4" /> Delete record
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <D.Close aria-label="Close" className="inline-flex size-8 pointer-coarse:size-10 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg">
                <X aria-hidden className="size-4" />
              </D.Close>
            </header>
            {body}
          </D.Content>
        </D.Portal>
      </D.Root>
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete this record?" description="It moves to the trash. You can restore it from there." confirmLabel="Delete record" destructive onConfirm={remove} />
    </EditorEnvProvider>
  );
}

