/**
 * The header of a collection screen (COL-1), drawn inside `main`: the collection's color mark, its name as the
 * screen's `h1`, how many records it holds, who is viewing, Share, and a primary "New client" button that
 * uses the collection's record name ("New record" when it has none). A collection inside a folder shows the
 * folder's name above its title. The description, if there is one, is a muted line under it that creators click
 * to change; they also have a "…" beside the title for the collection's settings (COL-10).
 *
 * On a phone it is the 56 px header of PH-2 (a back link to the Collections tab, Share, a + button and the
 * search) and the title sits under it, where it has the whole width: a 12-character name does not have to
 * share a row with the buttons. Who is viewing is left out there (the faces need more room than a phone has).
 *
 * Share is for creators and owners: inviting and sharing a view both need that role, so below it the dialog
 * would hold nothing to do. The record count is the one the sidebar shows (the workspaces list), which
 * follows adds and deletes, this person's and other people's.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Plus, Share2 } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ColorMark } from "@/components/ui/color-mark";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { usePresence } from "@/hooks/usePresence";
import { newRecordLabel } from "@/lib/recordNoun";
import { atLeast } from "@/lib/roles";
import { BaseAvatars } from "@/shell/BaseAvatars";
import { PhoneBackLink, PhoneHeader, type PhoneAction } from "@/shell/PhoneHeader";
import { ScreenHeader } from "@/shell/ScreenHeader";
import { useAddRecord } from "@/views/common/addRecord";
import { basePermissions } from "./permissions";

export interface CollectionHeaderProps {
  schema: BaseSchema;
  /** The open collection; without one the header names the folder. */
  table?: Table;
  /** `/base/:baseId/automations/...`: the folder's automations instead of a collection. */
  section?: "automations";
  onShare: () => void;
  onSettings: (table: Table) => void;
}

const countFormat = new Intl.NumberFormat();

/** How many records the collection has, from the sidebar's list when it has it (that one is kept live), else from the schema. */
function useRecordCount(schema: BaseSchema, table: Table | undefined): number {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list, retryOnMount: false });
  if (!table) return 0;
  const listed = workspaces.data?.find((w) => w.id === schema.workspace_id)?.bases.find((b) => b.id === schema.id)?.tables?.find((t) => t.id === table.id);
  return listed?.record_count ?? table.record_count;
}

/** "12 records", "1 record": the count at the title's side. */
export function recordsCount(n: number): string {
  return `${countFormat.format(n)} ${n === 1 ? "record" : "records"}`;
}

/** The description as one muted line; a creator's click turns it into a field (Enter or leaving it saves, Escape cancels). */
function Description({ table, canEdit }: { table: Table; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const text = table.description?.trim() ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const button = useRef<HTMLButtonElement>(null);
  // Enter ends the edit and then the field goes, which some browsers report as a blur: one save per edit.
  const ended = useRef(false);
  // The field was taking the focus: give it back to the line when the line returns.
  const refocus = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);
  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      button.current?.focus();
    }
  }, [editing]);
  const save = useMutation({
    mutationFn: (description: string) => api.tables.update(table.id, { description }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.base(table.base_id) }),
    onError: (e) => toast.error(e, "Could not save the description"),
  });
  if (!text && !editing) return null;
  const finish = (keep: boolean, byKey: boolean) => {
    if (ended.current) return;
    ended.current = true;
    refocus.current = byKey;
    setEditing(false);
    const next = draft.trim();
    if (keep && next !== text) save.mutate(next);
    else setDraft(text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true, true);
    } else if (e.key === "Escape") {
      // Escape ends this edit and nothing else (a dialog or menu that happens to be open is not its business).
      e.stopPropagation();
      finish(false, true);
    }
  };
  if (editing)
    return <Input aria-label="Description" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} onBlur={() => finish(true, false)} maxLength={1000} autoFocus className="mt-0.5 max-w-xl text-label" />;
  if (!canEdit) return <p className="truncate text-label text-muted">{text}</p>;
  return (
    <button
      ref={button}
      type="button"
      onClick={() => {
        ended.current = false;
        setEditing(true);
      }}
      title="Edit description"
      className="block min-h-6 max-w-full truncate rounded-sm text-left text-label text-muted hover:text-fg"
    >
      {text}
    </button>
  );
}

export function CollectionHeader({ schema, table, section, onShare, onSettings }: CollectionHeaderProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const role = schema.role;
  const canShare = basePermissions.manageSharing(role);
  const canEditCollection = basePermissions.manageTables(role);
  const canAdd = !!table && atLeast(role, "editor");
  const viewers = usePresence(schema.id);
  const add = useAddRecord();
  const count = useRecordCount(schema, table);
  const inFolder = !schema.is_top_level && (!!table || section === "automations");
  const name = section === "automations" ? "Automations" : (table?.name ?? schema.name);
  const markHue = section === "automations" || !table ? schema.color : table.color;
  const newLabel = table ? newRecordLabel(table) : "";

  const title = (
    <div className="min-w-0 flex-1 py-1">
      {inFolder && (
        <p className="flex min-w-0 items-center gap-1.5 text-meta text-muted">
          <ColorMark hue={schema.color} name={schema.name} size={8} className="shrink-0" />
          <span className="truncate">{schema.name}</span>
        </p>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="flex min-w-0 items-center gap-2 text-title">
          <ColorMark hue={markHue} name={name} size={desktop ? 28 : 24} className="shrink-0" />
          <span className="min-w-0 truncate">{name}</span>
        </h1>
        {table && <span className="shrink-0 whitespace-nowrap text-label tabular-nums text-muted">{recordsCount(count)}</span>}
        {table && canEditCollection && (
          <IconButton label="Collection settings" size="sm" onClick={() => onSettings(table)} className="shrink-0">
            <Icon icon={Ellipsis} />
          </IconButton>
        )}
      </div>
      {table && <Description table={table} canEdit={canEditCollection} />}
    </div>
  );

  if (!desktop) {
    const actions: PhoneAction[] = [
      ...(canShare ? [{ id: "share", label: "Share", icon: Share2, onSelect: onShare }] : []),
      ...(canAdd ? [{ id: "new", label: newLabel, icon: Plus, onSelect: add.run, disabled: !add.available }] : []),
    ];
    return (
      <>
        <PhoneHeader leading={<PhoneBackLink to={`/workspace/${schema.workspace_id}/collections`} label="Collections" />} actions={actions} />
        <div className="flex shrink-0 border-b border-line bg-surface px-4 pb-3 pt-2">{title}</div>
      </>
    );
  }

  return (
    <ScreenHeader
      className="py-2"
      actions={
        <>
          <Link to={`/workspace/${schema.workspace_id}/members`} className="shrink-0 rounded-pill px-1 no-underline">
            <BaseAvatars people={schema.people} viewers={viewers} max={4} size="md" />
          </Link>
          {canShare && (
            <Button onClick={onShare}>
              <Icon icon={Share2} /> Share
            </Button>
          )}
          {canAdd && (
            <Button variant="primary" onClick={add.run} disabled={!add.available}>
              <Icon icon={Plus} /> {newLabel}
            </Button>
          )}
        </>
      }
    >
      {title}
    </ScreenHeader>
  );
}
