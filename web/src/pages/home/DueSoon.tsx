/**
 * Home's Due soon list (HOME-6): records from every collection with a Home date, dated from 30 days ago to 7 days ahead and
 * not done, oldest first. A Done checkbox takes a record off Home (with Undo); it is disabled for people who cannot edit that
 * collection, and a calendar glyph stands in for it where the collection has no Done property.
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays } from "lucide-react";
import { keys } from "@/api/keys";
import { recordsApi } from "@/api/records";
import type { HomeDue, HomeResponse } from "@/api/types";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { FeedRow } from "@/components/ui/feed-row";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { recordPath } from "@/lib/recordPath";
import { dueWords } from "./dueDates";
import { FeedLoading } from "./FeedLoading";

/** Rows shown before "Show more"; the server sends at most 50. */
export const DUE_SHOWN = 8;

export function DueSoon({ workspaceId, home }: { workspaceId: string; home: HomeResponse | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [all, setAll] = useState(false);
  // Rows ticked off, hidden at once while the write is on its way.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());

  const setDone = async (row: HomeDue, done: boolean) => {
    if (!row.done_field_id) return;
    await recordsApi.update(row.table_id, { records: [{ id: row.record_id, values: { [row.done_field_id]: done } }] });
    void qc.invalidateQueries({ queryKey: keys.home(workspaceId) });
    void qc.invalidateQueries({ queryKey: keys.records(row.table_id) });
  };
  const hide = (id: string, hidden: boolean) =>
    setGone((cur) => {
      const next = new Set(cur);
      if (hidden) next.add(id);
      else next.delete(id);
      return next;
    });

  const check = (row: HomeDue) => {
    hide(row.record_id, true);
    setDone(row, true).then(
      () =>
        toast.toast({
          title: `Marked ${row.title ? `“${row.title}”` : "it"} done`,
          action: {
            label: "Undo",
            onClick: () => {
              setDone(row, false).then(
                () => hide(row.record_id, false),
                (e) => toast.error(e, "Couldn't undo"),
              );
            },
          },
        }),
      (e) => {
        hide(row.record_id, false);
        toast.error(e, "Couldn't mark it done");
      },
    );
  };

  const rows = (home?.due ?? []).filter((r) => !gone.has(r.record_id));
  const shown = all ? rows : rows.slice(0, DUE_SHOWN);

  return (
    <section aria-labelledby="home-due" className="flex min-w-0 flex-col gap-2">
      <h2 id="home-due" className="text-h3 max-md:text-sheet">
        Due soon
      </h2>
      <Card padded={false} aria-busy={!home}>
        {!home ? (
          <FeedLoading label="Loading what is due" />
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing is due soon." className="py-6" />
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((row) => (
              <li key={row.record_id}>
                <FeedRow
                  leading={
                    <span className="flex size-8 items-center justify-center max-md:size-control-touch">
                      {row.has_done ? (
                        <Checkbox checked={false} disabled={!row.can_edit} onCheckedChange={() => check(row)} label={<span className="sr-only">Mark {row.title || "this record"} done</span>} className="max-md:size-full max-md:justify-center max-md:gap-0" />
                      ) : (
                        <Icon icon={CalendarDays} className="text-muted" />
                      )}
                    </span>
                  }
                  title={row.title || "Untitled"}
                  meta={row.table_name}
                  metaHue={row.table_color}
                  metaMarkName={row.table_name}
                  trailing={
                    <span className={cn(row.overdue && "font-medium text-danger")}>
                      {/* Red is not the only cue: the date is in words, and a screen reader is told it is late (A11Y-5). */}
                      {row.overdue && <span className="sr-only">Overdue: </span>}
                      {dueWords(row, home.today)}
                    </span>
                  }
                  href={recordPath(row.base_id, row.table_id, row.record_id)}
                  onOpen={() => navigate(recordPath(row.base_id, row.table_id, row.record_id))}
                />
              </li>
            ))}
          </ul>
        )}
        {home && rows.length > DUE_SHOWN && (
          <div className="border-t border-line p-1.5">
            <Button variant="ghost" size="sm" aria-expanded={all} onClick={() => setAll((a) => !a)}>
              {all ? "Show fewer" : `Show more (${rows.length - DUE_SHOWN})`}
            </Button>
          </div>
        )}
        {home?.truncated && <p className="border-t border-line px-3 py-2 text-meta text-muted">Some collections weren't checked because there is too much to look through. Open a collection to see its dates.</p>}
      </Card>
    </section>
  );
}
