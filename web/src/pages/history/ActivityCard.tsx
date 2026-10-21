/**
 * One record's run of activity in the History feed: the record and where it lives, then what
 * happened to it, each item with who did it and when (how long ago, and the exact time).
 */
import { useState } from "react";
import { Link } from "react-router";
import type { ActivityItem, ActivityPlace, Field } from "@/api/types";
import { CommentBody } from "@/components/record/CommentsPanel";
import { historyValueText } from "@/components/record/HistoryPanel";
import { Avatar } from "@/components/ui/avatar";
import type { FormatCtx } from "@/lib/cells/format";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { relativeTime } from "@/lib/relativeTime";
import type { ActivityGroup } from "./activity";

/** Changes shown before "Show more changes"; creating a record shows none until asked. */
const CHANGES_SHOWN = 3;
/** Characters of a value or comment shown before "Show more". */
const LONG_TEXT = 160;
const LONG_COMMENT = 280;

export interface ActivityCardProps {
  group: ActivityGroup;
  /** The fields the items' changes refer to, by id. */
  fields: Readonly<Record<string, Field>>;
  format: FormatCtx;
  now: number;
}

export function ActivityCard({ group, fields, format, now }: ActivityCardProps) {
  const { record, place } = group;
  const name = record.name.trim() || "Untitled record";
  return (
    <article aria-label={`Activity on ${name}`} className="overflow-hidden rounded-[14px] border border-line bg-surface">
      <header className="min-w-0 border-b border-[color-mix(in_srgb,var(--line)_60%,var(--surface))] px-4 py-3 sm:px-[18px]">
        {record.deleted ? (
          <p className="min-w-0 break-words text-[0.9375rem] font-semibold text-muted">
            <span className="line-through">{name}</span> <span className="text-[0.8125rem] font-normal">(deleted)</span>
          </p>
        ) : (
          <Link to={`/base/${encodeURIComponent(place.base_id)}/${encodeURIComponent(place.table_id)}?record=${encodeURIComponent(record.id)}`} className="block min-w-0 break-words text-[0.9375rem] font-semibold text-fg hover:underline">
            {name}
          </Link>
        )}
        <Place place={place} />
      </header>
      <ul aria-label={`Activity on ${name}`} className="flex flex-col">
        {group.items.map((item) => (
          <li key={item.id} className="flex gap-3 border-b border-[color-mix(in_srgb,var(--line)_60%,var(--surface))] px-4 py-3 last:border-b-0 sm:px-[18px]">
            <Avatar name={item.author?.name ?? "Someone"} size="sm" className="mt-0.5" />
            <ActivityRow item={item} fields={fields} format={format} now={now} />
          </li>
        ))}
      </ul>
    </article>
  );
}

/** "Record in Workspace › Project › Table", each with its tile like the Trash page. */
function Place({ place }: { place: ActivityPlace }) {
  return (
    <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.8125rem] text-muted">
      <span>Record in</span>
      <span className="truncate">{place.workspace_name}</span>
      <span aria-hidden>›</span>
      <span className="truncate">{place.base_name}</span>
      <span aria-hidden>›</span>
      <span className="truncate">{place.table_name}</span>
    </p>
  );
}

function ActivityRow({ item, fields, format, now }: { item: ActivityItem; fields: Readonly<Record<string, Field>>; format: FormatCtx; now: number }) {
  const who = <span className="font-semibold">{item.author?.name ?? "Someone"}</span>;
  const changes = Object.entries(item.changes);
  return (
    <div className="min-w-0 flex-1 text-[0.875rem]">
      {item.kind === "comment" ? (
        <>
          <p>{who} commented</p>
          <CommentText body={item.comment ?? ""} />
        </>
      ) : item.kind === "create" ? (
        <Created who={who} changes={changes} fields={fields} format={format} />
      ) : item.kind === "update" ? (
        <Updated who={who} changes={changes} fields={fields} format={format} />
      ) : (
        <p>
          {who} {item.kind === "delete" ? "deleted" : item.kind === "restore" ? "restored" : item.kind} the record
        </p>
      )}
      <When ms={item.created_at} timeZone={format.timeZone} now={now} />
    </div>
  );
}

type Changes = [string, { old?: unknown; new?: unknown }][];

function Updated({ who, changes, fields, format }: { who: React.ReactNode; changes: Changes; fields: Readonly<Record<string, Field>>; format: FormatCtx }) {
  const [all, setAll] = useState(false);
  if (changes.length === 0) return <p>{who} updated the record</p>;
  if (changes.length === 1) {
    const [fid, change] = changes[0]!;
    return (
      <p className="break-words">
        {who} <ChangeText fieldId={fid} change={change} fields={fields} format={format} />
      </p>
    );
  }
  const shown = all ? changes : changes.slice(0, CHANGES_SHOWN);
  return (
    <>
      <p>
        {who} made {changes.length} changes
      </p>
      <ul className="mt-1 flex flex-col gap-1">
        {shown.map(([fid, change]) => (
          <li key={fid} className="break-words">
            <ChangeText fieldId={fid} change={change} fields={fields} format={format} />
          </li>
        ))}
      </ul>
      {changes.length > CHANGES_SHOWN && <Toggle expanded={all} onClick={() => setAll(!all)} more={`Show ${changes.length - CHANGES_SHOWN} more ${changes.length - CHANGES_SHOWN === 1 ? "change" : "changes"}`} less="Show fewer changes" />}
    </>
  );
}

function Created({ who, changes, fields, format }: { who: React.ReactNode; changes: Changes; fields: Readonly<Record<string, Field>>; format: FormatCtx }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p>{who} created the record</p>
      {changes.length > 0 && (
        <>
          {open && (
            <ul className="mt-1 flex flex-col gap-1">
              {changes.map(([fid, change]) => (
                <li key={fid} className="break-words">
                  <ChangeText fieldId={fid} change={change} fields={fields} format={format} />
                </li>
              ))}
            </ul>
          )}
          <Toggle expanded={open} onClick={() => setOpen(!open)} more={`Show ${changes.length} ${changes.length === 1 ? "field" : "fields"}`} less="Hide fields" />
        </>
      )}
    </>
  );
}

/** "changed Status from Todo to Done", "set Due to Oct 20", "cleared Notes (was …)". */
function ChangeText({ fieldId, change, fields, format }: { fieldId: string; change: { old?: unknown; new?: unknown }; fields: Readonly<Record<string, Field>>; format: FormatCtx }) {
  const field = fields[fieldId];
  const name = <span className="font-medium">{field?.name ?? "(deleted field)"}</span>;
  const before = historyValueText(field, change.old, format);
  const after = historyValueText(field, change.new, format);
  if (!before && after) {
    return (
      <>
        set {name} to <Value text={after} tone="new" />
      </>
    );
  }
  if (before && !after) {
    return (
      <>
        cleared {name} (was <Value text={before} tone="old" />)
      </>
    );
  }
  return (
    <>
      changed {name} from <Value text={before} tone="old" /> to <Value text={after} tone="new" />
    </>
  );
}

/** A value in the old/new colours; a long one is cut until asked for. */
function Value({ text, tone }: { text: string; tone: "old" | "new" }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_TEXT;
  const shown = long && !open ? `${text.slice(0, LONG_TEXT).trimEnd()}…` : text;
  const Tag = tone === "old" ? "del" : "ins";
  return (
    <>
      <Tag className={cn("break-words rounded px-1.5 py-0.5 text-[0.8125rem] no-underline", tone === "old" ? "bg-danger-soft line-through decoration-danger/60" : "bg-success-soft")}>{text ? shown : "(empty)"}</Tag>
      {long && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="ml-1 text-xs font-medium text-primary-text hover:underline">
          {open ? "less" : "more"}
        </button>
      )}
    </>
  );
}

function CommentText({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  const long = body.length > LONG_COMMENT || body.split("\n").length > 5;
  return (
    <>
      <div className={cn("mt-1 rounded-[10px] bg-subtle px-3 py-2", long && !open && "max-h-28 overflow-hidden [mask-image:linear-gradient(to_bottom,#000_70%,transparent)]")}>
        <CommentBody body={body} />
      </div>
      {long && <Toggle expanded={open} onClick={() => setOpen(!open)} more="Show the whole comment" less="Show less" />}
    </>
  );
}

function Toggle({ expanded, onClick, more, less }: { expanded: boolean; onClick: () => void; more: string; less: string }) {
  return (
    <button type="button" aria-expanded={expanded} onClick={onClick} className="mt-1 text-xs font-medium text-primary-text hover:underline">
      {expanded ? less : more}
    </button>
  );
}

/** How long ago, and the exact time, both as text. */
function When({ ms, timeZone, now }: { ms: number; timeZone: string; now: number }) {
  const iso = new Date(ms).toISOString();
  return (
    <p className="mt-0.5 text-xs text-muted">
      <time dateTime={iso}>{relativeTime(ms, now)}</time>
      <span aria-hidden> · </span>
      <time dateTime={iso}>{formatDateTime(ms, timeZone)}</time>
    </p>
  );
}
