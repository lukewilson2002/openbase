/**
 * A record's Page (REC-5): below a 1 px rule, the collection's Page property in the rich text editor, always
 * editable for editors and up, saved 800 ms after typing pauses. Viewers and commenters read it rendered by the
 * Markdown renderer, with no edit affordances, and see nothing at all when it is empty.
 *
 * - The editor is lazy: Tiptap is its own chunk, and the properties above show first.
 * - With a Page property the text saves like any other value (useRecordSave); with none, the first save makes
 *   "Page" (usePageSave). Creators are offered the property instead of an editor, so adding it is their choice.
 * - The editor (and its autosave) is built again when the page changes under it (someone else's edit, a refused
 *   save rolling back), never for our own save coming back (useRebuilds).
 */
import { lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from "react";
import type { AttachmentRef, BaseSchema, Collaborator, Field, Table, TableRecord } from "@/api/types";
import { EmbedHostProvider, type EmbedHost } from "@/components/embeds/host";
import { useWorkspaceViews, type FoundView } from "@/components/embeds/useWorkspaceViews";
import { useOptionalEditorEnv } from "@/components/record/editors/env";
import { useAutosave } from "@/components/record/editors/useAutosave";
import { Markdown } from "@/components/record/Markdown";
import type { EmbedChoices } from "@/components/richtext/SlashMenu";
import type { MentionPerson } from "@/components/richtext/MentionPicker";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePropertyRoles } from "@/components/fields/usePropertyRoles";
import { atLeast } from "@/lib/roles";
import { pageTextKey, type PageSave } from "./usePageSave";
import { useRebuilds } from "./useRebuilds";
import type { RecordSave } from "./useRecordSave";

const PageEditor = lazy(() => import("@/components/richtext/PageEditor").then((m) => ({ default: m.PageEditor })));

/** How long typing in the page pauses before it is saved (REC-5). */
export const PAGE_AUTOSAVE_MS = 800;

/**
 * The link properties and the saved views a Linked records or View block can show (REC-6): any view of the
 * workspace's folders that the person can open, the saved shared ones only (personal views cannot be embedded).
 */
export function embedChoices(schema: BaseSchema, table: Table, found: readonly FoundView[], loading: boolean, onOpen: () => void): EmbedChoices {
  return {
    linkFields: table.fields.filter((f: Field) => f.type === "link").map((f) => ({ id: f.id, name: f.name })),
    views: found
      // The default grid of a collection is its list of every record, not a view somebody saved.
      .filter((v) => !v.view.personal && !v.view.is_default)
      .map((v) => ({ id: v.view.id, name: v.view.name, collection: v.table.name, folder: v.schema.id === schema.id ? undefined : v.schema.name })),
    loading,
    onOpen,
  };
}

export interface PageSectionProps {
  schema: BaseSchema;
  table: Table;
  record: TableRecord;
  role: string;
  save: RecordSave;
  pageSave: PageSave;
  collaborators: readonly Collaborator[];
  upload: (file: File) => Promise<AttachmentRef>;
  /** Collaborator emails by user id, for the faces in an embedded table. */
  emails?: ReadonlyMap<string, string>;
  /** Opens the record page's Add property box (the block menu's Property); creators only. */
  onAddProperty?: () => void;
}

const NO_EMAILS: ReadonlyMap<string, string> = new Map();

export function PageSection({ schema, table, record, role, save, pageSave, collaborators, upload, emails = NO_EMAILS, onAddProperty }: PageSectionProps) {
  const canEdit = atLeast(role, "editor");
  // Embeds come alive here and nowhere else (REC-6): the Page of a record page has a host, so its embeds read this
  // page's record and save through its save.
  const env = useOptionalEditorEnv();
  const onSave = save.onSave;
  const host = useMemo<EmbedHost | null>(
    () => (env ? { schema, table, record, role, format: env.format, emails, save: (field, edit) => void onSave(field, edit) } : null),
    [env, schema, table, record, role, emails, onSave],
  );
  const field = pageSave.field;
  const value = field ? record.values[field.id] : null;
  const text = typeof value === "string" ? value : "";
  const rebuilds = useRebuilds(pageTextKey(record.id, field), value, save.lastSaved, save.unsent, canEdit);

  let content: ReactNode;
  if (!canEdit) {
    if (!text.trim()) return null;
    content = <Markdown source={text} className="text-read-phone md:text-read" />;
  } else if (!field && atLeast(role, "creator")) {
    content = <AddPage schema={schema} table={table} />;
  } else {
    // Built again when the page changes under it, with its autosave: see useRebuilds.
    content = <PageEditing key={`${record.id}:${rebuilds}`} schema={schema} table={table} record={record} save={save} pageSave={pageSave} text={text} collaborators={collaborators} upload={upload} onAddProperty={onAddProperty} />;
  }
  return (
    <section aria-label="Page" className="mt-6 border-t border-line pt-6">
      <EmbedHostProvider value={host}>{content}</EmbedHostProvider>
    </section>
  );
}

function AddPage({ schema, table }: { schema: BaseSchema; table: Table }) {
  const roles = usePropertyRoles(schema.id, table);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 text-label text-muted">
      <p>This collection has no Page property yet. It keeps the text of each record's page.</p>
      <Button
        variant="secondary"
        loading={busy}
        onClick={() => {
          setBusy(true);
          roles
            .addPage()
            .catch(() => {})
            .finally(() => setBusy(false));
        }}
      >
        Add Page property
      </Button>
    </div>
  );
}

function PageEditing({ schema, table, record, save, pageSave, text, collaborators, upload, onAddProperty }: Omit<PageSectionProps, "role" | "emails"> & { text: string }) {
  const field = pageSave.field;
  const textKey = pageTextKey(record.id, field);
  // A page that could not be saved stays as typed, to be corrected, when the editor is built again.
  const failed = field ? save.failed[field.id] : undefined;
  const seed = typeof failed?.value === "string" ? failed.value : text;
  const autosave = useAutosave(seed, pageSave.commit, PAGE_AUTOSAVE_MS);
  // The workspace's other folders are asked for their views once the block menu has been opened (REC-6).
  const [wantViews, setWantViews] = useState(false);
  const workspaceViews = useWorkspaceViews(schema, wantViews);
  const askForViews = useCallback(() => setWantViews(true), []);
  const embeds = useMemo(() => embedChoices(schema, table, workspaceViews.views, workspaceViews.loading, askForViews), [schema, table, workspaceViews.views, workspaceViews.loading, askForViews]);
  const people = useMemo<MentionPerson[]>(() => collaborators.map((c) => ({ id: c.id, name: c.name, email: c.email })), [collaborators]);
  const onChange = (md: string) => {
    save.unsent.current.typed(textKey, md !== text);
    autosave.change(md);
  };

  return (
    <>
      <Suspense fallback={<PageSkeleton />}>
        <PageEditor value={seed} onChange={onChange} onBlur={autosave.flush} upload={upload} people={people} embeds={embeds} onAddProperty={onAddProperty} />
      </Suspense>
      {pageSave.error && (
        <p role="alert" className="mt-2 text-meta text-danger">
          The page could not be saved: {pageSave.error}
        </p>
      )}
    </>
  );
}

function PageSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-3">
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-2/3" />
      <span className="sr-only" role="status">
        Loading the page
      </span>
    </div>
  );
}
