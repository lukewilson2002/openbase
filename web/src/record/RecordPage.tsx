/**
 * A record as a page (REC-1): the bar (or the phone's header) on top, the record's properties in a 760 px
 * column, and Comments or History in a 360 px panel on the right (a full-screen sheet on a phone). It
 * replaces the expanded-record modal. Properties save by themselves, and the bar says whether that is going on.
 *
 * The page is driven by props, so it does not know how it was reached: `RecordRoute` reads the address and
 * the opening view and says what comes before and after, and where Escape leads.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, History, MessageSquare, Share2 } from "lucide-react";
import { errorMessage } from "@/api/client";
import { keys } from "@/api/keys";
import { attachmentsApi, commentsApi, recordKeys, recordsApi } from "@/api/records";
import type { BaseSchema, Collaborator, Table, View } from "@/api/types";
import { CommentsPanel } from "@/components/record/CommentsPanel";
import { deleteRecordsText } from "@/components/record/deleteText";
import { EditorEnvProvider, type EditorEnv } from "@/components/record/editors/env";
import { HistoryPanel } from "@/components/record/HistoryPanel";
import { LinkedRecordsProvider, type LinkedRecordsHost } from "@/components/record/linked/LinkedRecords";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { SheetMenu, SheetMenuGroup, SheetMenuRow } from "@/components/ui/sheet-menu";
import { SidePanel } from "@/components/ui/side-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { displayText, linkedColorIn, type FormatCtx } from "@/lib/cells/format";
import { personColors } from "@/lib/colors";
import { recordPath } from "@/lib/recordPath";
import { atLeast } from "@/lib/roles";
import { useUndoScope } from "@/lib/undo/registry";
import { copyToClipboard } from "@/lib/format";
import { SheetModeContext } from "@/shell/menuItems";
import { PhoneBackLink, PhoneHeader, type PhoneAction } from "@/shell/PhoneHeader";
import { discardNewRecord, discardNewRecordOnExit, isNewRecord } from "./newRecords";
import { commentsLabel, RecordBar, RecordMoreItems, SaveStatus, type RecordActions } from "./RecordBar";
import { RecordHead } from "./RecordHead";
import { PageSection } from "./PageSection";
import { RecordProperties } from "./RecordProperties";
import { titleModeOf } from "./properties";
import { useRecordLayout } from "./useRecordLayout";
import { usePageSave } from "./usePageSave";
import { useRecordPanel } from "./useRecordPanel";
import { combineSaveStates, useRecordSave } from "./useRecordSave";

export interface RecordPageProps {
  schema: BaseSchema;
  table: Table;
  role: string;
  recordId: string;
  /** The collection's default view: its property order and the ones it hides lay out every record. */
  layoutView?: View | null;
  prevId?: string | null;
  nextId?: string | null;
  /** Shows another record in place of this one (previous, next, a copy): no new history entry. */
  onNavigate: (recordId: string) => void;
  /** Leaves for the collection the page was opened from (Escape, and after a delete). */
  onClose: () => void;
  /** This record's own collection: the breadcrumb's link. */
  collectionHref: string;
  /** The phone's back link: the collection screen the page was opened from, named for it (a linked record's page is a step on from where it began). Defaults to this record's collection. */
  back?: { href: string; label: string };
  /** Opens a linked record's page. */
  onOpenLinked: (tableId: string, recordId: string) => void;
  emails: ReadonlyMap<string, string>;
  timeZone: string;
  currentUserId: string | null;
  collaborators: readonly Collaborator[];
}

function useFormat(schema: BaseSchema, timeZone: string, collaborators: readonly Collaborator[]): FormatCtx {
  return useMemo(() => {
    const names = new Map(collaborators.map((c) => [c.id, c.name] as const));
    const emails = new Map(collaborators.map((c) => [c.id, c.email] as const));
    const colors = personColors(collaborators);
    return { timeZone, userName: (id: string) => names.get(id), userEmail: (id: string) => emails.get(id), userColor: (id: string) => colors.get(id), linkedColor: linkedColorIn(schema.tables) };
  }, [schema.tables, timeZone, collaborators]);
}

/** Whether Escape was meant for something other than the page: a field being typed in, a menu, a dialog, a sheet. */
function escapeIsTaken(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return true;
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest("[data-escape-cancels], input, textarea, select, [contenteditable=''], [contenteditable='true']")) return true;
  return !!document.querySelector("[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper]");
}

export function RecordPage({ schema, table, role, recordId, layoutView = null, prevId = null, nextId = null, onNavigate, onClose, collectionHref, back, onOpenLinked, emails, timeZone, currentUserId, collaborators }: RecordPageProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  // The collection's undo history waits while a page is open from it.
  useUndoScope(schema.id);
  const qc = useQueryClient();
  const toast = useToast();
  const panelId = useId();
  const canEdit = atLeast(role, "editor");
  const canComment = atLeast(role, "commenter");
  const format = useFormat(schema, timeZone, collaborators);
  const env = useMemo<EditorEnv>(() => ({ baseId: schema.id, tableId: table.id, collaborators, timeZone, canCreateOptions: atLeast(role, "creator"), format, currentUserId, schema }), [schema, table.id, collaborators, timeZone, role, format, currentUserId]);
  const linkedHost = useMemo<LinkedRecordsHost>(() => ({ open: onOpenLinked, href: (tableId, linkedId) => recordPath(schema.id, tableId, linkedId) }), [onOpenLinked, schema.id]);
  // Files in comments go to the project, like files in its rich text (uploading takes the editor role).
  const uploadToProject = useCallback((file: File) => attachmentsApi.upload(schema.id, file), [schema.id]);

  const record = useQuery({ queryKey: recordKeys.record(table.id, recordId), queryFn: () => recordsApi.get(table.id, recordId) });
  const save = useRecordSave({ table, recordId, record: record.data, timeZone, collaborators });
  const layout = useRecordLayout({ schema, table, view: layoutView });
  const pageSave = usePageSave({ baseId: schema.id, table, recordId, save });
  // One status for everything this page saves: values, the page text, and which properties pages show.
  const saveState = combineSaveStates(save.state, layout.state, pageSave.state);
  // The page's Property block asks the property list to open its Add property box.
  const [addPropertyRequest, setAddPropertyRequest] = useState(0);
  const addProperty = useMemo(() => (atLeast(role, "creator") ? () => setAddPropertyRequest((n) => n + 1) : undefined), [role]);
  const comments = useQuery({ queryKey: keys.comments(recordId), queryFn: () => commentsApi.list(recordId) });
  const commentCount = comments.data?.length ?? 0;

  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const titleMode = titleModeOf(primary);
  const title = record.data && primary ? displayText(primary, record.data.values[primary.id], format) || "Untitled record" : "Record";

  // Comments or History, remembered per device on a desktop (REC-7).
  const { panel, opened: panelOpenedByPerson, toggle: togglePanel, set: setPanel } = useRecordPanel(desktop);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // A record added a moment ago starts with its title being edited, and is taken back if it is left empty.
  const justCreated = useMemo(() => isNewRecord(recordId), [recordId]);
  const alive = useRef(new Set<string>());
  useEffect(() => {
    alive.current.add(recordId);
    return () => {
      alive.current.delete(recordId);
      // Strict mode (and a move to another record) runs this cleanup with the page still there: look again after it settles.
      setTimeout(() => {
        if (!alive.current.has(recordId)) void discardNewRecord(qc, table, recordId);
      }, 0);
    };
  }, [recordId, qc, table]);

  // Closing the tab takes it back at once too. A page that goes into the browser's back-forward cache comes
  // back as it was, so only a page that is really going away does.
  useEffect(() => {
    if (!justCreated) return;
    const onHide = (e: PageTransitionEvent) => {
      if (!e.persisted) discardNewRecordOnExit(qc, table, recordId, save.unsent.current.anyWaiting());
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [justCreated, qc, table, recordId, save.unsent]);

  // Alt+Up and Alt+Down move through the records of the view the page was opened from.
  useEffect(() => {
    // What is being typed is committed (the editor commits when it loses focus) before the next record is
    // shown: it belongs to the record it was typed in.
    const go = (id: string) => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) el.blur();
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

  // Escape returns to the collection the page was opened from (a desktop; a phone has the back link). An open
  // panel closes first, since that is what it is for. Anything that has its own use for Escape keeps it.
  useEffect(() => {
    if (!desktop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || escapeIsTaken(e)) return;
      e.preventDefault();
      if (panel) setPanel(null);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [desktop, panel, onClose]);

  const copyLink = useCallback(async () => {
    const ok = await copyToClipboard(window.location.href);
    toast.toast({ title: ok ? "Link copied" : "Could not copy the link", description: ok ? "Anyone with access to this folder can open this record." : window.location.href, variant: ok ? "success" : "error" });
  }, [toast]);

  // The share sheet where the browser has one (phones), else the link is copied.
  const share = useCallback(async () => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ url: window.location.href, title });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return; // the person closed the sheet
      }
    }
    await copyLink();
  }, [title, copyLink]);

  const duplicate = useCallback(async () => {
    try {
      const copy = (await recordsApi.duplicate(table.id, [recordId])).records[0];
      void qc.invalidateQueries({ queryKey: recordKeys.table(table.id) });
      if (copy) onNavigate(copy.id);
    } catch (e) {
      toast.error(e, "Could not duplicate the record");
    }
  }, [table.id, recordId, qc, onNavigate, toast]);

  const remove = useCallback(async () => {
    await recordsApi.remove(table.id, [recordId]);
    onClose();
    void qc.invalidateQueries({ queryKey: ["records"] });
    toast.toast({
      title: "Record deleted",
      durationMs: 8000,
      action: {
        label: "Undo",
        onClick: () => {
          void recordsApi
            .restore(table.id, [recordId])
            .then(() => qc.invalidateQueries({ queryKey: ["records"] }))
            .catch((e: unknown) => toast.error(e, "Could not undo"));
        },
      },
    });
  }, [table.id, recordId, qc, onClose, toast]);

  const actions = useMemo<RecordActions>(
    () => ({ canEdit, duplicate: () => void duplicate(), copyLink: () => void copyLink(), remove: () => setConfirmDelete(true) }),
    [canEdit, duplicate, copyLink],
  );

  // A column of the panel's height, which each panel fills and scrolls in: the box under the thread stays in view.
  const panelContent = (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {panel === "history" ? (
        <HistoryPanel tableId={table.id} recordId={recordId} fields={table.fields} format={format} />
      ) : (
        <CommentsPanel recordId={recordId} collaborators={collaborators} currentUserId={currentUserId} canComment={canComment} timeZone={timeZone} upload={canEdit ? uploadToProject : undefined} />
      )}
    </div>
  );
  const panelTitle = panel === "history" ? "History" : "Comments";

  // Enter in the title moves on to the page (the editor marks itself `data-record-page`); until it has one, to the first value.
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusPage = useCallback(() => {
    const root = bodyRef.current;
    const page = () => root?.querySelector<HTMLElement>("[data-record-page]");
    if (page()) return page()!.focus();
    // The editor is a chunk of its own: with its place on the page but the editor not there yet, wait for it (a
    // few seconds at most), unless the focus has been moved on by then.
    if (root?.querySelector("section[aria-label=Page] [aria-busy]")) {
      const from = document.activeElement;
      let tries = 0;
      const wait = () => {
        if (document.activeElement !== from || !root.isConnected || ++tries > 60) return;
        const target = page();
        if (target) target.focus();
        else setTimeout(wait, 50);
      };
      setTimeout(wait, 50);
      return;
    }
    const target = root?.querySelector<HTMLElement>("[data-edit-field][tabindex='0']");
    if (target) target.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, []);

  const body = record.isPending ? (
    <div aria-busy className="flex flex-col gap-4">
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-4/5" />
      <span className="sr-only" role="status">
        Loading record
      </span>
    </div>
  ) : record.isError || !record.data ? (
    <div role="alert" className="flex flex-col items-center justify-center gap-2 py-16 text-center text-label">
      <p className="font-medium">This record could not be loaded.</p>
      <p className="text-muted">{record.isError ? errorMessage(record.error) : "It may have been deleted."}</p>
      <Button onClick={onClose}>Back to {table.name}</Button>
    </div>
  ) : (
    <>
      <RecordHead table={table} record={record.data} primary={primary} mode={titleMode} title={title} readOnly={!canEdit} format={format} save={save} layoutView={layoutView} autoFocus={justCreated && canEdit} onEnter={focusPage} onEscapeWhenEmpty={justCreated ? onClose : undefined} />
      <LinkedRecordsProvider value={linkedHost}>
        <RecordProperties schema={schema} table={table} record={record.data} view={layoutView} role={role} env={env} emails={emails} save={save} layout={layout} titleMode={titleMode} justCreated={justCreated && canEdit} addPropertyRequest={addPropertyRequest} />
        <PageSection schema={schema} table={table} record={record.data} role={role} save={save} pageSave={pageSave} collaborators={collaborators} upload={uploadToProject} emails={emails} onAddProperty={addProperty} />
      </LinkedRecordsProvider>
    </>
  );

  const phoneActions: PhoneAction[] = [
    { id: "comments", label: commentsLabel(commentCount), icon: MessageSquare, badge: commentCount, onSelect: () => togglePanel("comments") },
    { id: "share", label: "Share", icon: Share2, onSelect: () => void share() },
    { id: "more", label: "More", icon: Ellipsis, onSelect: () => setMoreOpen(true) },
  ];

  return (
    <EditorEnvProvider value={env}>
      {desktop ? (
        <RecordBar
          schema={schema}
          table={table}
          title={title}
          collectionHref={collectionHref}
          saveState={saveState}
          prevId={prevId}
          nextId={nextId}
          onNavigate={onNavigate}
          panel={panel}
          panelId={panelId}
          onPanel={togglePanel}
          commentCount={commentCount}
          onShare={() => void share()}
          actions={actions}
        />
      ) : (
        <PhoneHeader leading={<PhoneBackLink to={back?.href ?? collectionHref} label={back?.label ?? table.name} onBack={onClose} />} actions={phoneActions} search={false} />
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain">
          {!desktop && (
            // A phone has no bar to say it: the save status sits at the top of the page.
            <div className="flex justify-end px-4 pt-2">
              <SaveStatus state={saveState} />
            </div>
          )}
          <div ref={bodyRef} className="mx-auto w-full max-w-record px-4 py-5 max-md:pb-[max(1.25rem,env(safe-area-inset-bottom))] md:px-8 md:py-10">
            {body}
          </div>
        </div>
        {desktop && (
          <SidePanel open={panel !== null} onOpenChange={(o) => !o && setPanel(null)} title={panelTitle} id={panelId} focusOnOpen={panelOpenedByPerson}>
            {panelContent}
          </SidePanel>
        )}
      </div>
      {!desktop && (
        <>
          <Dialog open={panel !== null} onOpenChange={(o) => !o && setPanel(null)} title={panelTitle} flush>
            {panelContent}
          </Dialog>
          <SheetMenu open={moreOpen} onOpenChange={setMoreOpen} title="Record" doneLabel={null}>
            <SheetMenuGroup>
              <SheetMenuRow icon={History} onSelect={() => setPanel("history")}>
                History
              </SheetMenuRow>
            </SheetMenuGroup>
            <SheetMenuGroup>
              <SheetModeContext value>
                <RecordMoreItems actions={actions} />
              </SheetModeContext>
            </SheetMenuGroup>
          </SheetMenu>
        </>
      )}
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} {...deleteRecordsText(role)} confirmLabel="Delete record" destructive onConfirm={remove} />
    </EditorEnvProvider>
  );
}
