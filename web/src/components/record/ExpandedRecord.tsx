/**
 * Expanded record: a modal with every field of one record (hidden fields in a collapsible
 * section), editors shared with the grid, previous/next navigation, a shareable URL
 * (`?record=recXXX`, owned by the host view), comments and revision history in a side panel,
 * and delete/duplicate actions. Reusable by every view type.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, CopyPlus, Link2, MoreHorizontal, Trash2, X } from "lucide-react";
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
    return { timeZone, userName: (id: string) => names.get(id) };
  }, [timeZone, collaborators]);
}

function FieldRow({ field, record, readOnly, error, env, emails, onSave }: { field: Field; record: TableRecord; readOnly: boolean; error?: string; env: EditorEnv; emails: ReadonlyMap<string, string>; onSave: (field: Field, edit: EditValue) => void }) {
  const value = record.values[field.id] ?? null;
  const computed = isComputed(field);
  const labelId = `field-${field.id}`;
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
          <FieldEditor key={`${field.id}:${JSON.stringify(value)}`} field={field} value={value} variant="form" labelledBy={labelId} onCommit={(edit) => onSave(field, edit)} onCancel={() => {}} />
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
  const [showHidden, setShowHidden] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { visible, hidden } = useMemo(() => resolveFieldOrder(table, config ?? { field_order: [], hidden_fields: [] }), [table, config]);
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const title = record.data && primary ? displayText(primary, record.data.values[primary.id], format) || "Untitled record" : "Record";

  useEffect(() => setErrors({}), [recordId]);

  // Alt+Up / Alt+Down move through the records of the view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === "ArrowUp" && prevId) {
        e.preventDefault();
        onNavigate(prevId);
      } else if (e.key === "ArrowDown" && nextId) {
        e.preventDefault();
        onNavigate(nextId);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [prevId, nextId, onNavigate]);

  const save = useMutation({
    mutationFn: async ({ field, value }: { field: Field; value: unknown }) => recordsApi.update(table.id, { typecast: true, records: [{ id: recordId, values: { [field.id]: toWire(field, value) as never } }] }),
    onMutate: async ({ field, value }) => {
      await qc.cancelQueries({ queryKey: recordKey });
      const prev = qc.getQueryData<TableRecord>(recordKey);
      if (prev) {
        const values = { ...prev.values } as Record<string, unknown>;
        if (value === null || value === undefined || value === "" || value === false || (Array.isArray(value) && value.length === 0)) delete values[field.id];
        else values[field.id] = value;
        qc.setQueryData<TableRecord>(recordKey, { ...prev, values: values as TableRecord["values"] });
      }
      return { prev };
    },
    onError: (e, { field }, ctx) => {
      if (ctx?.prev) qc.setQueryData(recordKey, ctx.prev);
      setErrors((cur) => ({ ...cur, [field.id]: errorMessage(e) }));
    },
    onSuccess: (res, { field }) => {
      setErrors((cur) => {
        const { [field.id]: _gone, ...rest } = cur;
        return rest;
      });
      const updated = res?.records?.[0];
      if (updated) qc.setQueryData(recordKey, updated);
      // The grid refreshes its pages from this invalidation (events from this tab are not echoed back).
      void qc.invalidateQueries({ queryKey: recordKeys.table(table.id) });
    },
  });

  const onSave = (field: Field, edit: EditValue) => {
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
    if (jsonEqual(before, after)) return;
    save.mutate({ field, value: after });
  };

  const copyLink = async () => {
    const ok = await copyToClipboard(window.location.href);
    toast.toast({ title: ok ? "Link copied" : "Could not copy the link", description: ok ? "Anyone with access to this base can open this record." : window.location.href, variant: ok ? "success" : "error" });
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
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-4">
          {visible.map((f) => (
            <FieldRow key={f.id} field={f} record={record.data} readOnly={!canEdit} error={errors[f.id]} env={env} emails={emails} onSave={onSave} />
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
                    <FieldRow key={f.id} field={f} record={record.data} readOnly={!canEdit} error={errors[f.id]} env={env} emails={emails} onSave={onSave} />
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
          <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto pt-0">
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
              // Radix would focus the first button ("Copy link"), which pops its tooltip open and makes the
              // first Escape close the tooltip instead of the record. Focus the dialog itself; Tab still
              // reaches the first control.
              e.preventDefault();
              (e.currentTarget as HTMLElement).focus();
            }}
            className="ob-pop-in fixed inset-2 z-50 mx-auto flex max-w-5xl flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-pop sm:inset-x-6 sm:inset-y-6"
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
              <IconButton label="Copy link to this record" onClick={() => void copyLink()}>
                <Link2 aria-hidden className="size-4" />
              </IconButton>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="Record actions" className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg">
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
              <D.Close aria-label="Close" className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg">
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

