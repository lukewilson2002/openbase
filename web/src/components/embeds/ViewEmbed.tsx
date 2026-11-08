/**
 * The View embed (REC-6): the first records of a saved view of this workspace (its first ten unless the block says
 * otherwise), read-only, with the view's name and Open view.
 *
 * Who may see what is the server's: the view is asked for with the same query the collection screen makes, which
 * answers 404 for a folder the person cannot open and for another person's personal view. The page looks the view
 * up in the folders it is given by the server for this person first, and asks for nothing about a view it did not
 * find there, so a reader who cannot open the view gets "You can't open this view" and no record, name or count of
 * it. Personal views cannot be embedded: not even the person's own, because nobody else could open it.
 */
import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { isApiError } from "@/api/client";
import { recordsApi } from "@/api/records";
import { resolveFieldOrder } from "@/components/viewbar/config";
import { PREVIEW_FIELDS } from "@/components/record/linked/LinkedRecords";
import { linkedColorIn } from "@/lib/cells/format";
import { recordNounFor } from "@/lib/recordNoun";
import { defaultTabLabel } from "@/lib/viewTabs";
import { CantOpenEmbed, EmbedLoading } from "./boxes";
import { EmbedTable } from "./EmbedTable";
import { useEmbedHost, type EmbedHost } from "./host";
import { useWorkspaceViews, viewsOf, type FoundView } from "./useWorkspaceViews";

export function ViewEmbed({ viewId, limit, trailing }: { viewId: string; limit: number; trailing?: ReactNode }) {
  const host = useEmbedHost();
  if (!host) return null;
  return <ViewLookup host={host} viewId={viewId} limit={limit} trailing={trailing} />;
}

function ViewLookup({ host, viewId, limit, trailing }: { host: EmbedHost; viewId: string; limit: number; trailing?: ReactNode }) {
  // The folder at hand answers most embeds; the workspace's other folders are asked for only when it does not.
  const here = useMemo(() => viewsOf(host.schema).find((v) => v.view.id === viewId), [host.schema, viewId]);
  const elsewhere = useWorkspaceViews(host.schema, !here);
  const found = here ?? elsewhere.views.find((v) => v.view.id === viewId);
  if (!found) return elsewhere.loading ? <EmbedLoading label="Loading the view" /> : <CantOpenEmbed trailing={trailing} />;
  if (found.view.personal) return <CantOpenEmbed detail="Personal views can't be embedded." trailing={trailing} />;
  return <ViewRows host={host} found={found} limit={limit} trailing={trailing} />;
}

function ViewRows({ host, found, limit, trailing }: { host: EmbedHost; found: FoundView; limit: number; trailing?: ReactNode }) {
  const { view, table, schema } = found;
  const query = useQuery({
    // Under the table's record keys, so a change to its records refreshes the embed.
    queryKey: ["records", table.id, view.id, "embed", limit, host.format.timeZone],
    queryFn: ({ signal }) => recordsApi.query(view.id, { limit, timezone: host.format.timeZone }, signal),
    retry: (count, err) => !(isApiError(err) && (err.status === 403 || err.status === 404)) && count < 2,
  });
  const fields = useMemo(() => resolveFieldOrder(table, view.config).visible.filter((f) => f.id !== table.primary_field_id).slice(0, PREVIEW_FIELDS), [table, view.config]);
  // Values of another folder's collections are drawn with that folder's colors.
  const format = useMemo(() => (schema.id === host.schema.id ? host.format : { ...host.format, linkedColor: linkedColorIn(schema.tables) }), [schema, host.schema.id, host.format]);

  if (query.isError) {
    if (isApiError(query.error) && (query.error.status === 403 || query.error.status === 404)) return <CantOpenEmbed trailing={trailing} />;
    return (
      <div role="note" className="ob-embed ob-embed-unreadable">
        <span>This view could not be loaded</span>
        {trailing && <span className="ml-auto">{trailing}</span>}
      </div>
    );
  }
  if (!query.data) return <EmbedLoading label={`Loading ${view.name}`} />;
  const { records, total } = query.data;
  const label = view.is_default ? defaultTabLabel(table.name) : view.name;
  return (
    <EmbedTable
      table={table}
      baseId={schema.id}
      viewId={view.id}
      fields={fields}
      records={records}
      format={format}
      emails={host.emails}
      caption={`${label} · ${total} ${recordNounFor(table, total)}`}
      open={{ to: `/base/${schema.id}/${table.id}/${view.id}`, label: "Open view" }}
      empty={`No ${recordNounFor(table, 0)} in this view.`}
      trailing={trailing}
      footer={total > records.length && <p className="border-t border-line px-3 py-2 text-meta text-muted">{`Showing ${records.length} of ${total}`}</p>}
    />
  );
}
