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
import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import type { AttachmentRef, BaseSchema, Collaborator, Field, Table, TableRecord } from "@/api/types";
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

/** The link properties and the saved views a Linked records or View block can show (REC-6). Personal views cannot be embedded. */
export function embedChoices(schema: BaseSchema, table: Table): EmbedChoices {
  return {
    linkFields: table.fields.filter((f: Field) => f.type === "link").map((f) => ({ id: f.id, name: f.name })),
    views: schema.tables.flatMap((t) => t.views.filter((v) => !v.personal).map((v) => ({ id: v.id, name: v.name, collection: t.name }))),
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
  /** Opens the record page's Add property box (the block menu's Property); creators only. */
  onAddProperty?: () => void;
}

export function PageSection({ schema, table, record, role, save, pageSave, collaborators, upload, onAddProperty }: PageSectionProps) {
  const canEdit = atLeast(role, "editor");
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
      {content}
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

function PageEditing({ schema, table, record, save, pageSave, text, collaborators, upload, onAddProperty }: Omit<PageSectionProps, "role"> & { text: string }) {
  const field = pageSave.field;
  const textKey = pageTextKey(record.id, field);
  // A page that could not be saved stays as typed, to be corrected, when the editor is built again.
  const failed = field ? save.failed[field.id] : undefined;
  const seed = typeof failed?.value === "string" ? failed.value : text;
  const autosave = useAutosave(seed, pageSave.commit, PAGE_AUTOSAVE_MS);
  const embeds = useMemo(() => embedChoices(schema, table), [schema, table]);
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
