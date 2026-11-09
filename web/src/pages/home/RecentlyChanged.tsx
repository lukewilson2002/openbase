/**
 * Home's Recently changed list (HOME-7): the 10 records most recently created or edited in the workspace that the person can
 * see, each on a tile tinted with its collection's hue, with how long ago. "All activity" opens the history page.
 */
import { Link, useNavigate } from "react-router";
import type { HomeResponse } from "@/api/types";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FeedRow, FeedTile } from "@/components/ui/feed-row";
import { recordPath } from "@/lib/recordPath";
import { relativeTime } from "@/lib/relativeTime";
import { FeedLoading } from "./FeedLoading";

export function RecentlyChanged({ workspaceId, home }: { workspaceId: string; home: HomeResponse | undefined }) {
  const navigate = useNavigate();
  return (
    <section aria-labelledby="home-recent" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="home-recent" className="text-h3 max-md:text-sheet">
          Recently changed
        </h2>
        <Link to={`/history?workspace=${encodeURIComponent(workspaceId)}`} className="inline-flex min-h-6 items-center text-label font-medium text-primary-text hover:underline max-md:min-h-control-touch">
          All activity
        </Link>
      </div>
      <Card padded={false} aria-busy={!home}>
        {!home ? (
          <FeedLoading label="Loading recent changes" />
        ) : home.recent.length === 0 ? (
          <EmptyState title="Nothing has changed yet." className="py-6" />
        ) : (
          <ul className="divide-y divide-line">
            {home.recent.map((r) => (
              <li key={r.record_id}>
                <FeedRow
                  leading={<FeedTile hue={r.table_color} />}
                  title={r.title || "Untitled"}
                  meta={r.table_name}
                  metaHue={r.table_color}
                  metaMarkName={r.table_name}
                  trailing={relativeTime(r.at)}
                  href={recordPath(r.base_id, r.table_id, r.record_id)}
                  onOpen={() => navigate(recordPath(r.base_id, r.table_id, r.record_id))}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
