/**
 * What the Inbox needs to know about tables: where a note can be saved to (projects the person can
 * add records to), which fields of a table take the note and the files, which others make up the
 * form, and how the form's values become the `fields` of `POST /api/inbox/{id}/file`.
 */
import type { AttachmentRef, BaseSummary, Field, InboxItem, JsonValue, Table, WorkspaceSummary } from "@/api/types";
import { displayShapeOf, isComputed } from "@/lib/cells/kinds";
import { isEmptyValue, toWire } from "@/lib/cells/wire";
import { atLeast } from "@/lib/roles";

/** A table a note can be filed into, named with where it lives. */
export interface TargetRef {
  baseId: string;
  tableId: string;
}

export interface TargetWorkspace {
  workspace: WorkspaceSummary;
  /** Projects with at least one table in which the person can create records. */
  projects: BaseSummary[];
}

/** Creating a record takes the Editor role on the project (the server's rule for `POST /api/inbox/{id}/file`). */
export function canCreateRecords(role: string): boolean {
  return atLeast(role, "editor");
}

/** The workspaces and projects the picker offers: only those where a record can be created. */
export function captureTargets(workspaces: readonly WorkspaceSummary[]): TargetWorkspace[] {
  return workspaces
    .map((workspace) => ({ workspace, projects: workspace.bases.filter((b) => canCreateRecords(b.role) && b.tables.length > 0) }))
    .filter((w) => w.projects.length > 0);
}

// ---- the table's fields -------------------------------------------------------------------

/** Fields that can take the note: rich text first (the note is Markdown, which it shows formatted), then multiline text (which shows the Markdown as typed). */
export function noteFields(table: Table): Field[] {
  return [...table.fields.filter((f) => f.type === "rich_text"), ...table.fields.filter((f) => f.type === "text" && f.options.multiline)];
}

/**
 * In place of a field id where the note goes: it becomes the new record's first comment (filed with
 * `note_as_comment`, in the same step as the record). Field ids start with "fld", so it never clashes.
 */
export const NOTE_AS_COMMENT = "comment";

/** The field the note goes into unless the person picks another: the first rich text, else the first multiline text. */
export function defaultNoteField(table: Table): Field | undefined {
  return noteFields(table)[0];
}

export function attachmentFields(table: Table): Field[] {
  return table.fields.filter((f) => f.type === "attachment");
}

/** The primary field is the form's title. */
export function primaryField(table: Table): Field | undefined {
  return table.fields.find((f) => f.id === table.primary_field_id);
}

/** Primary fields a plain text box can fill (the server reads the text like a typed cell); others use their own editor. */
export function isTextTitle(field: Field): boolean {
  const shape = displayShapeOf(field);
  return shape === "text" || shape === "email" || shape === "url" || shape === "phone";
}

/**
 * The fields below the title: everything a person can fill in except the note's field, the files' field
 * (they have their own places) and attachment fields in general (an upload needs a project, which the
 * inbox's files do not have yet).
 */
export function formFields(table: Table, noteFieldId: string | null): Field[] {
  return table.fields.filter((f) => f.id !== table.primary_field_id && f.id !== noteFieldId && !isComputed(f) && f.type !== "attachment");
}

// ---- filing --------------------------------------------------------------------------------

export interface FileInput {
  table: Table;
  /** The title and the other fields, by field id, as their editors reported them. */
  values: Readonly<Record<string, unknown>>;
  /** The draft's Markdown. */
  note: string;
  noteFieldId: string | null;
  attachments: readonly AttachmentRef[];
  attachmentFieldId: string | null;
}

/** The `fields` of a filing request, keyed by field id; empty values are left out. */
export function fileFields({ table, values, note, noteFieldId, attachments, attachmentFieldId }: FileInput): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const field of table.fields) {
    if (isComputed(field) || field.type === "attachment") continue;
    const raw = field.id === noteFieldId ? note : values[field.id];
    const value = typeof raw === "string" ? raw.trim() : raw;
    if (isEmptyValue(value)) continue;
    out[field.id] = toWire(field, value) as JsonValue;
  }
  if (attachmentFieldId && attachments.length > 0) out[attachmentFieldId] = attachments.map((a) => ({ id: a.id }));
  return out;
}

/** Whether there is anything to put in a record. */
export function hasContent(fields: Record<string, JsonValue>): boolean {
  return Object.keys(fields).length > 0;
}

// ---- drafts --------------------------------------------------------------------------------

/** A draft with nothing in it is not worth creating. */
export function isBlank(title: string, body: string, attachments: readonly unknown[]): boolean {
  return title.trim() === "" && body.trim() === "" && attachments.length === 0;
}

/** A draft's preview in the list: its title, else the first line with text, without Markdown's marks. */
export function draftPreview(item: Pick<InboxItem, "title" | "body" | "attachments">): string {
  if (item.title.trim()) return item.title.trim();
  for (const line of item.body.split("\n")) {
    const text = line
      .replace(/^\s*(?:[>#]+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)\s*/, "")
      .replace(/[*_`~]/g, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .trim();
    if (text) return text;
  }
  return item.attachments.length > 0 ? item.attachments[0]!.filename : "Empty draft";
}

/** Someone a note can mention. */
export interface NotePerson {
  id: string;
  name: string;
  email: string;
}

/**
 * Everyone who can open one of the person's projects (pending invites aside), once each, by name: who a
 * note may mention before a table is picked. Filing notifies only those who can see the record.
 */
export function everyoneInProjects(workspaces: readonly WorkspaceSummary[]): NotePerson[] {
  const byId = new Map<string, NotePerson>();
  for (const ws of workspaces)
    for (const base of ws.bases)
      for (const p of base.people) if (p.user_id && !p.pending && !byId.has(p.user_id)) byId.set(p.user_id, { id: p.user_id, name: p.name, email: p.email });
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
