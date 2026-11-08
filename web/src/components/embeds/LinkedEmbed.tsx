/**
 * The Linked records embed (REC-6): one of this record's link properties as a small table. The caption names the
 * linked collection and counts the links ("Invoices · linked to this client, 2"); Open goes to that collection
 * with a draft filter on the inverse link, so it lists the same records and nothing is saved; a row opens the
 * record's page; editors get a "+ Link" row that adds links.
 */
import { useMemo, type ReactNode } from "react";
import type { Field, Filter } from "@/api/types";
import { LinkEditor } from "@/components/record/editors/LinkEditor";
import { linkedTableOf, previewFields, PREVIEW_FIELDS, useRecordsById } from "@/components/record/linked/LinkedRecords";
import { linkRefs } from "@/lib/cells/kinds";
import { recordNoun } from "@/lib/recordNoun";
import { atLeast } from "@/lib/roles";
import { defaultViewOf, defaultViewPath } from "@/lib/views";
import { applyDraft, nextDraft } from "@/views/drafts/draft";
import { draftLayout } from "@/views/drafts/permissions";
import { readDraft, useDraftUser, writeDraft } from "@/views/drafts/store";
import { EmbedLoading, UnreadableEmbed } from "./boxes";
import { EmbedTable } from "./EmbedTable";
import { useEmbedHost, type EmbedHost } from "./host";

/** The rows shown; the caption counts all the links and Open lists them. */
export const LINKED_ROWS = 10;

export function LinkedEmbed({ fieldId, trailing }: { fieldId: string; trailing?: ReactNode }) {
  const host = useEmbedHost();
  const field = host?.table.fields.find((f) => f.id === fieldId);
  // Only one of this record's own link properties: any other id names nothing this page may show.
  if (!host || !field || field.type !== "link") return <UnreadableEmbed trailing={trailing} />;
  if (!linkedTableOf(host.schema, field)) return <UnreadableEmbed trailing={trailing} />;
  return <LinkedTable host={host} field={field} trailing={trailing} />;
}

function LinkedTable({ host, field, trailing }: { host: EmbedHost; field: Extract<Field, { type: "link" }>; trailing?: ReactNode }) {
  const userId = useDraftUser();
  const linked = linkedTableOf(host.schema, field)!;
  const value = host.record.values[field.id] ?? null;
  const refs = useMemo(() => linkRefs(value), [value]);
  const shownIds = useMemo(() => refs.slice(0, LINKED_ROWS).map((r) => r.id), [refs]);
  const { records, loading } = useRecordsById(linked.id, shownIds);
  const rows = shownIds.flatMap((id) => (records.get(id) ? [records.get(id)!] : []));
  const fields = useMemo(() => previewFields(linked).slice(0, PREVIEW_FIELDS), [linked]);
  const defaultView = defaultViewOf(linked);
  const canAdd = atLeast(host.role, "editor") && (!field.options.single || refs.length === 0);

  /** Opens the collection with a filter on the inverse link: a draft on this device, as filtering there would make. */
  const draftFilter = () => {
    if (!defaultView) return;
    const filter: Filter = { conjunction: "and", items: [{ field_id: field.options.inverse_field_id, op: "has_any_of", value: [host.record.id] }] };
    const prev = readDraft(userId, defaultView.id);
    writeDraft(userId, defaultView.id, nextDraft(prev, defaultView, { ...applyDraft(defaultView.config, prev), filter }, draftLayout(defaultView, prev), Date.now()));
  };

  if (loading && rows.length === 0 && refs.length > 0) return <EmbedLoading label={`Loading ${linked.name}`} />;
  return (
    <EmbedTable
      table={linked}
      baseId={host.schema.id}
      fields={fields}
      records={rows}
      format={host.format}
      emails={host.emails}
      caption={`${linked.name} · linked to this ${recordNoun(host.table)}, ${refs.length}`}
      open={{ to: defaultViewPath(host.schema.id, linked), label: "Open", onFollow: draftFilter }}
      empty={`Nothing in ${field.name} yet.`}
      trailing={trailing}
      footer={
        (refs.length > rows.length || canAdd) && (
          <div className="flex items-center justify-between gap-3 border-t border-line">
            {canAdd ? (
              <LinkEditor
                // The picker starts again from the links the record has when they change.
                key={JSON.stringify(value)}
                field={field}
                value={value}
                variant="form"
                onCommit={(edit) => host.save(field, edit)}
                onCancel={() => {}}
                addAnchor={({ open }) => (
                  <button
                    type="button"
                    onClick={open}
                    aria-haspopup="dialog"
                    aria-label={`Link a record to ${field.name}`}
                    className="inline-flex min-h-control-md items-center px-3 text-label font-medium text-primary-text hover:underline max-md:min-h-control-touch"
                  >
                    + Link
                  </button>
                )}
              />
            ) : (
              <span />
            )}
            {refs.length > rows.length && <span className="px-3 text-meta text-muted">{`Showing ${rows.length} of ${refs.length}`}</span>}
          </div>
        )
      }
    />
  );
}
